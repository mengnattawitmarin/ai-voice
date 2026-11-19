"""Render instrument note samples from FluidR3_GM (MIT licence) for the Cover/Live mode.
Output: samples/<inst>/<midi>.mp3 (every 3 semitones) + samples/drums/<name>.mp3 + samples/index.json"""
import json, os, struct, subprocess, sys
import numpy as np, wave

SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
OUT = sys.argv[1] if len(sys.argv) > 1 else "samples"
SR = 44100
INSTS = {  # name: (GM program 0-based, low, high, note seconds)
    "guitar": (25, 40, 88, 3.0),      # steel acoustic
    "nylon": (24, 40, 88, 3.0),
    "eguitar": (27, 40, 88, 1.6),     # clean electric
    "bass": (33, 28, 64, 2.2),        # fingered bass
    "upright": (32, 28, 64, 2.2),     # acoustic bass
    "piano": (0, 33, 96, 4.0),
    "epiano": (4, 36, 96, 3.0),
    "organ": (16, 36, 96, 1.6),       # drawbar
    "pad": (48, 36, 96, 3.0),         # strings
}
DRUMS = {"kick": 36, "snare": 38, "rim": 37, "hat": 42, "ohat": 46, "ride": 51, "crash": 49, "cowbell": 56, "guiro": 74,
         "shaker": 70, "clap": 39, "sticks": 31, "tomh": 50, "toml": 45, "brush": 40, "conga": 63, "congal": 64, "tamb": 54}


def vlq(n):
    b = [n & 0x7f]
    while n > 127:
        n >>= 7
        b.insert(0, (n & 0x7f) | 0x80)
    return bytes(b)


def smf(events, tpq=480):  # events: (tick, bytes) — tempo 120 → 1 tick = 1/960 s
    events.sort(key=lambda e: e[0])
    trk, last = b"", 0
    for t, data in events:
        trk += vlq(t - last) + data
        last = t
    trk += b"\x00\xff\x2f\x00"
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, tpq) + b"MTrk" + struct.pack(">I", len(trk)) + trk


def render(mid, wav):
    open("tmp.mid", "wb").write(mid)
    subprocess.run(["fluidsynth", "-ni", "-g", "0.8", "-r", str(SR), "-F", wav, SF2, "tmp.mid"], check=True, capture_output=True)
    w = wave.open(wav)
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, w.getnchannels()).astype(np.float32) / 32768
    return x.mean(axis=1)


def save(x, path):
    nz = np.nonzero(np.abs(x) > 1e-4)[0]
    if len(nz):
        x = x[:nz[-1] + 1]
    pk = np.abs(x).max() or 1
    x = x / pk * 0.89
    fade = min(len(x), 600)
    x[-fade:] *= np.linspace(1, 0, fade)
    tmp = path + ".wav"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-ac", "1", "-b:a", "80k", path], check=True)
    os.remove(tmp)
    return float(pk)


index = {"sr": SR, "inst": {}, "drums": {}, "licence": "FluidR3_GM soundfont by Frank Wen — MIT licence"}
TICK = 960  # ticks per second at 120 bpm / tpq 480
for name, (prog, lo, hi, sec) in INSTS.items():
    os.makedirs(f"{OUT}/{name}", exist_ok=True)
    notes = list(range(lo, hi + 1, 3))
    gap = sec + 1.0
    ev = [(0, bytes([0xC0, prog]))]
    for i, n in enumerate(notes):
        t = int((0.2 + i * gap) * TICK)
        ev += [(t, bytes([0x90, n, 100])), (t + int(sec * TICK), bytes([0x80, n, 0]))]
    x = render(smf(ev), "tmp.wav")
    gains = {}
    for i, n in enumerate(notes):
        a = int((0.2 + i * gap) * SR)
        gains[n] = save(x[a:a + int(gap * SR)].copy(), f"{OUT}/{name}/{n}.mp3")
    index["inst"][name] = {"notes": notes, "sec": sec}
    print(name, len(notes), flush=True)
os.makedirs(f"{OUT}/drums", exist_ok=True)
for name, n in DRUMS.items():
    for v, vel in (("1", 110), ("2", 70)):
        ev = [(0, bytes([0x99, n, vel])), (int(1.5 * TICK), bytes([0x89, n, 0]))]
        x = render(smf(ev), "tmp.wav")
        save(x[: int(2.2 * SR)].copy(), f"{OUT}/drums/{name}{v}.mp3")
    index["drums"][name] = 2
json.dump(index, open(f"{OUT}/index.json", "w"))
print("done")

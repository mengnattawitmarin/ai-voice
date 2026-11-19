"""Gen Medi for Mac — local AI server (no cloud APIs).

Serves the Gen Medi web app and a small JSON/HTTP API that runs everything on
this Mac's own CPU/GPU:
  POST /api/tts            Thai/English speech — KhanomTan TTS v1.1 (Apache-2.0)
  POST /api/convert_voice  re-voice audio with your own voice — OpenVoice V2 (MIT)
  POST /api/txt2img        text → image — FLUX.1-schnell 4-bit via MLX (Apache-2.0)
                           or Segmind-Vega + VegaRT (Apache-2.0) on smaller Macs
  POST /api/save           save a finished file into the folder chosen on the Mac
  POST /api/choose_folder  native folder picker
  POST /api/transcode      any video → MP4 (H.264/AAC)
  GET  /api/info, /api/models, /api/qr.svg
A free Cloudflare quick tunnel gives an https link so the phone app can drive
this Mac from anywhere; every remote call needs the pairing token.
"""
import io
import json
import os
import platform
import random
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

VERSION = "2.0.0"
PORT = int(os.environ.get("GENMEDI_PORT", "7861"))
DATA = Path(os.environ.get("GENMEDI_DATA", Path.home() / "Library" / "Application Support" / "GenMedi"))
WEB = Path(os.environ.get("GENMEDI_WEB", Path(__file__).resolve().parent.parent))
BIN = Path(os.environ.get("GENMEDI_BIN", Path(__file__).resolve().parent / "bin"))
APP_URL = os.environ.get("APP_URL", "https://mengnattawitmarin.github.io/ai-voice/")
DATA.mkdir(parents=True, exist_ok=True)
CFG_PATH = DATA / "config.json"
VOICES = DATA / "voices"
VOICES.mkdir(exist_ok=True)

KT_REPO = "wannaphong/khanomtan-tts-v1.1"         # Apache-2.0 (voices with unclear licences removed by the author)
FLUX_REPO = os.environ.get("FLUX_REPO", "dhairyashil/FLUX.1-schnell-mflux-v0.6.2-4bit")  # Apache-2.0 weights, pre-quantized
VEGA_REPO = "segmind/Segmind-Vega"


# ---------------- config ----------------
def load_cfg():
    try:
        return json.loads(CFG_PATH.read_text())
    except Exception:
        return {}


def save_cfg():
    CFG_PATH.write_text(json.dumps(CFG, ensure_ascii=False, indent=2))


CFG = load_cfg()
CFG.setdefault("token", secrets.token_urlsafe(18))
CFG.setdefault("save_dir", str(Path.home() / "Movies" / "Gen Medi"))
save_cfg()
Path(CFG["save_dir"]).mkdir(parents=True, exist_ok=True)


# ---------------- hardware ----------------
def sh(*cmd):
    try:
        return subprocess.check_output(list(cmd), text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


CHIP = sh("sysctl", "-n", "machdep.cpu.brand_string") or platform.processor() or platform.machine()
try:
    RAM_GB = round(int(sh("sysctl", "-n", "hw.memsize")) / 2**30)
except Exception:
    RAM_GB = None
CORES = os.cpu_count()


def gpu_cores():
    out = sh("system_profiler", "SPDisplaysDataType")
    m = re.search(r"Total Number of Cores:\s*(\d+)", out)
    return int(m.group(1)) if m else None


GPU_CORES = gpu_cores()
# image modes: which model + size + steps. Auto picks by RAM / GPU cores (base M1 8GB → fast; M1/M2 Max → quality)
IMG_MODES = {
    "fast":     {"engine": "vega", "base": 768,  "steps": 4, "name": "เร็ว — Segmind-Vega 768px (Mac ทุกรุ่น รวม M1 8GB)"},
    "balanced": {"engine": "flux", "base": 768,  "steps": 2, "name": "สมดุล — FLUX.1-schnell 4-bit 768px · 2 สเต็ป (RAM 16GB+)"},
    "quality":  {"engine": "flux", "base": 1024, "steps": 4, "name": "คมชัดสูง — FLUX.1-schnell 4-bit 1024px · 4 สเต็ป (M1/M2 Pro·Max)"},
}


def auto_mode():
    ram, g = RAM_GB or 8, GPU_CORES or 8
    if ram < 16:
        return "fast"
    if ram >= 24 and g >= 16:
        return "quality"
    return "balanced"
STATS = {}
LOCK = threading.Lock()   # one heavy job at a time (shared GPU memory)


def torch_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


# ---------------- model downloads (background, with progress) ----------------
MODELS = {
    "tts": {"name": "เสียงพากย์ KhanomTan", "repo": KT_REPO, "allow": ["best_model.pth", "config.json", "config_se.json", "language_ids.json", "model_se.pth", "speakers.pth"], "state": "idle", "pct": 0},
    "voice": {"name": "โคลนเสียง OpenVoice V2", "repo": "myshell-ai/OpenVoiceV2", "allow": ["converter/*"], "state": "idle", "pct": 0},
    "flux": {"name": "ภาพ FLUX.1-schnell (4-bit)", "repo": FLUX_REPO, "allow": None, "state": "idle", "pct": 0},
    "video": {"name": "วิดีโอ Wan2.1 T2V 1.3B", "repo": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers", "allow": None, "state": "idle", "pct": 0},
    "vega": {"name": "ภาพ Segmind-Vega (เร็ว)", "repo": VEGA_REPO, "allow": ["*.json", "*fp16*.safetensors", "tokenizer*/*", "*.txt"], "state": "idle", "pct": 0},
}


def img_mode():
    m = CFG.get("img_mode") or "auto"
    return auto_mode() if m == "auto" else m


def default_image_engine():
    return IMG_MODES[img_mode()]["engine"]


def _dir_size(p):
    t = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                t += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return t


def ensure_model(key):
    """Download a model repo (once) and return its local folder. Updates MODELS[key] progress."""
    from huggingface_hub import HfApi, snapshot_download
    import fnmatch
    m = MODELS[key]
    if m.get("path") and Path(m["path"]).exists():
        return m["path"]
    m["state"] = "downloading"
    total = 0
    try:
        info = HfApi().model_info(m["repo"], files_metadata=True)
        for s in info.siblings:
            if m["allow"] is None or any(fnmatch.fnmatch(s.rfilename, a) for a in m["allow"]):
                total += s.size or 0
    except Exception:
        pass
    m["total"] = total
    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub" / ("models--" + m["repo"].replace("/", "--"))
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            if total:
                m["pct"] = min(99, int(_dir_size(cache) * 100 / total))
            time.sleep(1)

    threading.Thread(target=watch, daemon=True).start()
    try:
        p = snapshot_download(m["repo"], allow_patterns=m["allow"])
        m.update(path=p, state="ready", pct=100)
        return p
    except Exception as e:
        m.update(state="error", error=str(e)[:300])
        raise
    finally:
        stop.set()


def prefetch(keys):
    def run():
        for k in keys:
            try:
                ensure_model(k)
            except Exception as e:
                print("prefetch", k, e, flush=True)
    threading.Thread(target=run, daemon=True).start()


# ---------------- TTS: KhanomTan v1.1 (Coqui YourTTS) ----------------
_kt = None
KT_SPEAKERS = {  # model speaker id → (Thai label, gender)
    "Linda": ("ลินดา (หญิง)", "f"), "Kerstin": ("เคอร์สติน (หญิง)", "f"),
    "Bernard": ("แบร์นาร์ด (ชาย)", "m"), "Thorsten": ("ทอร์สเทน (ชาย)", "m"),
}


def get_kt():
    global _kt
    if _kt is None:
        d = Path(ensure_model("tts"))
        raw = (d / "config.json").read_text()
        try:
            cfg = json.loads(raw)
        except json.JSONDecodeError:
            cfg = json.loads(re.sub(r",\s*([}\]])", r"\1", raw))

        def fix(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if isinstance(v, str) and v.endswith((".pth", ".json")):
                        o[k] = str(d / Path(v).name)
                    else:
                        fix(v)
            elif isinstance(o, list):
                for v in o:
                    fix(v)
        fix(cfg)
        fixed = DATA / "khanomtan-config.json"
        fixed.write_text(json.dumps(cfg))
        from TTS.utils.synthesizer import Synthesizer
        _kt = Synthesizer(tts_checkpoint=str(d / "best_model.pth"), tts_config_path=str(fixed), use_cuda=False)
    return _kt


def kt_speakers():
    try:
        names = get_kt().tts_model.speaker_manager.speaker_names
    except Exception:
        names = list(KT_SPEAKERS)
    return [{"id": n, "name": KT_SPEAKERS.get(n, (n, None))[0], "gender": KT_SPEAKERS.get(n, (n, None))[1]} for n in names]


def wav_bytes(wav, sr):
    import numpy as np
    import soundfile as sf
    b = io.BytesIO()
    sf.write(b, np.asarray(wav, dtype="float32"), sr, format="WAV", subtype="PCM_16")
    return b.getvalue()


# ---------------- OpenVoice V2 ----------------
_ov = None
_se_cache = {}


def get_ov():
    global _ov
    if _ov is None:
        import librosa.filters as _lf
        _mel = _lf.mel
        if not getattr(_lf, "_ov_patched", False):
            _lf.mel = lambda *a, **k: _mel(**dict(zip(["sr", "n_fft", "n_mels", "fmin", "fmax"], a)), **k)
            _lf._ov_patched = True
        from openvoice.api import ToneColorConverter
        d = Path(ensure_model("voice"))
        _ov = ToneColorConverter(str(d / "converter" / "config.json"), device="cpu", enable_watermark=False)
        _ov.load_ckpt(str(d / "converter" / "checkpoint.pth"))
    return _ov


def _se(path):
    import hashlib
    h = hashlib.sha1(open(path, "rb").read()).hexdigest()
    if h not in _se_cache:
        _se_cache[h] = get_ov().extract_se([path])
    return _se_cache[h]


def to_wav_file(data: bytes, sr=22050):
    import librosa
    import soundfile as sf
    src = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
    src.write(data)
    src.close()
    try:
        y, _ = librosa.load(src.name, sr=sr, mono=True)
    except Exception:
        y = None
    if y is None:  # formats librosa can't read (webm/opus) → ffmpeg
        out = src.name + ".wav"
        subprocess.run([ffmpeg_bin(), "-y", "-i", src.name, "-ac", "1", "-ar", str(sr), out], capture_output=True)
        y, _ = librosa.load(out, sr=sr, mono=True)
    path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    sf.write(path, y, sr)
    return path


# ---------------- images ----------------
_flux = None
_vega = None


def get_flux():
    global _flux
    if _flux is None:
        path = ensure_model("flux")
        from mflux import Flux1, ModelConfig   # mflux 0.6.2 API (verified in CI)
        try:
            mc = ModelConfig.from_name("schnell")
        except Exception:
            mc = ModelConfig.schnell()
        _flux = Flux1(model_config=mc, quantize=None, local_path=path)
    return _flux


def get_vega():
    global _vega
    if _vega is None:
        import torch
        from diffusers import AutoencoderKL, LCMScheduler, StableDiffusionXLPipeline
        dev = torch_device()
        dtype = torch.float16 if dev != "cpu" else torch.float32
        ensure_model("vega")
        vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=dtype)
        try:
            pipe = StableDiffusionXLPipeline.from_pretrained(VEGA_REPO, vae=vae, variant="fp16", torch_dtype=dtype)
        except Exception:
            pipe = StableDiffusionXLPipeline.from_pretrained(VEGA_REPO, vae=vae, torch_dtype=dtype)
        pipe.load_lora_weights("segmind/Segmind-VegaRT")
        pipe.fuse_lora()
        pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
        pipe = pipe.to(dev)
        pipe.set_progress_bar_config(disable=True)
        if dev == "mps":
            pipe.enable_attention_slicing()
        _vega = pipe
    return _vega


def fit_size(w, h, base):
    w, h = float(w or base), float(h or base)
    s = (base * base / (w * h)) ** 0.5
    return max(256, int(w * s) // 64 * 64), max(256, int(h * s) // 64 * 64)


def gen_image(prompt, w, h, seed, engine, steps=None, mode=None):
    seed = int(seed) if seed not in (None, "", 0) else random.randint(1, 2**31 - 2)
    md = IMG_MODES.get(mode or img_mode(), IMG_MODES["fast"])
    if engine == "flux":
        from mflux import Config
        W, H = fit_size(w, h, md["base"] if md["engine"] == "flux" else 768)
        img = get_flux().generate_image(seed=seed, prompt=prompt, config=Config(num_inference_steps=int(steps or md["steps"]), height=H, width=W))
        pil = getattr(img, "image", img)
    else:
        import torch
        W, H = fit_size(w, h, 1024 if (RAM_GB or 8) >= 16 else 768)
        g = torch.Generator("cpu").manual_seed(seed)
        pil = get_vega()(prompt=prompt, num_inference_steps=4, guidance_scale=0.0, width=W, height=H, generator=g).images[0]
    b = io.BytesIO()
    pil.save(b, format="PNG")
    return b.getvalue(), seed


# ---------------- text → video: Wan2.1 T2V 1.3B (Apache-2.0) on the Mac GPU ----------------
_wan = None
VIDEO_MODES = {   # Wan needs 4k+1 frames
    "draft":    {"w": 480, "h": 272, "steps": 15, "fps": 16, "name": "ร่างเร็ว 480×272"},
    "standard": {"w": 832, "h": 480, "steps": 25, "fps": 16, "name": "มาตรฐาน 480p (832×480)"},
    # Wan2.2 TI2V-5B (Apache-2.0) through MLX (mlx-gen) — native 720p but very memory hungry
    "hd720":    {"w": 1280, "h": 704, "steps": 20, "fps": 24, "engine": "mlxgen", "name": "HD 720p ทดลอง (Wan2.2 5B · MLX)",
                 "max_frames": {32: 17, 48: 33, 64: 41}},
}
MLXGEN_MODEL = "AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit"
VENV_VIDEO = DATA / "venv-video"   # separate env so mlx-gen's MLX version can't clash with mflux
JOBS = {}


def get_wan():
    global _wan
    if _wan is None:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline
        path = ensure_model("video")
        dev = torch_device()
        vae = AutoencoderKLWan.from_pretrained(path, subfolder="vae", torch_dtype=torch.float32)
        pipe = WanPipeline.from_pretrained(path, vae=vae, torch_dtype=torch.bfloat16 if dev != "cpu" else torch.float32)
        if (RAM_GB or 16) < 24:
            try:
                pipe.enable_model_cpu_offload(device=dev)
            except Exception:
                pipe = pipe.to(dev)
        else:
            pipe = pipe.to(dev)
        pipe.set_progress_bar_config(disable=True)
        _wan = pipe
    return _wan


def ensure_mlxgen(j):
    exe = VENV_VIDEO / "bin" / "mlxgen"
    if exe.exists():
        return exe
    j.update(state="loading", msg="ติดตั้งตัวสร้างวิดีโอ HD (mlx-gen) ครั้งแรก…")
    import venv as _venv
    _venv.EnvBuilder(with_pip=True).create(str(VENV_VIDEO))
    r = subprocess.run([str(VENV_VIDEO / "bin" / "python"), "-m", "pip", "install", "-q", "-U", "mlx-gen"], capture_output=True, text=True)
    if r.returncode != 0 or not exe.exists():
        raise RuntimeError("ติดตั้ง mlx-gen ไม่สำเร็จ: " + (r.stderr or r.stdout)[-300:])
    return exe


def run_mlxgen(j, prompt, w, h, frames, steps, fps, seed, out):
    exe = ensure_mlxgen(j)
    j.update(state="loading", msg="กำลังโหลดโมเดล Wan2.2 5B (ครั้งแรกดาวน์โหลด ~17GB)…", total=steps, t0=time.time())
    cmd = [str(exe), "generate", "--model", MLXGEN_MODEL, "--prompt", prompt,
           "--negative-prompt", "blurry, low quality, distorted, watermark, text, static, deformed",
           "--width", str(w), "--height", str(h), "--frames", str(frames), "--steps", str(steps),
           "--guidance", "5", "--fps", str(fps), "--seed", str(seed), "--output", out]
    env = dict(os.environ)
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, bufsize=1)
    tail = []
    for line in p.stdout:
        tail = (tail + [line.strip()])[-15:]
        m = re.search(r"(\d+)\s*/\s*(\d+)", line)
        if m and int(m.group(2)) == steps:
            i = int(m.group(1))
            if j["state"] != "running":
                j.update(state="running", msg="กำลังสร้างวิดีโอ HD บน GPU…", t0=time.time())
            j["step"] = i
            el = time.time() - j["t0"]
            j["eta"] = round(el / max(1, i) * (steps - i) + 40)
        if j.get("cancel"):
            p.kill()
            raise RuntimeError("ยกเลิกแล้ว")
    rc = p.wait()
    if rc != 0 or not Path(out).exists():
        killed = rc in (-9, 137) or any("memory" in t.lower() for t in tail)
        raise RuntimeError(("RAM ไม่พอสำหรับ 720p — ลดความยาว หรือใช้ 480p + อัปสเกล 1080p" if killed else "mlx-gen ผิดพลาด") + " · " + " | ".join(tail[-4:])[-300:])


def upscale(src, dst, portrait, target):
    """Upscale to 1080p/720p with Lanczos + light sharpening, frame-interpolate to 30 fps for smooth motion."""
    W, H = {"1080": (1920, 1080), "720": (1280, 720)}[target]
    if portrait:
        W, H = H, W
    vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H},"
          "unsharp=5:5:0.6:5:5:0.0,minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:vsbmc=1")
    r = subprocess.run([ffmpeg_bin(), "-y", "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "17",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("อัปสเกลไม่สำเร็จ: " + r.stderr[-200:])


def run_video_job(jid, prompt, mode, seconds, portrait, seed, up=None):
    import torch
    from diffusers.utils import export_to_video
    j = JOBS[jid]
    md = VIDEO_MODES.get(mode, VIDEO_MODES["standard"])
    w, h = (md["h"], md["w"]) if portrait else (md["w"], md["h"])
    frames = int(max(1, round(seconds * md["fps"] / 4)) * 4 + 1)
    if md.get("max_frames"):
        cap = max(v for k, v in md["max_frames"].items() if (RAM_GB or 32) >= k) if (RAM_GB or 32) >= 32 else 9
        if frames > cap:
            frames = cap
            j["note"] = f"RAM {RAM_GB}GB สร้าง 720p ได้สูงสุด {cap} เฟรม (~{cap / md['fps']:.1f} วิ)"
    j.update(state="loading", msg="กำลังโหลดโมเดลวิดีโอ (ครั้งแรกนานหน่อย)…", total=md["steps"], frames=frames)
    raw = str(DATA / f"video-{jid}-raw.mp4")
    final = str(DATA / f"video-{jid}.mp4")
    try:
        with LOCK:
            if md.get("engine") == "mlxgen":
                run_mlxgen(j, prompt, w, h, frames, md["steps"], md["fps"], seed, raw)
            else:
                import torch
                from diffusers.utils import export_to_video
                pipe = get_wan()
                j.update(state="running", msg="กำลังสร้างวิดีโอบน GPU…", t0=time.time())

                def cb(p, i, t, kw):
                    j["step"] = i + 1
                    el = time.time() - j["t0"]
                    j["eta"] = round(el / (i + 1) * (md["steps"] - i - 1) + 20)
                    if j.get("cancel"):
                        raise RuntimeError("ยกเลิกแล้ว")
                    return kw

                g = torch.Generator("cpu").manual_seed(int(seed))
                out = pipe(prompt=prompt,
                           negative_prompt="blurry, low quality, distorted, watermark, text, static, worst quality, deformed",
                           height=h, width=w, num_frames=frames, guidance_scale=5.0, num_inference_steps=md["steps"],
                           generator=g, callback_on_step_end=cb).frames[0]
                j.update(msg="กำลังเข้ารหัส MP4…")
                export_to_video(out, raw, fps=md["fps"])
            if up in ("1080", "720"):
                j.update(msg=f"กำลังอัปสเกลเป็น {up}p + ทำภาพลื่นขึ้น (30fps)…")
                upscale(raw, final, portrait, up)
            else:
                r = subprocess.run([ffmpeg_bin(), "-y", "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", final], capture_output=True)
                if r.returncode != 0:
                    final = raw
        ms = round((time.time() - j["t0"]) * 1000)
        STATS[f"video_ms_{mode}_{frames}"] = ms
        STATS[f"video_ms_per_step_{mode}"] = round(ms / md["steps"])
        j.update(state="done", path=final, msg="เสร็จแล้ว", ms=ms, seed=seed)
    except Exception as e:  # noqa
        j.update(state="error", msg=str(e)[:400])


# ---------------- files ----------------
def ffmpeg_bin():
    for c in (BIN / "ffmpeg", shutil.which("ffmpeg")):
        if c and Path(c).exists():
            return str(c)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise HTTPException(500, "ffmpeg not available")


ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".m4a", ".ogg", ".mp4", ".webm", ".srt", ".mid", ".txt", ".zip"}


def safe_name(name, ext):
    name = re.sub(r"[\\/:*?\"<>|\n\r\t]+", " ", name or "").strip()[:60] or "genmedi"
    return f"{datetime.now().strftime('%H%M%S')} {name}{ext}"


def pick_folder_dialog():
    script = 'POSIX path of (choose folder with prompt "เลือกโฟลเดอร์เก็บงานของ Gen Medi")'
    try:
        subprocess.run(["osascript", "-e", 'tell application "System Events" to activate'], timeout=5)
        out = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
        return out.stdout.strip().rstrip("/") or None
    except Exception:
        return None


# ---------------- tunnel (free https link for the phone) ----------------
TUNNEL = {"url": None, "state": "off", "proc": None}


def start_tunnel():
    exe = BIN / "cloudflared"
    if not exe.exists():
        exe = shutil.which("cloudflared")
    if not exe:
        TUNNEL["state"] = "missing"
        return
    TUNNEL["state"] = "starting"

    def run():
        while True:
            p = subprocess.Popen([str(exe), "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            TUNNEL["proc"] = p
            for line in p.stdout:
                m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if m and TUNNEL["url"] != m.group(0):
                    TUNNEL.update(url=m.group(0), state="on")
                    print("tunnel:", TUNNEL["url"], flush=True)
            TUNNEL.update(url=None, state="restarting")
            time.sleep(5)

    threading.Thread(target=run, daemon=True).start()


def pair_link():
    if not TUNNEL["url"]:
        return None
    return f"{APP_URL}?server={TUNNEL['url']}&t={CFG['token']}"


# ---------------- app ----------------
app = FastAPI(title="Gen Medi", version=VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Seed", "X-Ms"])


def local_request(req: Request):
    host = (req.headers.get("host") or "").split(":")[0]
    return host in ("localhost", "127.0.0.1") and (req.client and req.client.host in ("127.0.0.1", "::1"))


@app.middleware("http")
async def auth(req: Request, call_next):
    p = req.url.path
    if p.startswith("/api/") and p not in ("/api/ping",) and req.method != "OPTIONS" and not local_request(req):
        tok = req.headers.get("x-gm-token") or req.query_params.get("t")
        if not tok or not secrets.compare_digest(tok, CFG["token"]):
            return JSONResponse({"error": "ต้องจับคู่เครื่องก่อน — สแกน QR บนหน้าจอ Mac"}, status_code=401)
    return await call_next(req)


def busy(fn, *a, **k):
    if not LOCK.acquire(timeout=600):
        raise HTTPException(503, "เครื่องกำลังทำงานอื่นอยู่ ลองใหม่อีกครั้ง")
    try:
        return fn(*a, **k)
    finally:
        LOCK.release()


def model_guard(key):
    m = MODELS[key]
    if m["state"] != "ready":
        if m["state"] in ("idle", "error"):
            prefetch([key])
        if m["state"] != "ready":
            raise HTTPException(503, f"กำลังดาวน์โหลดโมเดล {m['name']} ({m['pct']}%) — ลองใหม่อีกสักครู่")


@app.get("/api/ping")
def ping():
    return {"ok": True, "app": "genmedi", "version": VERSION}


@app.get("/api/info")
def info(req: Request):
    return {
        "app": "genmedi", "version": VERSION, "chip": CHIP, "ram_gb": RAM_GB, "cores": CORES, "os": platform.platform(),
        "save_dir": CFG["save_dir"], "img_engine": default_image_engine(), "gpu_cores": GPU_CORES,
        "img_mode": img_mode(), "img_mode_set": CFG.get("img_mode") or "auto", "img_auto": auto_mode(),
        "img_modes": {k: v["name"] for k, v in IMG_MODES.items()},
        "models": {k: {kk: v.get(kk) for kk in ("name", "state", "pct", "error")} for k, v in MODELS.items()},
        "tunnel": TUNNEL["url"], "tunnel_state": TUNNEL["state"], "local": local_request(req),
        "pair": pair_link() if local_request(req) else None,
        "speakers": kt_speakers() if MODELS["tts"]["state"] == "ready" else [{"id": k, "name": v[0], "gender": v[1]} for k, v in KT_SPEAKERS.items()],
        "voices": [p.stem for p in VOICES.glob("*.wav")], "video_modes": {k: v["name"] for k, v in VIDEO_MODES.items()},
        "video_ok": (RAM_GB or 16) >= 16, **STATS,
    }


@app.post("/api/models/download")
def models_download(keys: str = Form("tts,voice,flux")):
    prefetch([k for k in keys.split(",") if k in MODELS])
    return {"ok": True}


@app.get("/api/qr.svg")
def qr(req: Request):
    if not local_request(req):
        raise HTTPException(403)
    link = pair_link()
    if not link:
        return Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', media_type="image/svg+xml")
    import qrcode
    import qrcode.image.svg
    img = qrcode.make(link, image_factory=qrcode.image.svg.SvgPathFillImage, box_size=10, border=2)
    b = io.BytesIO()
    img.save(b)
    return Response(b.getvalue(), media_type="image/svg+xml")


@app.post("/api/token/reset")
def token_reset(req: Request):
    if not local_request(req):
        raise HTTPException(403)
    CFG["token"] = secrets.token_urlsafe(18)
    save_cfg()
    return {"ok": True}


@app.post("/api/tts")
async def tts(req: Request):
    j = await req.json()
    text = (j.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "missing text")
    model_guard("tts")
    speaker = j.get("speaker") or "Linda"
    lang = j.get("lang") or "th-th"

    def run():
        t0 = time.time()
        s = get_kt()
        names = s.tts_model.speaker_manager.speaker_names
        sp = speaker if speaker in names else names[0]
        wav = s.tts(text, speaker_name=sp, language_name=lang)
        sr = s.output_sample_rate
        STATS["tts_ms_per_char"] = round((time.time() - t0) * 1000 / max(1, len(text)), 1)
        return wav_bytes(wav, sr)
    data = await run_in_threadpool(busy, run)
    voice = j.get("voice")  # optional: convert to a saved voice of the user (OpenVoice)
    if voice and (VOICES / f"{voice}.wav").exists():
        model_guard("voice")
        data = await run_in_threadpool(busy, convert_bytes, data, str(VOICES / f"{voice}.wav"), float(j.get("tau") or 0.3))
    return Response(data, media_type="audio/wav")


def convert_bytes(src_bytes, ref_path, tau=0.3):
    t0 = time.time()
    src = to_wav_file(src_bytes)
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    get_ov().convert(audio_src_path=src, src_se=_se(src), tgt_se=_se(ref_path), output_path=out, tau=tau)
    STATS["ov_ms"] = round((time.time() - t0) * 1000)
    return Path(out).read_bytes()


@app.post("/api/voices")
async def add_voice(audio: UploadFile = File(...), name: str = Form("my-voice")):
    vid = re.sub(r"[^a-zA-Z0-9ก-๙_-]+", "-", name)[:40] or "voice"
    path = to_wav_file(await audio.read())
    shutil.move(path, VOICES / f"{vid}.wav")
    return {"id": vid}


@app.delete("/api/voices/{vid}")
def del_voice(vid: str):
    p = VOICES / f"{Path(vid).name}.wav"
    if p.exists():
        p.unlink()
    return {"ok": True}


@app.post("/api/convert_voice")
async def convert_voice(source: UploadFile = File(...), ref: UploadFile = File(None), voice: str = Form(""), tau: float = Form(0.3)):
    model_guard("voice")
    if voice and (VOICES / f"{Path(voice).name}.wav").exists():
        ref_path = str(VOICES / f"{Path(voice).name}.wav")
    elif ref is not None:
        ref_path = to_wav_file(await ref.read())
    else:
        raise HTTPException(400, "missing reference voice")
    src_b = await source.read()
    data = await run_in_threadpool(busy, convert_bytes, src_b, ref_path, tau)
    return Response(data, media_type="audio/wav")


@app.post("/api/txt2img")
async def txt2img(req: Request):
    j = await req.json()
    prompt = (j.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "missing prompt")
    mode = j.get("mode") if j.get("mode") in IMG_MODES else img_mode()
    engine = IMG_MODES[mode]["engine"]
    if (RAM_GB or 8) < 14 and engine == "flux":   # FLUX 4-bit needs ~10GB — keep 8GB Macs safe
        mode, engine = "fast", "vega"
    model_guard(engine)
    t0 = time.time()
    png, seed = await run_in_threadpool(busy, gen_image, prompt, j.get("width"), j.get("height"), j.get("seed"), engine, j.get("steps"), mode)
    ms = round((time.time() - t0) * 1000)
    STATS[f"img_ms_{mode}"] = ms
    return Response(png, media_type="image/png", headers={"X-Seed": str(seed), "X-Ms": str(ms)})


@app.post("/api/save")
async def save(file: UploadFile = File(...), kind: str = Form("images"), name: str = Form("")):
    ext = Path(file.filename or "").suffix.lower() or ".bin"
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "file type not allowed")
    sub = kind if kind in ("audio", "videos", "images", "music") else "images"
    day = Path(CFG["save_dir"]) / sub / datetime.now().strftime("%Y-%m-%d")
    day.mkdir(parents=True, exist_ok=True)
    dest = day / safe_name(name, ext)
    with open(dest, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return {"path": str(dest)}


@app.post("/api/choose_folder")
def choose_folder():
    p = pick_folder_dialog()
    if p:
        CFG["save_dir"] = p
        save_cfg()
    return {"path": CFG["save_dir"]}


@app.post("/api/open_folder")
def open_folder(req: Request):
    if local_request(req):
        subprocess.Popen(["open", CFG["save_dir"]])
    return {"ok": True}


@app.post("/api/settings")
async def settings(req: Request):
    j = await req.json()
    if j.get("img_mode") in ("auto", *IMG_MODES):
        CFG["img_mode"] = j["img_mode"]
        save_cfg()
        prefetch([default_image_engine()])
    return {"ok": True, "img_mode": img_mode(), "img_engine": default_image_engine()}


@app.post("/api/transcode")
async def transcode(file: UploadFile = File(...)):
    src = tempfile.NamedTemporaryFile(suffix=Path(file.filename or "v.webm").suffix or ".webm", delete=False)
    src.write(await file.read())
    src.close()
    out = src.name + ".mp4"
    cmd = [ffmpeg_bin(), "-y", "-i", src.name, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]
    r = await run_in_threadpool(busy, subprocess.run, cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(500, "ffmpeg: " + r.stderr[-300:])
    return FileResponse(out, media_type="video/mp4", filename="genmedi.mp4")


@app.post("/api/txt2video")
async def txt2video(req: Request):
    j = await req.json()
    prompt = (j.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "missing prompt")
    if (RAM_GB or 16) < 16:
        raise HTTPException(400, "วิดีโอต้องใช้ Mac ที่มี RAM 16GB ขึ้นไป")
    if any(x["state"] in ("queued", "loading", "running") for x in JOBS.values()):
        raise HTTPException(409, "กำลังสร้างวิดีโออื่นอยู่ — รอให้เสร็จก่อน")
    if MODELS["video"]["state"] != "ready":
        model_guard("video")
    jid = secrets.token_hex(4)
    seed = j.get("seed") or random.randint(1, 2**31 - 2)
    JOBS[jid] = {"id": jid, "state": "queued", "step": 0, "total": 0, "eta": None, "msg": "รอคิว", "prompt": prompt, "created": time.time()}
    threading.Thread(target=run_video_job, args=(jid, prompt, j.get("mode") or "standard", float(j.get("seconds") or 3), bool(j.get("portrait")), seed, j.get("upscale")), daemon=True).start()
    return {"job": jid}


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "ไม่พบงานนี้ (Mac อาจเพิ่งรีสตาร์ท)")
    return {k: v for k, v in j.items() if k not in ("path", "t0")}


@app.post("/api/jobs/{jid}/cancel")
def job_cancel(jid: str):
    if jid in JOBS:
        JOBS[jid]["cancel"] = True
    return {"ok": True}


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str):
    j = JOBS.get(jid)
    if not j or j.get("state") != "done":
        raise HTTPException(404, "ยังไม่เสร็จ")
    return FileResponse(j["path"], media_type="video/mp4", filename="genmedi-video.mp4")


# web app (same files as the GitHub Pages site)
if WEB.exists():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")


if __name__ == "__main__":
    import uvicorn
    print(f"Gen Medi {VERSION} · {CHIP} · RAM {RAM_GB} GB · web {WEB}", flush=True)
    start_tunnel()
    prefetch(["tts", "voice", default_image_engine()])
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

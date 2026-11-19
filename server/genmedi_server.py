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
import asyncio
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
def _find_web():
    """Folder with the web app (index.html): env var, then the checkout this file lives in, then the app bundle."""
    here = Path(__file__).resolve().parent
    for c in (os.environ.get("GENMEDI_WEB"), here.parent, here.parent / "web", Path.home() / "GenMedi" / "app"):
        if c and (Path(c) / "index.html").exists():
            return Path(c)
    return Path(os.environ.get("GENMEDI_WEB") or here.parent)


WEB = _find_web()
BIN = Path(os.environ.get("GENMEDI_BIN", Path(__file__).resolve().parent / "bin"))
APP_URL = os.environ.get("APP_URL", "https://mengnattawitmarin.github.io/ai-voice/")
DATA.mkdir(parents=True, exist_ok=True)
CFG_PATH = DATA / "config.json"
VOICES = DATA / "voices"
VOICES.mkdir(exist_ok=True)

KT_REPO = "wannaphong/khanomtan-tts-v1.1"         # Apache-2.0 (voices with unclear licences removed by the author)
FLUX_REPO = os.environ.get("FLUX_REPO", "dhairyashil/FLUX.1-schnell-mflux-v0.6.2-4bit")  # Apache-2.0 weights, pre-quantized
VEGA_REPO = "segmind/Segmind-Vega"
ZIMAGE_REPO = os.environ.get("ZIMAGE_REPO", "filipstrand/Z-Image-Turbo-mflux-4bit")   # Apache-2.0 (Tongyi-MAI/Z-Image-Turbo), by the mflux author
KLEIN_REPO = os.environ.get("KLEIN_REPO", "Runpod/FLUX.2-klein-4B-mflux-4bit")         # Apache-2.0 (black-forest-labs/FLUX.2-klein-4B) — 4B only; 9B is non-commercial


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
    # Z-Image-Turbo (Tongyi-MAI, Apache-2.0) via the latest mflux in its own venv — main engine since v2
    "fast":     {"engine": "zimage", "base": 768,  "steps": 8, "name": "เร็ว — Z-Image Turbo 768px"},
    "quality":  {"engine": "zimage", "base": 1024, "steps": 9, "name": "คมชัดสูง — Z-Image Turbo 1024px"},
    # backups
    "balanced": {"engine": "flux", "base": 1024, "steps": 4, "name": "สำรอง — FLUX.1-schnell 1024px"},
    "lite":     {"engine": "vega", "base": 768,  "steps": 4, "name": "ประหยัด — Segmind-Vega 768px (M1 8GB)"},
}


def auto_mode():
    ram = RAM_GB or 8
    if ram < 12:
        return "lite"
    return "quality" if ram >= 24 else "fast"
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
    "zimage": {"name": "ภาพ Z-Image Turbo (4-bit)", "repo": ZIMAGE_REPO, "allow": None, "state": "idle", "pct": 0},
    "klein": {"name": "แก้ภาพ FLUX.2 Klein 4B (4-bit)", "repo": KLEIN_REPO, "allow": None, "state": "idle", "pct": 0},
    "vega": {"name": "ภาพ Segmind-Vega (ประหยัด)", "repo": VEGA_REPO, "allow": ["*.json", "*fp16*.safetensors", "tokenizer*/*", "*.txt"], "state": "idle", "pct": 0},
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
    if key in ("zimage", "klein"):   # install the new image engine while the weights download
        threading.Thread(target=lambda: _safe(ensure_tool, "img"), daemon=True).start()
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
    # newer huggingface_hub downloads through hf_xet, which fills its own chunk cache before the file appears → count that growth too
    xet = cache.parent.parent / "xet"
    xet0 = _dir_size(xet)

    def watch():
        while not stop.is_set():
            size = _dir_size(cache) + max(0, _dir_size(xet) - xet0)
            m["mb"] = int(size / 1e6)
            if total:
                m["pct"] = min(99, int(size * 100 / total))
            time.sleep(2)

    threading.Thread(target=watch, daemon=True).start()
    try:
        p = snapshot_download(m["repo"], allow_patterns=m["allow"])
        m.update(path=p, state="ready", pct=100)
        return p
    except Exception as e:
        m.update(state="error", error=(type(e).__name__ + ": " + str(e))[:300])
        print(f"[download] {key} failed:", repr(e), flush=True)
        raise
    finally:
        stop.set()


def _safe(fn, *a):
    try:
        fn(*a)
    except Exception as e:  # noqa
        print("[bg]", getattr(fn, "__name__", fn), e, flush=True)


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


def mflux_cli(cmd, args, timeout=1800):
    """Run a command of the latest mflux (own venv, so it can't clash with the old mflux used for FLUX.1)."""
    py = ensure_tool("img")
    exe = py.parent / cmd
    if (RAM_GB or 16) < 16:
        args = [*args, "--low-ram"]
    env = dict(os.environ, HF_HOME=os.environ.get("HF_HOME", str(DATA / "hf")))
    r = subprocess.run([str(exe), *args], capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "")[-500:]
        print(f"[mflux] {cmd} failed:\n{tail}", flush=True)
        raise RuntimeError(("RAM ไม่พอ — " if r.returncode in (-9, 137) else "") + "สร้างภาพไม่สำเร็จ: " + tail[-300:])


def gen_zimage(prompt, W, H, seed, steps):
    path = ensure_model("zimage")
    out = Path(tempfile.mkdtemp(prefix="gm-img-")) / "out.png"
    mflux_cli("mflux-generate-z-image-turbo", ["--model", path, "--base-model", "z-image-turbo", "--prompt", prompt,
              "--width", str(W), "--height", str(H), "--seed", str(seed), "--steps", str(steps), "--output", str(out)])
    from PIL import Image
    return Image.open(out)


def edit_image(src_path, prompt, seed=None, steps=4):
    """FLUX.2 Klein 4B: change an existing picture with an instruction (keeps the picture's aspect)."""
    from PIL import Image
    seed = int(seed) if seed not in (None, "", 0) else random.randint(1, 2**31 - 2)
    with Image.open(src_path) as im:
        w, h = im.size
    base = 1024 if (RAM_GB or 16) >= 16 else 768
    W, H = fit_size(w, h, base)
    path = ensure_model("klein")
    out = Path(tempfile.mkdtemp(prefix="gm-edit-")) / "out.png"
    mflux_cli("mflux-generate-flux2-edit", ["--model", path, "--base-model", "flux2-klein-4b", "--image-paths", str(src_path),
              "--prompt", prompt, "--width", str(W), "--height", str(H), "--seed", str(seed), "--steps", str(steps), "--output", str(out)])
    return out.read_bytes(), seed


def gen_image(prompt, w, h, seed, engine, steps=None, mode=None):
    seed = int(seed) if seed not in (None, "", 0) else random.randint(1, 2**31 - 2)
    md = IMG_MODES.get(mode or img_mode(), IMG_MODES["fast"])
    if engine == "zimage":
        W, H = fit_size(w, h, md["base"] if md["engine"] == "zimage" else 1024)
        pil = gen_zimage(prompt, W, H, seed, int(steps or md.get("steps") or 9))
    elif engine == "flux":
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
VENV_IMG = DATA / "venv-img"       # latest mflux (Z-Image, FLUX.2 Klein) — kept apart from the pinned mflux 0.6.2 of FLUX.1
VENV_TOOLS = DATA / "venv-tools"   # separate env for MLX tools so their MLX version can't clash with mflux
TOOL_PKGS = {"img": ["mflux>=0.24,<0.30"], "mlxgen": ["mlx-gen"], "llm": ["mlx-lm"], "whisper": ["mlx-whisper"], "rmbg": ["rembg[cpu]", "pillow"]}
TOOL_NAMES = {"img": "ตัวสร้างภาพรุ่นใหม่ (mflux)", "mlxgen": "ตัวสร้างวิดีโอ HD", "llm": "ผู้ช่วยเขียนบท", "whisper": "ตัวถอดเสียง", "rmbg": "ตัวลบพื้นหลัง"}
JOBS = {}
QUEUE = []
QCOND = threading.Condition()


TOOL_LOCK = threading.Lock()


def ensure_tool(tool, j=None):
    with TOOL_LOCK:   # never run two pip installs into the same venv at once
        return _ensure_tool(tool, j)


def _ensure_tool(tool, j=None):
    """Install an optional tool into venv-tools on first use (no Terminal needed)."""
    venv_dir = VENV_IMG if tool == "img" else VENV_TOOLS
    py = venv_dir / "bin" / "python"
    mark = venv_dir / f".ok-{tool}"
    if mark.exists() and py.exists():
        return py
    if j is not None:
        j.update(state="loading", msg=f"ติดตั้ง{TOOL_NAMES.get(tool, tool)}ครั้งแรก (ครั้งเดียว)…")
    if not py.exists():
        import venv as _venv
        _venv.EnvBuilder(with_pip=True).create(str(venv_dir))
    r = subprocess.run([str(py), "-m", "pip", "install", "-q", "-U", *TOOL_PKGS[tool]], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ติดตั้ง{TOOL_NAMES.get(tool, tool)}ไม่สำเร็จ: " + (r.stderr or r.stdout)[-300:])
    mark.write_text("ok")
    return py


def run_tool_script(tool, code, args, j=None, timeout=3600):
    """Run a small Python script inside venv-tools: args → JSON file, result ← JSON/text file."""
    py = ensure_tool(tool, j)
    work = Path(tempfile.mkdtemp(prefix="gm-"))
    (work / "run.py").write_text(code)
    (work / "in.json").write_text(json.dumps(args, ensure_ascii=False))
    env = dict(os.environ, HF_HOME=os.environ.get("HF_HOME", str(DATA / "hf")))
    r = subprocess.run([str(py), str(work / "run.py"), str(work / "in.json"), str(work / "out.json")], capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0 or not (work / "out.json").exists():
        tail = (r.stderr or r.stdout or "")[-400:]
        raise RuntimeError(("RAM ไม่พอ — " if r.returncode in (-9, 137) else "") + f"{TOOL_NAMES.get(tool, tool)}ผิดพลาด: {tail}")
    return json.loads((work / "out.json").read_text())


def submit(kind, fn, args, meta=None):
    jid = secrets.token_hex(4)
    JOBS[jid] = {"id": jid, "kind": kind, "state": "queued", "step": 0, "total": 0, "eta": None, "msg": "รอคิว", "created": time.time(), **(meta or {})}
    with QCOND:
        QUEUE.append((jid, fn, args))
        QCOND.notify()
    return jid


def queue_worker():
    while True:
        with QCOND:
            while not QUEUE:
                QCOND.wait()
            jid, fn, args = QUEUE.pop(0)
        j = JOBS.get(jid)
        if not j or j.get("cancel"):
            if j:
                j.update(state="error", msg="ยกเลิกแล้ว")
            continue
        try:
            fn(jid, *args)
        except Exception as e:  # noqa
            j.update(state="error", msg=str(e)[:400])


threading.Thread(target=queue_worker, daemon=True).start()


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
    ensure_tool("mlxgen", j)
    return VENV_TOOLS / "bin" / "mlxgen"


def run_mlxgen(j, prompt, w, h, frames, steps, fps, seed, out, image=None):
    exe = ensure_mlxgen(j)
    j.update(state="loading", msg="กำลังโหลดโมเดล Wan2.2 5B (ครั้งแรกดาวน์โหลด ~17GB)…", total=steps, t0=time.time())
    cmd = [str(exe), "generate", "--model", MLXGEN_MODEL, "--prompt", prompt,
           "--negative-prompt", "blurry, low quality, distorted, watermark, text, static, deformed",
           "--width", str(w), "--height", str(h), "--frames", str(frames), "--steps", str(steps),
           "--guidance", "5", "--fps", str(fps), "--seed", str(seed), "--output", out] + (["--image", image] if image else [])
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


def run_video_job(jid, prompt, mode, seconds, portrait, seed, up=None, image=None):
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
            if md.get("engine") == "mlxgen" or image:
                run_mlxgen(j, prompt, w, h, frames, md["steps"], md["fps"], seed, raw, image)
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
        j.update(state="done", path=final, mime="video/mp4", msg="เสร็จแล้ว", ms=ms, seed=seed)
        if final != raw:
            Path(raw).unlink(missing_ok=True)
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


# Long requests through the Cloudflare tunnel are cut at ~100s, and the phone then only sees "can't reach Mac".
# With header X-GM-Async the request runs in the background as a job; the phone polls /api/jobs/{id} and fetches the result.
ASYNC_PATHS = {"/api/tts", "/api/convert_voice", "/api/txt2img", "/api/img_edit", "/api/transcode"}


async def _replay(jid, scope, body):
    j = JOBS[jid]
    st, chunks, given = {}, [], [False]

    async def receive():
        if not given[0]:
            given[0] = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(7200)
        return {"type": "http.disconnect"}

    async def send(msg):
        if msg["type"] == "http.response.start":
            st["code"], st["headers"] = msg["status"], msg.get("headers") or []
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body") or b"")
    try:
        await app(scope, receive, send)
    except Exception as e:  # noqa
        j.update(state="error", code=500, msg=f"{type(e).__name__}: {e}"[:400])
        return
    code, data = st.get("code", 500), b"".join(chunks)
    hd = {k.decode().lower(): v.decode() for k, v in st.get("headers", [])}
    if code >= 400:
        try:
            jd = json.loads(data)
            msg = jd.get("detail") or jd.get("error") or str(jd)
        except Exception:  # noqa
            msg = data[:300].decode(errors="ignore") or f"HTTP {code}"
        j.update(state="error", code=code, msg=str(msg)[:400])
    else:
        j.update(state="done", data=data, mime=hd.get("content-type") or "application/octet-stream",
                 rh={k: hd[k] for k in ("x-seed", "x-ms") if k in hd}, msg="เสร็จแล้ว")


@app.middleware("http")
async def async_and_errors(req: Request, call_next):
    if req.method == "POST" and req.url.path in ASYNC_PATHS and req.headers.get("x-gm-async"):
        for k in [k for k, v in JOBS.items() if v.get("kind") == "req" and time.time() - v["created"] > 1800]:
            JOBS.pop(k, None)
        body = await req.body()
        scope = dict(req.scope)
        scope["headers"] = [(k, v) for k, v in req.scope["headers"] if k != b"x-gm-async"]
        jid = secrets.token_hex(4)
        JOBS[jid] = {"id": jid, "kind": "req", "state": "running", "step": 0, "total": 0, "eta": None, "msg": "กำลังทำงานบน Mac…", "created": time.time()}
        asyncio.get_running_loop().create_task(_replay(jid, scope, body))
        return JSONResponse({"job": jid}, status_code=202)
    try:
        return await call_next(req)
    except Exception as e:  # noqa — keep CORS headers on crashes so the phone sees the real error
        print("[error]", req.url.path, repr(e), flush=True)
        return JSONResponse({"detail": f"Mac ผิดพลาด: {type(e).__name__}: {e}"[:400]}, status_code=500)


# added last = outermost, so every response (401, crashes, jobs) carries CORS headers
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Seed", "X-Ms"])


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
            prog = f"{m['pct']}%" if m.get("total") else f"{m.get('mb', 0)} MB"
            raise HTTPException(503, f"กำลังดาวน์โหลดโมเดล {m['name']} ({prog}) — ลองใหม่อีกสักครู่")


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
        "models": {k: {kk: v.get(kk) for kk in ("name", "state", "pct", "mb", "total", "error")} for k, v in MODELS.items()},
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


@app.post("/api/img_edit")
async def img_edit(image: UploadFile = File(...), prompt: str = Form(...), seed: str = Form("")):
    prompt = prompt.strip()
    if not prompt:
        raise HTTPException(400, "missing prompt")
    model_guard("klein")
    src = Path(tempfile.mkdtemp(prefix="gm-src-")) / "in.png"
    from PIL import Image
    Image.open(io.BytesIO(await image.read())).convert("RGB").save(src)
    t0 = time.time()
    png, sd = await run_in_threadpool(busy, edit_image, str(src), prompt, seed or None)
    ms = round((time.time() - t0) * 1000)
    STATS["img_ms_edit"] = ms
    return Response(png, media_type="image/png", headers={"X-Seed": str(sd), "X-Ms": str(ms)})


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


def queue_pos(jid):
    ids = [q[0] for q in QUEUE]
    return ids.index(jid) + 1 if jid in ids else 0


@app.post("/api/txt2video")
async def txt2video(req: Request):
    j = await req.json()
    prompt = (j.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "missing prompt")
    if (RAM_GB or 16) < 16:
        raise HTTPException(400, "วิดีโอต้องใช้ Mac ที่มี RAM 16GB ขึ้นไป")
    mode = j.get("mode") or "standard"
    if mode in ("draft", "standard") and MODELS["video"]["state"] != "ready":
        prefetch(["video"])
    seed = j.get("seed") or random.randint(1, 2**31 - 2)
    jid = submit("video", run_video_job, (prompt, mode, float(j.get("seconds") or 3), bool(j.get("portrait")), seed, j.get("upscale")), {"prompt": prompt})
    return {"job": jid, "pos": queue_pos(jid)}


@app.post("/api/img2video")
async def img2video(image: UploadFile = File(...), prompt: str = Form(""), seconds: float = Form(2), portrait: bool = Form(True), upscale: str = Form("")):
    if (RAM_GB or 16) < 24:
        raise HTTPException(400, "ภาพ → วิดีโอ ต้องใช้ Mac RAM 32GB ขึ้นไป")
    path = DATA / f"i2v-{secrets.token_hex(4)}{Path(image.filename or 'a.png').suffix or '.png'}"
    path.write_bytes(await image.read())
    seed = random.randint(1, 2**31 - 2)
    jid = submit("video", run_video_job, (prompt or "gentle natural motion, cinematic", "hd720", seconds, portrait, seed, upscale or None, str(path)), {"prompt": prompt or "ภาพ → วิดีโอ"})
    return {"job": jid, "pos": queue_pos(jid)}


LLM_MODEL = "mlx-community/Qwen2.5-7B-Instruct-4bit"   # Apache-2.0
LLM_CODE = """
import sys, json
from mlx_lm import load, generate
a = json.load(open(sys.argv[1]))
m, t = load(a['model'])
msgs = [{'role': 'system', 'content': a['system']}, {'role': 'user', 'content': a['prompt']}]
p = t.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False)
try:
    from mlx_lm.sample_utils import make_sampler
    out = generate(m, t, prompt=p, max_tokens=a.get('max_tokens', 900), sampler=make_sampler(temp=0.75, top_p=0.9))
except Exception:
    out = generate(m, t, prompt=p, max_tokens=a.get('max_tokens', 900))
json.dump({'text': out}, open(sys.argv[2], 'w'), ensure_ascii=False)
"""


def job_llm(jid, system, prompt, max_tokens):
    j = JOBS[jid]
    j.update(state="running", msg="AI กำลังเขียน… (ครั้งแรกดาวน์โหลดโมเดล ~4.5GB)", t0=time.time())
    with LOCK:
        r = run_tool_script("llm", LLM_CODE, {"model": LLM_MODEL, "system": system, "prompt": prompt, "max_tokens": max_tokens}, j)
    j.update(state="done", result={"text": r["text"].strip()}, msg="เสร็จแล้ว", ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/llm")
async def llm(req: Request):
    j = await req.json()
    prompt = (j.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "missing prompt")
    system = j.get("system") or "You are a helpful Thai content writer."
    jid = submit("llm", job_llm, (system, prompt, int(j.get("max_tokens") or 900)), {"prompt": prompt[:80]})
    return {"job": jid, "pos": queue_pos(jid)}


WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"   # MIT
WHISPER_CODE = """
import sys, json, wave, numpy as np, mlx_whisper
a = json.load(open(sys.argv[1]))
w = wave.open(a['audio']); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
r = mlx_whisper.transcribe(x, path_or_hf_repo=a['model'], language=a.get('lang') or None, word_timestamps=True)
segs = [{'start': s['start'], 'end': s['end'], 'text': s['text'].strip(),
         'words': [{'w': ww['word'], 's': ww['start'], 'e': ww['end']} for ww in s.get('words', [])]} for s in r['segments']]
json.dump({'text': r['text'].strip(), 'language': r.get('language'), 'segments': segs}, open(sys.argv[2], 'w'), ensure_ascii=False)
"""


def job_whisper(jid, src, lang):
    j = JOBS[jid]
    j.update(state="running", msg="กำลังถอดเสียง… (ครั้งแรกดาวน์โหลดโมเดล ~1.6GB)", t0=time.time())
    wav = src + ".16k.wav"
    r = subprocess.run([ffmpeg_bin(), "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("อ่านไฟล์เสียงไม่ได้")
    with LOCK:
        res = run_tool_script("whisper", WHISPER_CODE, {"model": WHISPER_MODEL, "audio": wav, "lang": lang}, j)
    for f in (src, wav):
        Path(f).unlink(missing_ok=True)
    j.update(state="done", result=res, msg="เสร็จแล้ว", ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), lang: str = Form("th")):
    src = DATA / f"stt-{secrets.token_hex(4)}{Path(file.filename or 'a.bin').suffix}"
    with open(src, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    jid = submit("transcribe", job_whisper, (str(src), lang if lang != "auto" else None), {"prompt": file.filename or "ถอดเสียง"})
    return {"job": jid, "pos": queue_pos(jid)}


RMBG_CODE = """
import sys, json
from rembg import remove, new_session
from PIL import Image
a = json.load(open(sys.argv[1]))
out = remove(Image.open(a['in']).convert('RGBA'), session=new_session(a.get('model', 'isnet-general-use')))
out.save(a['out'])
json.dump({'ok': True}, open(sys.argv[2], 'w'))
"""


def job_rmbg(jid, src):
    j = JOBS[jid]
    j.update(state="running", msg="กำลังลบพื้นหลัง…", t0=time.time())
    out = src + ".png"
    with LOCK:
        run_tool_script("rmbg", RMBG_CODE, {"in": src, "out": out}, j)
    j.update(state="done", path=out, mime="image/png", msg="เสร็จแล้ว", ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/rmbg")
async def rmbg(image: UploadFile = File(...)):
    src = DATA / f"img-{secrets.token_hex(4)}{Path(image.filename or 'a.png').suffix or '.png'}"
    src.write_bytes(await image.read())
    jid = submit("rmbg", job_rmbg, (str(src),), {"prompt": "ลบพื้นหลัง"})
    return {"job": jid, "pos": queue_pos(jid)}


ESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"   # BSD-3-Clause
_esr = None


def get_esrgan():
    global _esr
    if _esr is None:
        import urllib.request
        from spandrel import ModelLoader
        w = DATA / "models" / "RealESRGAN_x4plus.pth"
        w.parent.mkdir(parents=True, exist_ok=True)
        if not w.exists():
            urllib.request.urlretrieve(ESRGAN_URL, str(w) + ".part")
            os.replace(str(w) + ".part", w)
        _esr = ModelLoader().load_from_file(str(w)).to(torch_device()).eval()
    return _esr


def job_upscale_img(jid, src, scale):
    import numpy as np
    import torch
    from PIL import Image
    j = JOBS[jid]
    j.update(state="running", msg="กำลังขยายภาพด้วย AI (Real-ESRGAN)…", t0=time.time())
    with LOCK:
        model = get_esrgan()
        img = Image.open(src).convert("RGB")
        x = torch.from_numpy(np.asarray(img).astype("float32") / 255.0).permute(2, 0, 1)[None].to(torch_device())
        _, _, H, W = x.shape
        T, P, S = 384, 16, 4
        out = torch.zeros((1, 3, H * S, W * S))
        tiles = [(y, xx) for y in range(0, H, T) for xx in range(0, W, T)]
        j["total"] = len(tiles)
        with torch.no_grad():
            for n, (y, xx) in enumerate(tiles):
                y0, x0, y1, x1 = max(0, y - P), max(0, xx - P), min(H, y + T + P), min(W, xx + T + P)
                o = model(x[:, :, y0:y1, x0:x1]).float().cpu()
                oy, ox = (y - y0) * S, (xx - x0) * S
                hh, ww = min(T, H - y) * S, min(T, W - xx) * S
                out[:, :, y * S:y * S + hh, xx * S:xx * S + ww] = o[:, :, oy:oy + hh, ox:ox + ww]
                j["step"] = n + 1
        arr = (out[0].clamp(0, 1).permute(1, 2, 0).numpy() * 255).round().astype("uint8")
        res = Image.fromarray(arr)
        if scale == 2:
            res = res.resize((W * 2, H * 2), Image.LANCZOS)
        dst = src + f".x{scale}.png"
        res.save(dst)
    j.update(state="done", path=dst, mime="image/png", msg="เสร็จแล้ว", ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/upscale_img")
async def upscale_img(image: UploadFile = File(...), scale: int = Form(2)):
    src = DATA / f"img-{secrets.token_hex(4)}{Path(image.filename or 'a.png').suffix or '.png'}"
    src.write_bytes(await image.read())
    jid = submit("upscale", job_upscale_img, (str(src), 4 if scale >= 4 else 2), {"prompt": "ขยายภาพ x%d" % scale})
    return {"job": jid, "pos": queue_pos(jid)}


@app.get("/api/jobs")
def jobs_list():
    items = sorted(JOBS.values(), key=lambda x: -x["created"])[:60]
    return [{k: v for k, v in x.items() if k not in ("path", "t0", "result", "data")} | {"pos": queue_pos(x["id"]), "has_result": x.get("state") == "done"} for x in items if x.get("kind") != "req"]


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "ไม่พบงานนี้ (Mac อาจเพิ่งรีสตาร์ท)")
    return {k: v for k, v in j.items() if k not in ("path", "t0", "data")} | {"pos": queue_pos(jid)}


@app.post("/api/jobs/{jid}/cancel")
def job_cancel(jid: str):
    if jid in JOBS:
        JOBS[jid]["cancel"] = True
        if JOBS[jid]["state"] == "queued":
            JOBS[jid].update(state="error", msg="ยกเลิกแล้ว")
    return {"ok": True}


@app.get("/api/jobs/{jid}/result")
def job_result(jid: str):
    j = JOBS.get(jid)
    if not j or j.get("state") != "done":
        raise HTTPException(404, "ยังไม่เสร็จ")
    if j.get("data") is not None:
        return Response(j["data"], media_type=j.get("mime"), headers={k.title(): v for k, v in (j.get("rh") or {}).items()})
    if j.get("path"):
        return FileResponse(j["path"], media_type=j.get("mime") or "application/octet-stream")
    return JSONResponse(j.get("result") or {})


# web app (same files as the GitHub Pages site) — mounted last so /api/* routes win
if (WEB / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")
else:
    @app.get("/")
    def no_web():
        return Response(f"""<meta charset="utf-8"><body style="font-family:sans-serif;background:#070b22;color:#e8eaff;padding:24px">
<h2>Gen Medi เซิร์ฟเวอร์ทำงานแล้ว ✅</h2><p>แต่ไม่พบไฟล์หน้าแอปที่ <code>{WEB}</code></p>
<p>เปิดหน้าแอปแทนได้ที่ <a style="color:#8ab4ff" href="{APP_URL}?server=http://localhost:{PORT}">{APP_URL}?server=http://localhost:{PORT}</a></p></body>""", media_type="text/html")


def cleanup_old_videos(days=2):
    """Generated clips are also saved to the user's folder — drop server-side copies after a while."""
    cut = time.time() - days * 86400
    for f in [*DATA.glob("video-*.mp4"), *DATA.glob("img-*"), *DATA.glob("i2v-*"), *DATA.glob("stt-*")]:
        try:
            if f.stat().st_mtime < cut:
                f.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn
    cleanup_old_videos()
    print(f"Gen Medi {VERSION} · {CHIP} · RAM {RAM_GB} GB · web {WEB}", flush=True)
    start_tunnel()
    prefetch(["tts", "voice", default_image_engine()])
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

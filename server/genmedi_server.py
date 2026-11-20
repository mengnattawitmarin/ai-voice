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
import math
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
    "vox": {"name": "เสียงพากย์ VoxCPM2 (ไทยชัด)", "repo": "openbmb/VoxCPM2", "allow": None, "state": "idle", "pct": 0},
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
        cfg = str(d / "converter" / "config.json")
        try:
            _ov = ToneColorConverter(cfg, device="cpu", enable_watermark=False)
        except TypeError:
            # this OpenVoice build passes enable_watermark on to its base class (which rejects it) and always loads
            # the wavmark watermark model → construct with a stub wavmark, then switch watermarking off
            import types
            had = sys.modules.get("wavmark")
            stub = types.ModuleType("wavmark")
            stub.load_model = lambda *a, **k: types.SimpleNamespace(to=lambda *a, **k: None)
            sys.modules["wavmark"] = stub
            try:
                _ov = ToneColorConverter(cfg, device="cpu")
            finally:
                if had is not None:
                    sys.modules["wavmark"] = had
                else:
                    sys.modules.pop("wavmark", None)
            _ov.watermark_model = None
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
VENV_TOOLS = DATA / "venv-tools"
VENV_VOX = DATA / "venv-vox"       # VoxCPM2 (Apache-2.0, 30 languages incl. Thai) — own torch stack, apart from coqui   # separate env for MLX tools so their MLX version can't clash with mflux
TOOL_PKGS = {"vox": ["voxcpm", "soundfile"], "img": ["mflux>=0.24,<0.30"], "mlxgen": ["mlx-gen"], "llm": ["mlx-lm"], "whisper": ["mlx-whisper"], "rmbg": ["rembg[cpu]", "pillow"]}
TOOL_NAMES = {"vox": "เสียงพากย์ VoxCPM2", "img": "ตัวสร้างภาพรุ่นใหม่ (mflux)", "mlxgen": "ตัวสร้างวิดีโอ HD", "llm": "ผู้ช่วยเขียนบท", "whisper": "ตัวถอดเสียง", "rmbg": "ตัวลบพื้นหลัง"}
JOBS = {}
QUEUE = []
QCOND = threading.Condition()


TOOL_LOCK = threading.Lock()


def ensure_tool(tool, j=None):
    with TOOL_LOCK:   # never run two pip installs into the same venv at once
        return _ensure_tool(tool, j)


def _ensure_tool(tool, j=None):
    """Install an optional tool into venv-tools on first use (no Terminal needed)."""
    venv_dir = {"img": VENV_IMG, "vox": VENV_VOX}.get(tool, VENV_TOOLS)
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
        "loras": lora_list(), "tunnel": TUNNEL["url"], "tunnel_state": TUNNEL["state"], "local": local_request(req),
        "pair": pair_link() if local_request(req) else None,
        "speakers": vox_speakers() + my_speakers() + (kt_speakers() if MODELS["tts"]["state"] == "ready" else [{"id": k, "name": v[0], "gender": v[1]} for k, v in KT_SPEAKERS.items()]),
        "voices": [p.stem for p in VOICES.glob("*.wav") if not p.stem.startswith("_")], "video_modes": {k: v["name"] for k, v in VIDEO_MODES.items()},
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
    speaker = j.get("speaker") or "Linda"
    model_guard("vox" if speaker.startswith("vox:") else "tts")
    lang = j.get("lang") or "th-th"

    def run():
        t0 = time.time()
        import numpy as np
        if speaker.startswith("vox:"):         # VoxCPM2: clear Thai, cloned from a reference clip
            return vox_tts(text, speaker[4:])
        if speaker.startswith("my:"):          # the user's own trained Thai voice
            s, sp = get_my(speaker[3:])
        else:
            s = get_kt()
            names = s.tts_model.speaker_manager.speaker_names
            sp = speaker if speaker in names else names[0]
        try:
            s.tts_model.length_scale = float(j.get("slow") or 1.12)   # a bit slower = clearer Thai
        except Exception:  # noqa
            pass
        sr = s.output_sample_rate
        out = []
        for piece in tts_pieces(text):   # Thai spaces mark phrase breaks — speak each phrase separately with a short pause
            out.append(np.asarray(s.tts(piece, speaker_name=sp, language_name=lang), dtype="float32"))
            out.append(np.zeros(int(sr * (0.32 if piece[-1:] in ".!?…" else 0.16)), dtype="float32"))
        wav = np.concatenate(out) if out else np.zeros(1, dtype="float32")
        STATS["tts_ms_per_char"] = round((time.time() - t0) * 1000 / max(1, len(text)), 1)
        return wav_bytes(wav, sr)
    data = await run_in_threadpool(busy, run)
    voice = j.get("voice")  # optional: convert to a saved voice of the user (OpenVoice)
    if voice and (VOICES / f"{voice}.wav").exists():
        model_guard("voice")
        data = await run_in_threadpool(busy, convert_bytes, data, str(VOICES / f"{voice}.wav"), float(j.get("tau") or 0.3))
    return Response(data, media_type="audio/wav")


# ---------------- VoxCPM2 (OpenBMB, Apache-2.0): modern multilingual TTS with Thai, cloning from a reference clip ----------------
VOX_CODE = r"""
import sys, json, os, traceback
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch, soundfile as sf
from voxcpm import VoxCPM
path = sys.argv[1]

def load(d):
    try:
        m = VoxCPM.from_pretrained(path, load_denoiser=False, device=d)
    except TypeError:
        m = VoxCPM.from_pretrained(path, load_denoiser=False)
        try:
            m.tts_model.to(d)
        except Exception:
            pass
    return m

dev = "mps" if torch.backends.mps.is_available() else "cpu"
try:
    model = load(dev)
except Exception as e:
    print("mps load failed:", e, file=sys.stderr, flush=True)
    dev = "cpu"
    model = load("cpu")
print(json.dumps({"ready": True, "device": dev, "sr": model.tts_model.sample_rate}), flush=True)

def gen(req):
    kw = dict(text=req["text"], cfg_value=req.get("cfg", 2.0), inference_timesteps=req.get("steps", 10), normalize=False, denoise=False)
    if req.get("prompt_wav"):
        kw["prompt_wav_path"] = req["prompt_wav"]
        kw["prompt_text"] = req.get("prompt_text")
    try:
        return model.generate(**kw)
    except TypeError:
        kw.pop("denoise", None); kw.pop("normalize", None)
        return model.generate(**kw)

for line in sys.stdin:
    req = json.loads(line)
    try:
        try:
            wav = gen(req)
        except Exception as e:
            if dev != "mps":
                raise
            print("mps generate failed, switching to cpu:", e, file=sys.stderr, flush=True)
            dev = "cpu"; model = load("cpu"); wav = gen(req)
        sf.write(req["out"], wav, model.tts_model.sample_rate)
        print(json.dumps({"ok": True, "device": dev}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": (type(e).__name__ + ": " + str(e))[:400], "trace": traceback.format_exc()[-1200:]}), flush=True)
"""


class VoxWorker:
    """Keeps one VoxCPM2 process alive (the 2B model takes a while to load); unloads after 20 idle minutes."""
    def __init__(self):
        self.p, self.lock, self.last, self.device = None, threading.Lock(), 0, None
        threading.Thread(target=self._idle, daemon=True).start()

    def _read(self, timeout):
        end = time.time() + timeout
        while time.time() < end:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("VoxCPM2 หยุดทำงาน — ดูรายละเอียดใน " + str(DATA / "logs" / "voxcpm.log"))
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except Exception:  # noqa
                    pass
        raise RuntimeError("VoxCPM2 ตอบช้าเกินไป")

    def _start(self):
        py = ensure_tool("vox")
        path = ensure_model("vox")
        script = DATA / "voxcpm_worker.py"
        script.write_text(VOX_CODE)
        (DATA / "logs").mkdir(exist_ok=True)
        err = open(DATA / "logs" / "voxcpm.log", "a")
        env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1", HF_HOME=os.environ.get("HF_HOME", str(DATA / "hf")), PYTHONUNBUFFERED="1")
        self.p = subprocess.Popen([str(py), str(script), path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True, env=env)
        r = self._read(900)
        self.device = r.get("device")
        print(f"[vox] ready on {self.device}", flush=True)

    def generate(self, **req):
        with self.lock:
            if not self.p or self.p.poll() is not None:
                self._start()
            out = Path(tempfile.mkdtemp(prefix="gm-vox-")) / "out.wav"
            req["out"] = str(out)
            self.p.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
            self.p.stdin.flush()
            r = self._read(1800)
            self.last = time.time()
            if not r.get("ok"):
                print("[vox]", r.get("trace"), flush=True)
                raise RuntimeError("VoxCPM2: " + r.get("error", ""))
            self.device = r.get("device", self.device)
            return out.read_bytes()

    def _idle(self):
        while True:
            time.sleep(60)
            if self.p and self.p.poll() is None and time.time() - self.last > 1200 and not self.lock.locked():
                self.p.terminate()
                self.p = None


VOX = VoxWorker()
VOX_DESIGNS = {
    "f1": ("หญิง สดใส", "female", "a young Thai woman with a bright, friendly voice, clear standard Central Thai pronunciation"),
    "m1": ("ชาย นุ่มลึก", "male", "a Thai man in his thirties with a deep, warm, calm voice, clear standard Central Thai pronunciation"),
    "news": ("ผู้ประกาศข่าว (หญิง)", "female", "a professional Thai female news anchor, clear and confident, standard Thai"),
    "m2": ("ชาย พลังงานสูง", "male", "an energetic young Thai man, lively YouTuber style, clear standard Thai"),
}
VOX_REF_TEXT = {"female": "สวัสดีค่ะ วันนี้เราจะพาไปรู้จักกับเรื่องใหม่ๆ ที่น่าสนใจ รับรองว่าทุกคนจะต้องชอบแน่นอนค่ะ",
                "male": "สวัสดีครับ วันนี้เราจะพาไปรู้จักกับเรื่องใหม่ๆ ที่น่าสนใจ รับรองว่าทุกคนจะต้องชอบแน่นอนครับ"}


def vox_ref(key):
    """→ (prompt wav, its transcript) for a VoxCPM2 voice: designed voices are generated once and cached so the timbre stays the same."""
    if key in VOX_DESIGNS:
        name, g, desc = VOX_DESIGNS[key]
        wav, txt = VOICES / f"_vox_{key}.wav", VOX_REF_TEXT[g]
        if not wav.exists():
            wav.write_bytes(VOX.generate(text=f"({desc}){txt}", cfg=2.0, steps=12))
        return str(wav), txt
    if key.startswith("ds:"):          # the user's recorded dataset: a clean 4–10 s clip with its known sentence
        d = ds_dir(key[3:])
        m = ds_meta(d)
        good = [(k, v) for k, v in m.items() if 4 <= v.get("dur", 0) <= 10 and not v.get("warn") and not (v.get("qc") and not v["qc"].get("ok"))]
        if not good:
            raise HTTPException(400, "ยังไม่มีประโยคที่อัดไว้ยาว 4–10 วินาที — อัดในหน้า 🎓 สร้างโมเดลเสียงไทยก่อน")
        k, v = min(good, key=lambda kv: kv[1].get("noise", 0))
        return str(d / "wavs" / f"{k}.wav"), v["text"]
    if key.startswith("clone:"):        # a saved clone voice — transcribe it once with Whisper
        vid = Path(key[6:]).name
        wav, tf = VOICES / f"{vid}.wav", VOICES / f"{vid}.txt"
        if not wav.exists():
            raise HTTPException(404, "ไม่พบเสียงโคลนนี้บน Mac")
        if not tf.exists():
            heard = run_tool_script("whisper", DSQC_CODE, {"model": WHISPER_MODEL, "files": {"a": str(wav)}})
            tf.write_text(heard.get("a", ""))
        return str(wav), tf.read_text() or None
    raise HTTPException(404, "ไม่รู้จักเสียงนี้")


def vox_tts(text, key):
    t0 = time.time()
    ref, rtxt = vox_ref(key)
    data = VOX.generate(text=text, prompt_wav=ref, prompt_text=rtxt, cfg=2.0, steps=10)
    STATS["vox_ms_per_char"] = round((time.time() - t0) * 1000 / max(1, len(text)), 1)
    return data


def vox_speakers():
    out = [{"id": "vox:" + k, "name": v[0] + " · VoxCPM2", "gender": v[1], "engine": "vox"} for k, v in VOX_DESIGNS.items()]
    if DS_ROOT.exists():
        for mf in DS_ROOT.glob("*/meta.json"):
            try:
                if len(json.loads(mf.read_text())) >= 3:
                    out.insert(0, {"id": "vox:ds:" + mf.parent.name, "name": "🎓 เสียงฉัน · VoxCPM2", "gender": None, "engine": "vox", "mine": True})
            except Exception:  # noqa
                pass
    for w in sorted(VOICES.glob("*.wav")):
        if not w.stem.startswith("_"):
            out.append({"id": "vox:clone:" + w.stem, "name": "🧬 " + w.stem + " · VoxCPM2", "gender": None, "engine": "vox"})
    return out


def tts_pieces(text, lo=12, hi=70):
    """Split at spaces/newlines (Thai phrase breaks), merging tiny phrases so each piece is ~12–70 chars."""
    words = [w for w in re.split(r"\s+", text.strip()) if w]
    out, buf = [], ""
    for w in words:
        if buf and len(buf) + 1 + len(w) > hi:
            out.append(buf)
            buf = w
        elif buf and len(buf) < lo:
            buf += " " + w
        elif buf:
            out.append(buf)
            buf = w
        else:
            buf = w
    if buf:
        if out and len(buf) < lo // 2:
            out[-1] += " " + buf
        else:
            out.append(buf)
    return out


def kt_ref(name):
    """A reference clip of a built-in KhanomTan voice, so OpenVoice can turn a recording into that timbre."""
    p = VOICES / f"_kt_{Path(name).name}.wav"
    if not p.exists():
        s = get_kt()
        sp = name if name in s.tts_model.speaker_manager.speaker_names else s.tts_model.speaker_manager.speaker_names[0]
        wav = s.tts("สวัสดีครับ วันนี้อากาศดีมาก เราจะไปเที่ยวทะเลกันตอนเช้า แล้วกลับบ้านตอนเย็น ขอให้ทุกคนมีความสุขมากๆ นะครับ",
                    speaker_name=sp, language_name="th-th")
        p.write_bytes(wav_bytes(wav, s.output_sample_rate))
    return str(p)


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
    if voice.startswith("kt:"):
        model_guard("tts")
        src_b = await source.read()
        name = voice[3:]
        return Response(await run_in_threadpool(busy, lambda: convert_bytes(src_b, kt_ref(name), tau)), media_type="audio/wav")
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
    lora = Path(j.get("lora") or "").name
    if lora and (LORAS / f"{lora}.safetensors").exists():
        model_guard("klein")
        t0 = time.time()

        def run_lora():
            sd = int(j.get("seed") or random.randint(1, 2**31 - 2))
            W, H = fit_size(j.get("width"), j.get("height"), 1024 if (RAM_GB or 16) >= 16 else 768)
            b = io.BytesIO()
            gen_klein_lora(prompt, W, H, sd, lora, float(j.get("lora_scale") or 1.0)).save(b, format="PNG")
            return b.getvalue(), sd
        png, seed = await run_in_threadpool(busy, run_lora)
        return Response(png, media_type="image/png", headers={"X-Seed": str(seed), "X-Ms": str(round((time.time() - t0) * 1000))})
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
    j = JOBS[jid]
    j.update(state="running", msg="กำลังขยายภาพด้วย AI (Real-ESRGAN)…", t0=time.time())
    with LOCK:
        dst = esr_upscale(src, scale, j)
    j.update(state="done", path=dst, mime="image/png", msg="เสร็จแล้ว", ms=round((time.time() - j["t0"]) * 1000))


def esr_upscale(src, scale, j=None):
    import numpy as np
    import torch
    from PIL import Image
    j = j if j is not None else {}
    if True:
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
    return dst


# ---------------- hi-res: Real-ESRGAN x2, then a light FLUX.2 Klein img2img pass to re-draw fine detail ----------------
def job_hires(jid, src, prompt):
    from PIL import Image
    j = JOBS[jid]
    j.update(state="running", msg="ขั้นที่ 1/2: ขยายภาพ x2 (Real-ESRGAN)…", t0=time.time())
    with LOCK:
        up = esr_upscale(src, 2, j)
        note = ""
        if (RAM_GB or 8) >= 24 and prompt:
            try:
                j.update(msg="ขั้นที่ 2/2: เติมรายละเอียดด้วย FLUX.2 Klein…", step=0, total=0)
                with Image.open(up) as im:
                    w, h = im.size
                s = min(1.0, 2048 / max(w, h))
                W, H = int(w * s) // 16 * 16, int(h * s) // 16 * 16
                path = ensure_model("klein")
                out = Path(up).with_suffix(".hires.png")
                mflux_cli("mflux-generate-flux2", ["--model", path, "--base-model", "flux2-klein-4b", "--prompt", prompt + ", highly detailed, sharp focus",
                          "--image-path", up, "--image-strength", "0.3", "--width", str(W), "--height", str(H), "--steps", "4", "--seed", "7", "--output", str(out)])
                up = str(out)
            except Exception as e:  # noqa — the ESRGAN result is still a good 2x image
                note = "ใช้ภาพขยาย (เติมรายละเอียดไม่สำเร็จ)"
                print("[hires] refine failed:", e, flush=True)
    j.update(state="done", path=up, mime="image/png", msg="เสร็จแล้ว" + (" · " + note if note else ""), ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/hires")
async def hires(image: UploadFile = File(...), prompt: str = Form("")):
    src = DATA / f"img-{secrets.token_hex(4)}.png"
    src.write_bytes(await image.read())
    jid = submit("hires", job_hires, (str(src), prompt.strip()), {"prompt": "ภาพคมชัด 2K"})
    return {"job": jid, "pos": queue_pos(jid)}


# ---------------- LoRA: teach FLUX.2 Klein 4B a product / character / face / style from the user's own pictures ----------------
LORA_DATA = DATA / "lora-data"
LORAS = DATA / "loras"
LORA_TRAIN = {}
LORA_KINDS = {"product": "a product photo of {t}", "character": "an illustration of {t}", "person": "a photo of {t}", "style": "an image in {t} style"}


def lora_dir(name):
    n = re.sub(r"[^a-zA-Z0-9_-]+", "-", name or "my")[:30].strip("-").lower() or "my"
    d = LORA_DATA / n
    (d / "images").mkdir(parents=True, exist_ok=True)
    return d


def lora_list():
    out = []
    for m in sorted(LORAS.glob("*.json")) if LORAS.exists() else []:
        try:
            j = json.loads(m.read_text())
            if (LORAS / f"{m.stem}.safetensors").exists():
                out.append(j)
        except Exception:  # noqa
            pass
    return out


@app.get("/api/lora/{name}")
def lora_status(name: str):
    d = lora_dir(name)
    meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {}
    imgs = sorted(p.name for p in (d / "images").glob("*.png"))
    t = {k: v for k, v in (LORA_TRAIN.get(d.name) or {}).items() if k != "proc"} or None
    prev = sorted(p.name for p in (d / "previews").glob("*.png")) if (d / "previews").exists() else []
    return {"name": d.name, "images": imgs, "meta": meta, "train": t, "ready": (LORAS / f"{d.name}.safetensors").exists(), "previews": prev}


@app.get("/api/lora/{name}/preview/{fn}")
def lora_preview(name: str, fn: str):
    return FileResponse(lora_dir(name) / "previews" / Path(fn).name, media_type="image/png")


def img_sig(im):
    """Tiny grayscale thumbnail (for near-duplicate detection), mean brightness and sharpness (variance of a Laplacian)."""
    import numpy as np
    g = np.asarray(im.convert("L").resize((256, 256)), dtype=np.float32)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    thumb = np.asarray(im.convert("L").resize((16, 16)), dtype=np.float32)
    return thumb, float(g.mean()), float(lap.var())


def lora_add_images(d, pil_images, limit=None):
    """Save pictures for training, skipping near-duplicates and very dark ones."""
    from PIL import Image, ImageOps
    import numpy as np
    have = []
    for p in (d / "images").glob("*.png"):
        try:
            with Image.open(p) as im:
                have.append(img_sig(im)[0])
        except Exception:  # noqa
            pass
    added = dup = dark = 0
    for im in pil_images:
        im = ImageOps.exif_transpose(im).convert("RGB")
        th, bright, _ = img_sig(im)
        if bright < 28:
            dark += 1
            continue
        if any(float(np.abs(th - h).mean()) < 6 for h in have):
            dup += 1
            continue
        s_ = min(1.0, 1024 / max(im.size))
        if s_ < 1:
            im = im.resize((int(im.width * s_), int(im.height * s_)), Image.LANCZOS)
        im.save(d / "images" / f"{secrets.token_hex(4)}.png")
        have.append(th)
        added += 1
        if limit and added >= limit:
            break
    return {"added": added, "dup": dup, "dark": dark, "count": len(list((d / "images").glob("*.png")))}


@app.post("/api/lora/{name}/images")
async def lora_images(name: str, files: list[UploadFile] = File(...)):
    from PIL import Image
    d = lora_dir(name)
    ims = []
    for f in files:
        try:
            ims.append(Image.open(io.BytesIO(await f.read())))
        except Exception:  # noqa
            pass
    return lora_add_images(d, ims)


@app.post("/api/lora/{name}/video")
async def lora_video(name: str, video: UploadFile = File(...), n: int = Form(25)):
    """A short video circling the subject → the sharpest, most varied frames as training pictures."""
    from PIL import Image
    d = lora_dir(name)
    work = Path(tempfile.mkdtemp(prefix="gm-vid-"))
    src = work / ("in" + (Path(video.filename or "a.mp4").suffix or ".mp4"))
    src.write_bytes(await video.read())

    def run():
        subprocess.run([ffmpeg_bin(), "-y", "-i", str(src), "-vf", "fps=5,scale='min(1280,iw)':-2", "-q:v", "3", str(work / "f%04d.jpg")], capture_output=True)
        frames = sorted(work.glob("f*.jpg"))
        if not frames:
            raise HTTPException(400, "อ่านวิดีโอไม่ได้")
        scored = []
        for f in frames:
            with Image.open(f) as im:
                _, bright, sharp = img_sig(im)
            scored.append((f, sharp, bright))
        k = max(1, min(int(n), 40))
        bins = [scored[i * len(scored) // k:(i + 1) * len(scored) // k] for i in range(k)]   # spread over the whole video = many angles
        picks = [max(b, key=lambda x: x[1]) for b in bins if b]
        med = sorted(x[1] for x in scored)[len(scored) // 2]
        picks = [p for p in picks if p[1] >= med * 0.35]   # drop motion-blurred frames
        r = lora_add_images(d, [Image.open(p[0]) for p in picks])
        r["frames"] = len(frames)
        return r
    try:
        return await run_in_threadpool(run)
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.delete("/api/lora/{name}/images/{fn}")
def lora_image_del(name: str, fn: str):
    (lora_dir(name) / "images" / Path(fn).name).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/lora/{name}/images/{fn}")
def lora_image_get(name: str, fn: str):
    return FileResponse(lora_dir(name) / "images" / Path(fn).name, media_type="image/png")


def lora_train_worker(name, kind, desc, label, steps, fast=False):
    d = lora_dir(name)
    t = LORA_TRAIN[d.name]
    imgs = sorted((d / "images").glob("*.png"))
    trig = "gm" + d.name.replace("-", "")
    cap = LORA_KINDS.get(kind, LORA_KINDS["product"]).format(t=trig) + (", " + desc if desc else "")
    data = d / "data"
    shutil.rmtree(data, ignore_errors=True)
    data.mkdir()
    for p in imgs:   # mflux reads a sibling .txt caption per image
        shutil.copy(p, data / p.name)
        (data / (p.stem + ".txt")).write_text(cap)
    epochs = max(4, math.ceil(steps / max(1, len(imgs))))
    out = d / "train"
    rank = 8 if fast else 16
    tgt = [{"module_path": f"transformer_blocks.{{block}}.attn.{m}", "blocks": {"start": 0, "end": 5}, "rank": rank} for m in ("to_q", "to_k", "to_v")]
    big = (RAM_GB or 16) >= 24
    cfg = {"model": "flux2-klein-base-4b", "data": str(data), "seed": 42, "steps": 20, "guidance": 1.0,
           "quantize": 4 if (fast or not big) else 8, "low_ram": not big, "gradient_checkpointing": True,
           "max_resolution": 512 if fast else (1024 if big else 768),
           "training_loop": {"num_epochs": epochs, "batch_size": 1, "timestep_low": 0, "timestep_high": 20},
           "optimizer": {"name": "AdamW", "learning_rate": 1e-4},
           "checkpoint": {"output_path": str(out), "save_frequency": max(50, steps // 6)},
           "monitoring": {"plot_frequency": 10 ** 6, "generate_image_frequency": 10 ** 6},
           "lora_layers": {"targets": tgt}}
    (d / "train.json").write_text(json.dumps(cfg, indent=1))
    meta = {"name": d.name, "label": label or d.name, "trigger": trig, "kind": kind, "caption": cap, "images": len(imgs)}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    py = ensure_tool("img")
    env = dict(os.environ, HF_HOME=os.environ.get("HF_HOME", str(DATA / "hf")), PYTHONUNBUFFERED="1")
    t.update(state="running", msg="กำลังเตรียม… (ครั้งแรกดาวน์โหลดโมเดลฐาน FLUX.2 Klein Base 4B หลาย GB)", started=time.time(), total=epochs * len(imgs))
    p = subprocess.Popen([str(py.parent / "mflux-train"), "--config", str(d / "train.json")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=str(d))
    t["proc"] = p
    try:
        subprocess.Popen(["caffeinate", "-i", "-w", str(p.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa
        pass
    log = open(d / "train.log", "ab")
    buf, tail = b"", []
    while True:
        ch = p.stdout.read(1)
        if not ch:
            break
        log.write(ch)
        if ch in (b"\r", b"\n"):
            line = buf.decode(errors="ignore").strip()
            buf = b""
            if not line:
                continue
            tail = (tail + [line])[-30:]
            mm = re.search(r"(\d+)\s*/\s*(\d+)\s*\[", line) or re.search(r"[Ss]tep\D{0,3}(\d+)\s*/\s*(\d+)", line)
            if mm:
                t["step"], t["total"] = int(mm.group(1)), int(mm.group(2))
                el = time.time() - t["started"]
                if t["step"] > 3:
                    t["eta"] = round(el / t["step"] * (t["total"] - t["step"]))
                t["msg"] = f"กำลังเทรน {t['step']}/{t['total']}"
            elif "ownload" in line or "Fetching" in line:
                t["msg"] = "กำลังดาวน์โหลดโมเดลฐาน… " + line[-60:]
        else:
            buf += ch
    p.wait()
    log.close()
    t.pop("proc", None)
    t["tail"] = tail[-10:]
    ok = lora_export(d.name)
    if ok and not t.get("stop"):
        t["msg"] = "เทรนเสร็จ — กำลังวาดภาพตัวอย่าง…"
        prev = d / "previews"
        shutil.rmtree(prev, ignore_errors=True)
        prev.mkdir()
        scenes = {"product": ["on a wooden table in a bright cafe, soft morning light", "studio product shot on a clean white background"],
                  "character": ["waving hello in a sunny park", "sitting on a stack of books, cozy room"],
                  "person": ["portrait in a city street at golden hour", "smiling, sitting in a modern office"],
                  "style": ["a quiet Thai temple at sunset", "a busy night market"]}.get(kind, ["on a table", "outdoors"])
        for i, sc in enumerate(scenes):
            try:
                with LOCK:
                    gen_klein_lora(sc, 768, 768, 100 + i, d.name).save(prev / f"p{i + 1}.png")
            except Exception as e:  # noqa
                print("[lora] preview", e, flush=True)
    if t.get("stop"):
        t.update(state="stopped", msg="หยุดแล้ว" + (" — ใช้ผลล่าสุดได้" if ok else ""))
    elif ok:
        t.update(state="done", msg="เทรนเสร็จแล้ว 🎉 เลือกใช้ได้ในหน้าสร้างภาพ")
    else:
        t.update(state="error", msg="เทรนไม่สำเร็จ: " + " | ".join(tail[-3:])[-300:])


def lora_export(name):
    """Take the newest LoRA weights the trainer wrote (zip checkpoint or .safetensors) → loras/<name>.safetensors"""
    import glob
    import zipfile
    d = lora_dir(name)
    cands = [p for p in glob.glob(str(d / "train" / "**" / "*"), recursive=True) if p.endswith((".zip", ".safetensors"))]
    if not cands:
        return False
    newest = max(cands, key=os.path.getmtime)
    LORAS.mkdir(parents=True, exist_ok=True)
    dst = LORAS / f"{d.name}.safetensors"
    if newest.endswith(".zip"):
        with zipfile.ZipFile(newest) as z:
            st = [n for n in z.namelist() if n.endswith(".safetensors")]
            if not st:
                return False
            pick = next((n for n in st if "adapter" in n.lower() or "lora" in n.lower()), st[0])
            dst.write_bytes(z.read(pick))
    else:
        shutil.copy(newest, dst)
    meta = json.loads((d / "meta.json").read_text())
    meta["t"] = int(time.time())
    (LORAS / f"{d.name}.json").write_text(json.dumps(meta, ensure_ascii=False))
    return True


@app.post("/api/lora/{name}/train")
def lora_train(name: str, kind: str = Form("product"), desc: str = Form(""), label: str = Form(""), steps: int = Form(1200), fast: int = Form(0)):
    d = lora_dir(name)
    if (LORA_TRAIN.get(d.name) or {}).get("state") == "running":
        raise HTTPException(409, "กำลังเทรนอยู่แล้ว")
    n = len(list((d / "images").glob("*.png")))
    if n < 6:
        raise HTTPException(400, f"ภาพน้อยเกินไป ({n}) — ต้องมีอย่างน้อย 6 ภาพ (แนะนำ 15–40)")
    LORA_TRAIN[d.name] = {"state": "starting", "msg": "กำลังเริ่ม…", "step": 0}
    threading.Thread(target=lambda: _safe(lora_train_worker, d.name, kind, desc.strip()[:200], label.strip()[:40], int(steps), bool(fast)), daemon=True).start()
    return {"ok": True}


@app.post("/api/lora/{name}/stop")
def lora_stop(name: str):
    t = LORA_TRAIN.get(lora_dir(name).name) or {}
    if t.get("proc"):
        t["stop"] = True
        t["proc"].terminate()
    return {"ok": True}


@app.delete("/api/lora/{name}")
def lora_delete(name: str):
    d = lora_dir(name)
    for f in (LORAS / f"{d.name}.safetensors", LORAS / f"{d.name}.json"):
        f.unlink(missing_ok=True)
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


def gen_klein_lora(prompt, W, H, seed, lora, scale=1.0):
    meta = json.loads((LORAS / f"{lora}.json").read_text())
    path = ensure_model("klein")
    out = Path(tempfile.mkdtemp(prefix="gm-lora-")) / "out.png"
    p = prompt if meta["trigger"] in prompt else f"{meta['caption']}, {prompt}"
    mflux_cli("mflux-generate-flux2", ["--model", path, "--base-model", "flux2-klein-4b", "--prompt", p, "--lora-paths", str(LORAS / f"{lora}.safetensors"),
              "--lora-scales", str(scale), "--width", str(W), "--height", str(H), "--seed", str(seed), "--steps", "4", "--output", str(out)])
    from PIL import Image
    return Image.open(out)


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
# ---------------- voice training: dataset of the user's own Thai recordings ----------------
DS_ROOT = DATA / "datasets"


def ds_dir(name):
    n = re.sub(r"[^a-zA-Z0-9ก-๙_-]+", "-", name or "mine")[:40] or "mine"
    d = DS_ROOT / n
    (d / "wavs").mkdir(parents=True, exist_ok=True)
    return d


def ds_meta(d):
    f = d / "meta.json"
    try:
        return json.loads(f.read_text())
    except Exception:  # noqa
        return {}


def ds_save_meta(d, m):
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(m, ensure_ascii=False))
    tmp.replace(d / "meta.json")


def ds_key(text):
    import hashlib
    return hashlib.sha1(re.sub(r"\s+", " ", text.strip()).encode()).hexdigest()[:12]


def ds_process(raw_path, out_path):
    """Trim silence, level to a steady loudness, and report problems a TTS dataset must not have."""
    import numpy as np
    import librosa
    import soundfile as sf
    y, sr = librosa.load(raw_path, sr=22050, mono=True)
    warn = []
    if y.size == 0:
        raise HTTPException(400, "ไม่มีเสียงในไฟล์")
    clip = float(np.mean(np.abs(y) > 0.985))
    if clip > 0.001:
        warn.append("เสียงแตก (ดังเกิน) — ถอยไมค์ออกนิด")
    frames = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    db = 20 * np.log10(np.maximum(frames, 1e-6))
    noise, speech = float(np.percentile(db, 10)), float(np.percentile(db, 90))
    if noise > -42:
        warn.append("เสียงรบกวนพื้นหลังมาก — หาที่เงียบกว่านี้")
    if speech - noise < 22:
        warn.append("เสียงพูดเบาเมื่อเทียบกับเสียงรบกวน")
    yt, _ = librosa.effects.trim(y, top_db=35, frame_length=1024, hop_length=256)
    pad = np.zeros(int(0.12 * sr), dtype=np.float32)
    yt = np.concatenate([pad, yt.astype(np.float32), pad])
    rms = float(np.sqrt(np.mean(yt ** 2)) or 1e-6)
    yt = yt * (10 ** (-20 / 20) / rms)          # ~-20 dBFS RMS
    peak = float(np.max(np.abs(yt)) or 1)
    if peak > 0.95:
        yt = yt * (0.95 / peak)
    dur = len(yt) / sr
    if dur < 0.9:
        raise HTTPException(400, "สั้นเกินไป — อ่านทั้งประโยคแล้วค่อยกดหยุด")
    if dur > 20:
        warn.append("ยาวเกิน 20 วินาที — แบ่งเป็นประโยคสั้นลงจะดีกว่า")
    sf.write(out_path, yt, sr, subtype="PCM_16")
    return round(dur, 2), warn, round(noise, 1)


@app.get("/api/ds/{name}")
def ds_status(name: str):
    d = ds_dir(name)
    m = ds_meta(d)
    tot = sum(v.get("dur", 0) for v in m.values())
    return {"name": d.name, "count": len(m), "minutes": round(tot / 60, 1), "items": m,
            "checked": sum(1 for v in m.values() if v.get("qc")), "bad": sum(1 for v in m.values() if v.get("qc") and not v["qc"].get("ok")),
            "train": {k: v for k, v in (TRAIN.get(d.name) or {}).items() if k != "proc"} or None, "settings": ds_settings(d),
            "model": (json.loads((MY_MODELS / d.name / "meta.json").read_text()) if (MY_MODELS / d.name / "meta.json").exists() else None)}


@app.post("/api/ds/{name}/clip")
async def ds_clip(name: str, audio: UploadFile = File(...), text: str = Form(...)):
    text = re.sub(r"\s+", " ", text.strip())
    if not text:
        raise HTTPException(400, "missing text")
    d = ds_dir(name)
    raw = to_wav_file(await audio.read(), sr=22050)
    key = ds_key(text)
    dur, warn, noise = await run_in_threadpool(ds_process, raw, str(d / "wavs" / f"{key}.wav"))
    Path(raw).unlink(missing_ok=True)
    m = ds_meta(d)
    m[key] = {"text": text, "dur": dur, "noise": noise, "warn": warn, "t": int(time.time()), "qc": None}
    ds_save_meta(d, m)
    # every 50 unchecked clips → let Whisper check them in the background (no button needed)
    if sum(1 for v in m.values() if not v.get("qc")) >= 50 and not any(x.get("kind") == "dsqc" and x["state"] in ("queued", "running") for x in JOBS.values()):
        submit("dsqc", job_dsqc, (d.name, False), {"prompt": "ตรวจชุดเสียงอัตโนมัติ"})
    return {"key": key, "dur": dur, "warn": warn, "count": len(m), "minutes": round(sum(v.get("dur", 0) for v in m.values()) / 60, 1)}


@app.get("/api/ds/{name}/clip/{key}")
def ds_clip_get(name: str, key: str):
    p = ds_dir(name) / "wavs" / f"{Path(key).name}.wav"
    if not p.exists():
        raise HTTPException(404, "ไม่พบไฟล์")
    return FileResponse(p, media_type="audio/wav")


@app.delete("/api/ds/{name}/clip/{key}")
def ds_clip_del(name: str, key: str):
    d = ds_dir(name)
    (d / "wavs" / f"{Path(key).name}.wav").unlink(missing_ok=True)
    m = ds_meta(d)
    m.pop(key, None)
    ds_save_meta(d, m)
    return {"ok": True, "count": len(m)}


DSQC_CODE = """
import sys, json, wave, numpy as np, mlx_whisper
a = json.load(open(sys.argv[1])); out = {}
for k, p in a['files'].items():
    w = wave.open(p); sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        n = int(len(x) * 16000 / sr); x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    r = mlx_whisper.transcribe(x, path_or_hf_repo=a['model'], language='th', condition_on_previous_text=False)
    out[k] = r['text'].strip()
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
"""


def _cer(ref, hyp):
    norm = lambda t: re.sub(r"[\s.,!?\"'“”‘’()\-…ๆ]+", "", t)
    a, b = norm(ref), norm(hyp)
    if not a:
        return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for jx, cb in enumerate(b, 1):
            cur[jx] = min(prev[jx] + 1, cur[jx - 1] + 1, prev[jx - 1] + (ca != cb))
        prev = cur
    return prev[-1] / len(a)


def job_dsqc(jid, name, all_):
    j = JOBS[jid]
    d = ds_dir(name)
    m = ds_meta(d)
    todo = {k: str(d / "wavs" / f"{k}.wav") for k, v in m.items() if (all_ or not v.get("qc")) and (d / "wavs" / f"{k}.wav").exists()}
    j.update(state="running", msg=f"Whisper กำลังฟังตรวจ {len(todo)} ประโยค…", t0=time.time(), total=len(todo))
    if todo:
        with LOCK:
            heard = run_tool_script("whisper", DSQC_CODE, {"model": WHISPER_MODEL, "files": todo}, j)
        m = ds_meta(d)   # re-read: the user may have recorded more meanwhile
        for k, h in heard.items():
            if k in m:
                c = _cer(m[k]["text"], h)
                m[k]["qc"] = {"cer": round(c, 3), "ok": c <= 0.2, "heard": h}
        ds_save_meta(d, m)
    bad = [k for k, v in m.items() if v.get("qc") and not v["qc"]["ok"]]
    j.update(state="done", result={"checked": len(todo), "bad": bad}, msg=f"ตรวจแล้ว {len(todo)} · ต้องอัดใหม่ {len(bad)}",
             ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/ds/{name}/check")
def ds_check(name: str, all: int = Form(0)):
    jid = submit("dsqc", job_dsqc, (ds_dir(name).name, bool(all)), {"prompt": "ตรวจชุดเสียง " + name})
    return {"job": jid, "pos": queue_pos(jid)}


DSIMP_CODE = """
import sys, json, mlx_whisper
a = json.load(open(sys.argv[1]))
r = mlx_whisper.transcribe(a['wav'], path_or_hf_repo=a['model'], language='th', condition_on_previous_text=False, verbose=None)
segs = [{k: s.get(k) for k in ('start', 'end', 'text', 'avg_logprob', 'no_speech_prob', 'compression_ratio')} for s in r.get('segments', [])]
json.dump(segs, open(sys.argv[2], 'w'), ensure_ascii=False)
"""


def job_dsimport(jid, name, src):
    """A long recording of the user's own voice → sentence clips with Whisper's transcript as the label."""
    import numpy as np
    import librosa
    j = JOBS[jid]
    d = ds_dir(name)
    j.update(state="running", msg="แปลงไฟล์เสียง…", t0=time.time())
    wav16 = src + ".16k.wav"
    subprocess.run([ffmpeg_bin(), "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav16], capture_output=True, check=True)
    j["msg"] = "Whisper กำลังถอดเสียงและแบ่งประโยค… (ไฟล์ 1 ชม. ใช้หลายนาที)"
    with LOCK:
        segs = run_tool_script("whisper", DSIMP_CODE, {"model": WHISPER_MODEL, "wav": wav16}, j, timeout=4 * 3600)
    # merge very short neighbours, keep 1.5–12 s pieces that Whisper was confident about
    pieces, cur = [], None
    for sg in segs:
        t = (sg.get("text") or "").strip()
        if not t:
            continue
        if cur and sg["start"] - cur["end"] < 0.35 and (cur["end"] - cur["start"]) < 1.5 and (sg["end"] - cur["start"]) < 12:
            cur.update(end=sg["end"], text=cur["text"] + " " + t, lp=min(cur["lp"], sg.get("avg_logprob") or 0), ns=max(cur["ns"], sg.get("no_speech_prob") or 0))
            continue
        if cur:
            pieces.append(cur)
        cur = {"start": sg["start"], "end": sg["end"], "text": t, "lp": sg.get("avg_logprob") or 0, "ns": sg.get("no_speech_prob") or 0, "cr": sg.get("compression_ratio") or 1}
    if cur:
        pieces.append(cur)
    good = [p for p in pieces if 1.5 <= p["end"] - p["start"] <= 12 and p["lp"] > -0.7 and p["ns"] < 0.5 and p["cr"] < 2.4 and len(p["text"]) >= 4]
    j.update(msg=f"ตัดเป็นประโยค {len(good)} จาก {len(pieces)} ช่วง…", total=len(good), step=0)
    y, sr = librosa.load(src, sr=22050, mono=True)
    import soundfile as sf
    m = ds_meta(d)
    added, skipped = 0, len(pieces) - len(good)
    for n, p in enumerate(good):
        a, b = max(0, int((p["start"] - 0.08) * sr)), min(len(y), int((p["end"] + 0.12) * sr))
        tmp = src + f".seg{n}.wav"
        sf.write(tmp, y[a:b], sr, subtype="PCM_16")
        text = re.sub(r"\s+", " ", p["text"]).strip()
        key = ds_key(text)
        try:
            dur, warn, noise = ds_process(tmp, str(d / "wavs" / f"{key}.wav"))
            m[key] = {"text": text, "dur": dur, "noise": noise, "warn": warn, "t": int(time.time()), "src": "import",
                      "qc": {"ok": not warn, "cer": 0, "heard": text, "auto": True}}
            added += 1
        except Exception:  # noqa
            skipped += 1
        Path(tmp).unlink(missing_ok=True)
        j["step"] = n + 1
    ds_save_meta(d, m)
    for f in (src, wav16):
        Path(f).unlink(missing_ok=True)
    mins = round(sum(m[k]["dur"] for k in m if m[k].get("src") == "import") / 60, 1)
    j.update(state="done", result={"added": added, "skipped": skipped}, msg=f"เพิ่ม {added} ประโยค · ข้าม {skipped} (ไม่ชัด/สั้น/ยาวเกิน) · จากไฟล์รวม {mins} นาที",
             ms=round((time.time() - j["t0"]) * 1000))


@app.post("/api/ds/{name}/import")
async def ds_import(name: str, audio: UploadFile = File(...)):
    d = ds_dir(name)
    src = DATA / f"imp-{secrets.token_hex(4)}{Path(audio.filename or 'a.m4a').suffix or '.m4a'}"
    with open(src, "wb") as f:
        while True:
            chunk = await audio.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    jid = submit("dsimport", job_dsimport, (d.name, str(src)), {"prompt": "นำเข้าเสียงยาว → ชุดข้อมูล"})
    return {"job": jid, "pos": queue_pos(jid)}


def ds_settings(d):
    try:
        return {"auto": "off", "fast": True, **json.loads((d / "settings.json").read_text())}
    except Exception:  # noqa
        return {"auto": "off", "fast": True}


@app.post("/api/ds/{name}/settings")
def ds_settings_set(name: str, auto: str = Form(None), fast: int = Form(None)):
    d = ds_dir(name)
    st = ds_settings(d)
    if auto in ("off", "night", "now"):
        st["auto"] = auto
    if fast is not None:
        st["fast"] = bool(fast)
    (d / "settings.json").write_text(json.dumps(st))
    return st


def ds_good_count(d):
    return sum(1 for v in ds_meta(d).values() if not (v.get("qc") and not v["qc"].get("ok")) and v.get("dur", 0) <= 12)


def auto_train_loop():
    """Start/continue voice training by itself: first time at 300 good clips, then after every +100 clips."""
    while True:
        time.sleep(300)
        try:
            for sf_ in DS_ROOT.glob("*/settings.json") if DS_ROOT.exists() else []:
                d = sf_.parent
                st = ds_settings(d)
                if st["auto"] == "off" or (TRAIN.get(d.name) or {}).get("state") in ("running", "starting"):
                    continue
                if st["auto"] == "night" and not (0 <= datetime.now().hour < 6):
                    continue
                if any(x["state"] in ("queued", "running") for x in JOBS.values()):
                    continue   # don't fight the user's own work for the GPU
                good = ds_good_count(d)
                done = json.loads((d / "trained.json").read_text()).get("clips", 0) if (d / "trained.json").exists() else 0
                has = (MY_MODELS / d.name / "model.pth").exists()
                if (not has and good >= 300) or (has and good - done >= 100):
                    print(f"[auto-train] {d.name}: {good} clips (last {done})", flush=True)
                    TRAIN[d.name] = {"state": "starting", "msg": "เริ่มเทรนอัตโนมัติ…", "step": 0, "total": 8000, "resume": has, "auto": True}
                    threading.Thread(target=lambda n=d.name: _safe(train_worker, n, 8000 if not has else 3000, "mps" if torch_device() == "mps" else "cpu"), daemon=True).start()
        except Exception as e:  # noqa
            print("[auto-train]", e, flush=True)


threading.Thread(target=auto_train_loop, daemon=True).start()


BACKUP_DIRS = ("mymodels", "loras", "datasets", "lora-data")


@app.get("/api/backup")
def backup(t: str = ""):
    """One zip with everything the user made/trained (not the big downloadable base models)."""
    import zipfile
    out = Path(tempfile.mkdtemp(prefix="gm-bak-")) / f"GenMedi-backup-{datetime.now().strftime('%Y%m%d-%H%M')}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as z:
        for top in BACKUP_DIRS:
            base = DATA / top
            if not base.exists():
                continue
            for p in base.rglob("*"):
                rel = p.relative_to(DATA)
                if p.is_file() and not any(x in rel.parts for x in ("train", "data", "previews")) and p.suffix not in (".tmp",):
                    z.write(p, str(rel))
        for vf in VOICES.glob("*.wav"):
            if not vf.stem.startswith("_kt_"):
                z.write(vf, str(Path("voices") / vf.name))
    return FileResponse(out, media_type="application/zip", filename=out.name)


@app.post("/api/restore")
async def restore(file: UploadFile = File(...)):
    import zipfile
    tmp = DATA / f"restore-{secrets.token_hex(4)}.zip"
    with open(tmp, "wb") as f:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    n = 0
    try:
        with zipfile.ZipFile(tmp) as z:
            for info in z.infolist():
                parts = Path(info.filename).parts
                if info.is_dir() or not parts or parts[0] not in (*BACKUP_DIRS, "voices") or ".." in parts or info.filename.startswith("/"):
                    continue
                dst = (VOICES / parts[-1]) if parts[0] == "voices" else DATA.joinpath(*parts)
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(z.read(info))
                n += 1
    except zipfile.BadZipFile:
        raise HTTPException(400, "ไฟล์ไม่ใช่ zip สำรองของ Gen Medi")
    finally:
        tmp.unlink(missing_ok=True)
    _my.clear()
    return {"restored": n}


TRAIN = {}
MY_MODELS = DATA / "mymodels"
TRAIN_CODE = r"""
import os, sys, json, math
a = json.load(open(sys.argv[1]))
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch, librosa, soundfile as sf
from TTS.config import load_config
from TTS.tts.configs.shared_configs import BaseDatasetConfig
from TTS.tts.datasets import load_tts_samples
from TTS.tts.models.vits import Vits
from TTS.tts.utils.speakers import SpeakerManager
from trainer import Trainer, TrainerArgs

cfg = load_config(a["base_config"])
sr = cfg.audio.sample_rate
work = a["work"]
os.makedirs(work + "/wavs", exist_ok=True)
lines = []
for k, t in a["items"]:
    dst = f"{work}/wavs/{k}.wav"
    if not os.path.exists(dst):
        y, _ = librosa.load(f'{a["src"]}/{k}.wav', sr=sr)
        sf.write(dst, y, sr)
    lines.append(f"{k}|{t}")
open(work + "/metadata.csv", "w", encoding="utf8").write("\n".join(lines))
print("GMSTAGE prep", flush=True)

def fmt(root_path, meta_file, **kw):
    out = []
    for line in open(os.path.join(root_path, meta_file), encoding="utf8"):
        if "|" in line:
            k, t = line.rstrip("\n").split("|", 1)
            out.append({"text": t, "audio_file": os.path.join(root_path, "wavs", k + ".wav"), "speaker_name": a["speaker"], "language": "th-th", "root_path": root_path})
    return out

cfg.datasets = [BaseDatasetConfig(formatter="gm", dataset_name="gm", meta_file_train="metadata.csv", path=work, language="th-th")]
train, evals = load_tts_samples(cfg.datasets, eval_split=True, formatter=fmt, eval_split_size=max(4, min(24, len(lines) // 25)))

# d-vectors of the new speaker, added next to KhanomTan's own
dv = cfg.d_vector_file[0] if isinstance(cfg.d_vector_file, list) else cfg.d_vector_file
emb = torch.load(dv, map_location="cpu") if dv and os.path.exists(dv) else {}
sm = SpeakerManager(encoder_model_path=a["se_model"], encoder_config_path=a["se_config"], use_cuda=False)
for i, smp in enumerate(train + evals):
    e = sm.compute_embedding_from_clip(smp["audio_file"])
    emb[smp["audio_unique_name"]] = {"name": a["speaker"], "embedding": list(map(float, e))}
    if i % 25 == 0:
        print(f"GMSTAGE embed {i}/{len(train) + len(evals)}", flush=True)
torch.save(emb, work + "/speakers.pth")
cfg.d_vector_file = [work + "/speakers.pth"]
cfg.model_args.d_vector_file = [work + "/speakers.pth"]
cfg.model_args.use_d_vector_file = True
cfg.use_speaker_embedding = False
cfg.model_args.use_speaker_embedding = False

bs = a["batch"]
steps_ep = max(1, math.ceil(len(train) / bs))
cfg.epochs = max(1, math.ceil(a["steps"] / steps_ep))
cfg.output_path = work + "/run"
cfg.run_name = "gm"
cfg.batch_size = bs
cfg.eval_batch_size = 4
cfg.num_loader_workers = 0
cfg.num_eval_loader_workers = 0
cfg.mixed_precision = False
cfg.print_step = 10
cfg.save_step = a["save_step"]
cfg.save_n_checkpoints = 2
cfg.save_checkpoints = True
cfg.run_eval = True
cfg.test_delay_epochs = 10 ** 6
cfg.test_sentences = []
cfg.lr_gen = cfg.lr_disc = a["lr"]
cfg.print_eval = False
if a.get("fast"):
    # KhanomTan already reads Thai script — keep its text encoder fixed, learn the new voice + rhythm only (fewer weights → faster, needs less data)
    for k in ("freeze_encoder",):
        if hasattr(cfg.model_args, k):
            setattr(cfg.model_args, k, True)
    cfg.run_eval_steps = None
    if hasattr(cfg, "run_eval_steps"):
        cfg.run_eval_steps = 1000
print(f"GMSTAGE train total={cfg.epochs * steps_ep}", flush=True)

model = Vits.init_from_config(cfg, train + evals)
args = TrainerArgs(restore_path=a["ckpt"]) if not a.get("continue") else TrainerArgs(continue_path=a["continue"])
dev = a["device"]
if dev == "mps" and hasattr(args, "use_accelerate"):
    args.use_accelerate = True
trainer = Trainer(args, cfg, cfg.output_path, model=model, train_samples=train, eval_samples=evals)
try:
    print("GMSTAGE device " + str(next(trainer.model.parameters()).device), flush=True)
except Exception:
    pass
trainer.fit()
print("GMSTAGE done", flush=True)
"""


# held-out sentences (not in the recording list) — the supervisor makes each checkpoint read them, Whisper listens
EVAL_SENTENCES = [
    "พรุ่งนี้เช้าผมจะไปตลาดซื้อผักกับผลไม้",
    "ราคาสินค้าชิ้นนี้ลดเหลือสามร้อยเก้าสิบเก้าบาท",
    "ขอบคุณที่ติดตามนะครับ แล้วพบกันใหม่คลิปหน้า",
    "น้องหมาตัวนี้ขี้เล่นและชอบวิ่งไล่ลูกบอล",
    "ฝนตกหนักทั้งคืนจนน้ำท่วมถนนหน้าบ้าน",
    "เขาเดินทางไปทำงานด้วยรถไฟฟ้าทุกวัน",
    "ใครชอบกินเผ็ด ต้องลองเมนูนี้ให้ได้",
    "เสื้อตัวใหม่สีเขียวใส่สบายมาก",
    "คุณยายปลูกต้นมะม่วงไว้หลังบ้านหลายต้น",
    "ห้องประชุมอยู่ชั้นสิบสอง เลี้ยวซ้ายจากลิฟต์",
    "ไม่ว่าจะเหนื่อยแค่ไหน เราก็จะไม่ยอมแพ้",
    "หนังเรื่องนี้สนุกจนลืมดูเวลา",
]


def eval_checkpoint(name, ck, sm, ref_emb):
    """Score one checkpoint: intelligibility (1 − Whisper CER) and voice similarity (cosine of speaker embeddings)."""
    import numpy as np
    from TTS.utils.synthesizer import Synthesizer
    d, work = train_paths(name)
    out = work / "eval" / Path(ck).stem
    out.mkdir(parents=True, exist_ok=True)
    syn = Synthesizer(tts_checkpoint=ck, tts_config_path=str(Path(ck).parent / "config.json"), use_cuda=False)
    files = {}
    for i, t in enumerate(EVAL_SENTENCES):
        wav = syn.tts(t, speaker_name=d.name, language_name="th-th")
        f = out / f"{i}.wav"
        f.write_bytes(wav_bytes(wav, syn.output_sample_rate))
        files[str(i)] = str(f)
    del syn
    heard = run_tool_script("whisper", DSQC_CODE, {"model": WHISPER_MODEL, "files": files})
    cers = {int(k): _cer(EVAL_SENTENCES[int(k)], v) for k, v in heard.items()}
    emb = np.asarray(sm.compute_embedding_from_clip(list(files.values())), dtype=np.float32)
    sim = float(np.dot(emb, ref_emb) / (np.linalg.norm(emb) * np.linalg.norm(ref_emb) + 1e-9))
    cer = float(np.mean(list(cers.values()))) if cers else 1.0
    worst = sorted(cers.items(), key=lambda x: -x[1])[:4]
    return {"cer": round(cer, 3), "sim": round(sim, 3), "score": round((1 - min(cer, 1)) * 0.7 + max(sim, 0) * 0.3, 4),
            "weak": [{"text": EVAL_SENTENCES[i], "heard": heard.get(str(i), ""), "cer": round(c, 2)} for i, c in worst if c > 0.05]}


def train_supervisor(name, t):
    """Watches the run: evaluates every new checkpoint, keeps the best one as the live voice, stops early when it stops improving."""
    import glob
    import numpy as np
    from TTS.tts.utils.speakers import SpeakerManager
    d, work = train_paths(name)
    kt = Path(ensure_model("tts"))
    sm = SpeakerManager(encoder_model_path=str(kt / "model_se.pth"), encoder_config_path=str(kt / "config_se.json"), use_cuda=False)
    clips = sorted((d / "wavs").glob("*.wav"))
    ref = np.asarray(sm.compute_embedding_from_clip([str(c) for c in random.sample(clips, min(20, len(clips)))]), dtype=np.float32)
    seen = set()
    t.setdefault("evals", [])
    try:   # when continuing, the voice in use must only be replaced by something better
        prev = (json.loads((MY_MODELS / d.name / "meta.json").read_text()).get("score") or {}).get("score", 0)
    except Exception:  # noqa
        prev = 0
    while True:
        alive = t.get("proc") is not None and t["proc"].poll() is None
        cks = sorted(glob.glob(str(work / "run" / "**" / "checkpoint_*.pth"), recursive=True), key=os.path.getmtime)
        for ck in cks:
            if ck in seen:
                continue
            seen.add(ck)
            time.sleep(5)   # let the trainer finish writing
            step = int(re.search(r"checkpoint_(\d+)", ck).group(1))
            try:
                t["judge"] = f"AI กำลังให้คะแนนโมเดลขั้นที่ {step}…"
                r = eval_checkpoint(name, ck, sm, ref)
            except Exception as e:  # noqa
                print("[supervisor]", e, flush=True)
                t["judge"] = "ให้คะแนนไม่สำเร็จ: " + str(e)[:120]
                continue
            r["step"] = step
            t["evals"].append(r)
            best = max(t["evals"], key=lambda x: x["score"])
            t["weak"] = r["weak"]
            if best is r and r["score"] > prev:
                t["best"] = step
                try:
                    export_model(name, ck, step, r)
                except Exception as e:  # noqa
                    print("[supervisor] export", e, flush=True)
            t["judge"] = f"ขั้นที่ {step}: ชัด {round((1 - r['cer']) * 100)}% · เหมือนเสียงคุณ {round(r['sim'] * 100)}%" + (f" · ดีที่สุดคือขั้นที่ {t['best']}" if t.get("best") else " · ยังไม่ดีกว่าโมเดลเดิม")
            # early stop: 4 evaluations in a row without beating the best
            last = t["evals"][-4:]
            if len(t["evals"]) >= 6 and all(x["score"] < best["score"] for x in last) and alive:
                t["early"] = True
                t["judge"] += " · คะแนนไม่ดีขึ้นแล้ว — หยุดเอง"
                t["proc"].terminate()
        if not alive:
            break
        time.sleep(30)
    t["judging"] = False


def train_paths(name):
    d = ds_dir(name)
    return d, DATA / "training" / d.name


def latest_ckpt(work):
    import glob
    c = [p for p in glob.glob(str(work / "run" / "**" / "*.pth"), recursive=True) if Path(p).name.startswith(("checkpoint_", "best_model"))]
    return max(c, key=os.path.getmtime) if c else None


def train_worker(name, steps, device):
    d, work = train_paths(name)
    t = TRAIN[d.name]
    m = ds_meta(d)
    items = [(k, v["text"].replace("|", " ")) for k, v in m.items() if not (v.get("qc") and not v["qc"].get("ok")) and v.get("dur", 0) <= 12 and (d / "wavs" / f"{k}.wav").exists()]
    kt = Path(ensure_model("tts"))
    get_kt()   # writes the fixed KhanomTan config with absolute paths
    args = {"base_config": str(DATA / "khanomtan-config.json"), "ckpt": str(kt / "best_model.pth"), "se_model": str(kt / "model_se.pth"),
            "se_config": str(kt / "config_se.json"), "src": str(d / "wavs"), "work": str(work), "items": items, "speaker": d.name,
            "steps": steps, "batch": 16 if (RAM_GB or 16) >= 24 else 8, "save_step": 500, "lr": 1e-4, "device": device, "fast": ds_settings(d)["fast"]}
    prev = latest_ckpt(work) if t.get("resume") else None
    if prev:
        args["continue"] = str(Path(prev).parent)
    work.mkdir(parents=True, exist_ok=True)
    (work / "args.json").write_text(json.dumps(args, ensure_ascii=False))
    (work / "train.py").write_text(TRAIN_CODE)
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1", PYTHONUNBUFFERED="1")
    if device == "cpu":
        env["CUDA_VISIBLE_DEVICES"] = ""
        env["PYTORCH_MPS_DISABLE"] = "1"
    log = open(work / "train.log", "a", encoding="utf8")
    p = subprocess.Popen([sys.executable, str(work / "train.py"), str(work / "args.json")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, env=env, cwd=str(work))
    t.update(state="running", proc=p, device=device, clips=len(items), msg="เตรียมข้อมูล…", started=time.time(), judging=True)
    sup = threading.Thread(target=lambda: _safe(train_supervisor, name, t), daemon=True)
    sup.start()
    try:   # keep the Mac awake while training runs
        subprocess.Popen(["caffeinate", "-i", "-w", str(p.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa
        pass
    tail = []
    for line in p.stdout:
        log.write(line)
        tail = (tail + [line.rstrip()])[-40:]
        if "GMSTAGE embed" in line:
            t["msg"] = "วิเคราะห์ลักษณะเสียง " + line.split("embed", 1)[1].strip()
        elif "GMSTAGE device" in line:
            t["device"] = "GPU (MPS)" if "mps" in line else "CPU"
        elif "GMSTAGE train" in line:
            t["total"] = int(re.search(r"total=(\d+)", line).group(1))
            t["msg"] = "กำลังเทรน…"
        mm = re.search(r"GLOBAL_STEP:\s*(\d+)", line)
        if mm:
            t["step"] = int(mm.group(1))
            el = time.time() - t["started"]
            if t.get("total") and t["step"] > 20:
                t["eta"] = round(el / t["step"] * (t["total"] - t["step"]))
            t["msg"] = f"กำลังเทรน ขั้นที่ {t['step']}" + (f"/{t['total']}" if t.get("total") else "")
        ml = re.search(r"loss_1:\s*([\d.]+)", line) or re.search(r"\bloss:\s*([\d.]+)", line)
        if ml:
            t["loss"] = float(ml.group(1))
    p.wait()
    log.close()
    t["tail"] = tail[-12:]
    sup.join(timeout=900)   # let the supervisor score the last checkpoint
    t.pop("proc", None)
    if t.get("early"):
        t.update(state="done", msg=f"AI หยุดเทรนเองเพราะคะแนนไม่ดีขึ้นแล้ว — ใช้ตัวที่ดีที่สุด (ขั้นที่ {t.get('best')}) 🎉")
    elif t.get("stop"):
        t.update(state="stopped", msg="หยุดแล้ว — ใช้ checkpoint ล่าสุดได้")
    elif p.returncode == 0:
        t.update(state="done", msg="เทรนเสร็จแล้ว 🎉")
    elif device == "mps" and (t.get("step") or 0) < 5:
        print("[train] GPU (MPS) failed early — retrying on CPU", flush=True)
        t.update(msg="GPU ของ Mac เทรนไม่ได้ — เปลี่ยนไปใช้ CPU (ช้ากว่า)…", step=0)
        return train_worker(name, steps, "cpu")
    else:
        t.update(state="error", msg="เทรนไม่สำเร็จ: " + " | ".join(tail[-3:])[-300:])
    if p.returncode == 0 or t.get("stop"):
        (d / "trained.json").write_text(json.dumps({"clips": len(items), "t": int(time.time())}))
    if latest_ckpt(work) and not t.get("best"):
        try:
            export_model(name)
        except Exception as e:  # noqa
            print("[train] export", e, flush=True)


def export_model(name, ck=None, step=None, score=None):
    d, work = train_paths(name)
    ck = ck or latest_ckpt(work)
    if not ck:
        raise HTTPException(400, "ยังไม่มี checkpoint — รอให้เทรนถึงขั้นที่ 500 ก่อน")
    out = MY_MODELS / d.name
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy(ck, out / "model.pth")
    shutil.copy(Path(ck).parent / "config.json", out / "config.json")
    meta = {"name": d.name, "label": "🎓 เสียงไทยของฉัน" + ("" if d.name == "mine" else f" ({d.name})"), "ckpt": Path(ck).name,
            "step": step or TRAIN.get(d.name, {}).get("step"), "t": int(time.time()), "score": score and {k: score[k] for k in ("cer", "sim", "score")}}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    _my.pop(d.name, None)
    return meta


_my = {}


def get_my(name):
    name = Path(name).name
    out = MY_MODELS / name
    if not (out / "model.pth").exists():
        raise HTTPException(404, "ยังไม่มีโมเดลเสียงนี้ — เทรนก่อน")
    key = (out / "model.pth").stat().st_mtime
    if _my.get(name, (None,))[0] != key:
        from TTS.utils.synthesizer import Synthesizer
        _my[name] = (key, Synthesizer(tts_checkpoint=str(out / "model.pth"), tts_config_path=str(out / "config.json"), use_cuda=False))
    return _my[name][1], name


def my_speakers():
    out = []
    for m in sorted(MY_MODELS.glob("*/meta.json")) if MY_MODELS.exists() else []:
        try:
            j = json.loads(m.read_text())
            out.append({"id": "my:" + j["name"], "name": j["label"], "gender": None, "mine": True, "step": j.get("step")})
        except Exception:  # noqa
            pass
    return out


@app.post("/api/ds/{name}/train")
def ds_train(name: str, steps: int = Form(6000), resume: int = Form(0), device: str = Form("auto")):
    d = ds_dir(name)
    t = TRAIN.get(d.name)
    if t and t.get("state") == "running":
        raise HTTPException(409, "กำลังเทรนอยู่แล้ว")
    n = len([1 for v in ds_meta(d).values() if not (v.get("qc") and not v["qc"].get("ok"))])
    if n < 50:
        raise HTTPException(400, f"ข้อมูลน้อยเกินไป ({n} ประโยค) — ต้องมีอย่างน้อย 50 (แนะนำ 300+)")
    model_guard("tts")
    dev = device if device in ("mps", "cpu") else ("mps" if torch_device() == "mps" else "cpu")
    TRAIN[d.name] = {"state": "starting", "msg": "กำลังเริ่ม…", "step": 0, "total": steps, "resume": bool(resume)}
    threading.Thread(target=lambda: _safe(train_worker, d.name, int(steps), dev), daemon=True).start()
    return {"ok": True}


@app.post("/api/ds/{name}/train/stop")
def ds_train_stop(name: str):
    t = TRAIN.get(ds_dir(name).name) or {}
    p = t.get("proc")
    if p:
        t["stop"] = True
        p.terminate()
    return {"ok": True}


@app.post("/api/ds/{name}/export")
def ds_export(name: str):
    return export_model(name)


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

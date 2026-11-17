"""
AI Voice — Companion server (run on your Mac / PC, uses its GPU)

Gives the AI Voice app two things with no quota and no watermark:
  /clone_tts  : Thai voice cloning (F5-TTS-THAI, VYNCX/F5-TTS-THAI)
  /txt2img    : text-to-image (SD-Turbo by default; set IMAGE_MODEL to change)
  /info       : reports the hardware, so the app can estimate times

Start it with ./start-mac.sh (macOS) or:  python server.py
It prints an https link + QR code. Open it on your phone, or paste the link
into the app: Menu > ประมวลผล & สเปคเครื่อง > คอมของฉัน.
"""
import json
import os
import platform
import random
import re
import shutil
from datetime import datetime
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import gradio as gr
import torch

APP_URL = os.environ.get("APP_URL", "https://mengnattawitmarin.github.io/ai-voice/")
IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "stabilityai/sd-turbo")
PORT = int(os.environ.get("PORT", "7860"))
SHARE = os.environ.get("SHARE", "1") != "0"

if torch.cuda.is_available():
    DEVICE = "cuda"
elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"


def chip_name():
    try:
        if DEVICE == "cuda":
            return torch.cuda.get_device_name(0)
        if sys.platform == "darwin":
            return subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
        return platform.processor() or platform.machine()
    except Exception:
        return platform.machine()


def ram_gb():
    try:
        if sys.platform == "darwin":
            return round(int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) / 2**30)
        import psutil  # optional
        return round(psutil.virtual_memory().total / 2**30)
    except Exception:
        return None


STATS = {"tts_ms_per_char": None, "img_ms": None}

# ---------------- save folder (chosen on the Mac) ----------------
CONFIG = Path(__file__).with_name("config.json")


def load_cfg():
    try:
        return json.loads(CONFIG.read_text())
    except Exception:
        return {}


def save_cfg(cfg):
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))


def pick_folder_dialog():
    """Open the native macOS folder picker on this computer (someone at the Mac must click)."""
    if sys.platform != "darwin":
        return None
    script = 'POSIX path of (choose folder with prompt "เลือกโฟลเดอร์สำหรับเก็บภาพและเสียงจาก AI Voice")'
    try:
        subprocess.run(["osascript", "-e", 'tell application "System Events" to activate'], timeout=5)
        out = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=300)
        path = out.stdout.strip()
        return path.rstrip("/") or None
    except Exception:
        return None


cfg = load_cfg()
SAVE_DIR = os.environ.get("SAVE_DIR") or cfg.get("save_dir")
if "--choose-folder" in sys.argv or (not SAVE_DIR and sys.platform == "darwin" and __name__ == "__main__"):
    print("กำลังเปิดหน้าต่างเลือกโฟลเดอร์บน Mac …")
    SAVE_DIR = pick_folder_dialog() or SAVE_DIR
if not SAVE_DIR:
    SAVE_DIR = str(Path.home() / "Pictures" / "AI-Voice")
Path(SAVE_DIR).mkdir(parents=True, exist_ok=True)
cfg["save_dir"] = SAVE_DIR
save_cfg(cfg)

ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".m4a", ".ogg"}


def safe_name(name, ext):
    name = re.sub(r"[\\/:*?\"<>|\n\r\t]+", " ", name or "").strip()[:60] or "ai-voice"
    return f"{datetime.now().strftime('%H%M%S')} {name}{ext}"


def save_file(file, kind="images", name=""):
    """Copy a finished image/audio into the chosen folder: <folder>/<images|audio>/<YYYY-MM-DD>/"""
    if not file:
        raise gr.Error("no file")
    ext = Path(file).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise gr.Error("file type not allowed")
    if os.path.getsize(file) > 300 * 2**20:
        raise gr.Error("file too large")
    sub = "audio" if kind == "audio" else "images"
    day = Path(SAVE_DIR) / sub / datetime.now().strftime("%Y-%m-%d")
    day.mkdir(parents=True, exist_ok=True)
    dest = day / safe_name(name, ext)
    shutil.copyfile(file, dest)
    print(f"บันทึก: {dest}")
    return str(dest)


def choose_folder():
    global SAVE_DIR
    path = pick_folder_dialog()
    if path:
        SAVE_DIR = path
        Path(SAVE_DIR).mkdir(parents=True, exist_ok=True)
        cfg["save_dir"] = SAVE_DIR
        save_cfg(cfg)
    return SAVE_DIR

# ---------------- voice cloning ----------------
_tts = None


def get_tts():
    global _tts
    if _tts is None:
        from f5_tts_th.tts import TTS
        _tts = TTS(model="v1")
    return _tts


def clone_tts(ref_audio, ref_text, gen_text, speed=1.0):
    if not ref_audio:
        raise gr.Error("missing reference audio")
    if not (gen_text or "").strip():
        raise gr.Error("missing text")
    import soundfile as sf
    t0 = time.time()
    wav = get_tts().infer(
        ref_audio=ref_audio,
        ref_text=(ref_text or "").strip(),
        gen_text=gen_text.strip(),
        step=32,
        cfg=2.0,
        speed=float(speed or 1.0),
    )
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    sf.write(out, wav, 24000)
    STATS["tts_ms_per_char"] = round((time.time() - t0) * 1000 / max(1, len(gen_text)), 1)
    return out


# ---------------- text to image ----------------
_pipe = None


def get_pipe():
    global _pipe
    if _pipe is None:
        from diffusers import AutoPipelineForText2Image
        half = DEVICE in ("cuda", "mps")
        kw = {"torch_dtype": torch.float16 if half else torch.float32}
        try:
            _pipe = AutoPipelineForText2Image.from_pretrained(IMAGE_MODEL, variant="fp16" if half else None, **kw)
        except Exception:
            _pipe = AutoPipelineForText2Image.from_pretrained(IMAGE_MODEL, **kw)
        _pipe = _pipe.to(DEVICE)
        _pipe.set_progress_bar_config(disable=True)
        if DEVICE == "mps":
            _pipe.enable_attention_slicing()
    return _pipe


def txt2img(prompt, seed=0, width=512, height=512, steps=2):
    if not (prompt or "").strip():
        raise gr.Error("missing prompt")
    base = 1024 if "xl" in IMAGE_MODEL.lower() else 512
    w, h = float(width or base), float(height or base)
    scale = (base * base / (w * h)) ** 0.5  # keep ~native pixel count (fast + sharp)
    w = max(256, int(w * scale) // 64 * 64)
    h = max(256, int(h * scale) // 64 * 64)
    steps = max(1, min(4, int(steps or 2)))
    seed = int(seed) if seed not in (None, "") else random.randint(0, 2**31 - 1)
    t0 = time.time()
    g = torch.Generator("cpu").manual_seed(seed % (2**31 - 1))
    img = get_pipe()(prompt=prompt, num_inference_steps=steps, guidance_scale=0.0, width=w, height=h, generator=g).images[0]
    STATS["img_ms"] = round((time.time() - t0) * 1000)
    return img


def info():
    return json.dumps({
        "device": DEVICE,
        "chip": chip_name(),
        "ram_gb": ram_gb(),
        "os": platform.platform(),
        "image_model": IMAGE_MODEL,
        "save_dir": SAVE_DIR,
        "tts_loaded": _tts is not None,
        "img_loaded": _pipe is not None,
        **STATS,
    }, ensure_ascii=False)


with gr.Blocks(title="AI Voice Server") as demo:
    gr.Markdown(f"# AI Voice — Companion server\nDevice: **{DEVICE}** · {chip_name()}")
    with gr.Tab("Voice clone"):
        a = gr.Audio(type="filepath", label="ref_audio")
        rt = gr.Textbox(label="ref_text")
        gt = gr.Textbox(label="gen_text", lines=3)
        sp = gr.Slider(0.5, 2.0, value=1.0, step=0.05, label="speed")
        o = gr.Audio(label="output")
        gr.Button("Generate").click(clone_tts, [a, rt, gt, sp], o, api_name="clone_tts")
    with gr.Tab("Text to image"):
        p = gr.Textbox(label="prompt")
        s = gr.Number(value=0, label="seed", precision=0)
        wi = gr.Number(value=512, label="width", precision=0)
        he = gr.Number(value=512, label="height", precision=0)
        st = gr.Number(value=2, label="steps", precision=0)
        im = gr.Image(label="image", type="pil")
        gr.Button("Generate").click(txt2img, [p, s, wi, he, st], im, api_name="txt2img")
    with gr.Tab("Save"):
        f = gr.File(type="filepath", label="file")
        k = gr.Textbox(value="images", label="kind")
        n = gr.Textbox(label="name")
        saved = gr.Textbox(label="saved_path")
        gr.Button("Save").click(save_file, [f, k, n], saved, api_name="save_file")
        folder = gr.Textbox(label="folder")
        gr.Button("Choose folder on this Mac").click(choose_folder, None, folder, api_name="choose_folder")
    with gr.Tab("Info"):
        out = gr.Textbox(label="info")
        gr.Button("Refresh").click(info, None, out, api_name="info")


def print_link(url):
    link = f"{APP_URL}?server={url}"
    print("\n" + "=" * 64)
    print(" เปิดลิงก์นี้บนมือถือ/Mac เพื่อเชื่อมแอปกับเครื่องนี้:")
    print(" " + link)
    print(" หรือวางลิงก์เซิร์ฟเวอร์นี้ในแอป:  " + url)
    print("=" * 64)
    try:
        import qrcode
        q = qrcode.QRCode(border=1)
        q.add_data(link)
        q.print_ascii(invert=True)
    except Exception:
        pass
    print("(ปิดเซิร์ฟเวอร์: กด Ctrl+C)  ครั้งแรกจะดาวน์โหลดโมเดลหลาย GB\n")


if __name__ == "__main__":
    print(f"Device: {DEVICE} · {chip_name()} · RAM {ram_gb()} GB · image model {IMAGE_MODEL}")
    print(f"โฟลเดอร์เก็บงาน: {SAVE_DIR}   (เปลี่ยน: ./start-mac.sh --choose-folder หรือกดจากแอป)")
    demo.queue(default_concurrency_limit=1)
    _, local_url, share_url = demo.launch(server_name="0.0.0.0", server_port=PORT, share=SHARE, prevent_thread_lock=True, show_error=True)
    print_link((share_url or local_url).rstrip("/"))
    if not share_url:
        print("ไม่ได้เปิดลิงก์ https (share) — มือถือจะเชื่อมไม่ได้ ใช้ได้เฉพาะบน Mac เครื่องนี้")
    demo.block_thread()

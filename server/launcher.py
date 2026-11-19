"""Gen Medi for Mac — launcher (standard library only).

Started by the "Gen Medi.app" applet with the Python bundled inside the app.
First run: shows an install-progress page in the browser while it creates a
private Python environment and installs the AI libraries (no Terminal needed).
Then it starts the Gen Medi server and opens the app in the browser.
"""
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent            # .../Resources/genmedi
RES = HERE.parent                                  # .../Resources
WEB = Path(os.environ.get("GENMEDI_WEB", RES / "web"))
DATA = Path(os.environ.get("GENMEDI_DATA", Path.home() / "Library" / "Application Support" / "GenMedi"))
VENV = DATA / "venv"
REQ = HERE / "requirements-mac.txt"
PORT = int(os.environ.get("GENMEDI_PORT", "7861"))
LOG = DATA / "logs"
DATA.mkdir(parents=True, exist_ok=True)
LOG.mkdir(parents=True, exist_ok=True)

STATE = {"stage": "starting", "pct": 0, "log": [], "error": None, "ready": False}


def log(msg):
    msg = str(msg).rstrip()
    if not msg:
        return
    STATE["log"] = (STATE["log"] + [msg])[-40:]
    with open(LOG / "setup.log", "a", encoding="utf-8") as f:
        f.write(time.strftime("%H:%M:%S ") + msg + "\n")


def port_busy(p):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", p)) == 0


def req_hash():
    return hashlib.sha1(REQ.read_bytes() + sys.version.encode()).hexdigest()[:16]


def venv_py():
    return VENV / "bin" / "python"


def venv_ok():
    """The venv points at the Python inside the app — if the app was moved, rebuild it."""
    try:
        return subprocess.run([str(venv_py()), "-c", "import fastapi"], capture_output=True, timeout=60).returncode == 0
    except Exception:
        return False


def ready():
    m = VENV / ".genmedi-ready"
    ok = venv_py().exists() and m.exists() and m.read_text().strip() == req_hash() and venv_ok()
    if not ok and VENV.exists() and venv_py().exists() and not venv_ok():
        import shutil
        shutil.rmtree(VENV, ignore_errors=True)
    return ok


# ---------- tiny setup web page ----------
SETUP_HTML = """<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gen Medi — กำลังติดตั้ง</title><style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#070b22;color:#e8eaff;display:grid;place-items:center;min-height:100vh}
.c{width:min(560px,92vw)}h1{font-size:22px}.bar{height:12px;border-radius:9px;background:#1d2350;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#22d3ee,#7c5cff,#ec4899);transition:width .5s}
pre{background:#0d1233;border-radius:12px;padding:12px;font-size:12px;height:220px;overflow:auto;white-space:pre-wrap;color:#aab}
p{color:#aab;line-height:1.6}.err{color:#ff8a8a}</style>
<div class="c"><h1>🎬 Gen Medi — ติดตั้งครั้งแรก</h1>
<p id="st">กำลังเตรียม…</p><div class="bar"><i id="b"></i></div>
<p>ครั้งแรกจะดาวน์โหลดไลบรารี AI ประมาณ 2–3 GB (ใช้เวลา 5–20 นาทีตามความเร็วเน็ต) ครั้งต่อไปเปิดได้ทันที<br>ปิดหน้านี้ได้ — เปิดแอป Gen Medi อีกครั้งเพื่อกลับมาดู</p>
<pre id="lg"></pre></div>
<script>
async function tick(){
  try{
    const r = await fetch('/status',{cache:'no-store'}); const s = await r.json();
    if (s.app){ waitApp(); return; }
    document.getElementById('st').textContent = s.stage + (s.error ? '' : ' (' + s.pct + '%)');
    if (s.error){ document.getElementById('st').innerHTML = '<span class="err">ติดตั้งไม่สำเร็จ: ' + s.error + '</span><br>ลองเปิดแอปใหม่อีกครั้ง (ต้องต่ออินเทอร์เน็ต)'; }
    document.getElementById('b').style.width = s.pct + '%';
    const lg = document.getElementById('lg'); lg.textContent = s.log.join('\\n'); lg.scrollTop = 1e9;
  }catch(e){ waitApp(); return; }
  setTimeout(tick, 1000);
}
async function waitApp(){
  document.getElementById('st').textContent = 'กำลังเปิดแอป…';
  try{ const r = await fetch('/api/ping',{cache:'no-store'}); if (r.ok){ location.href = '/'; return; } }catch(e){}
  setTimeout(waitApp, 1500);
}
tick();
</script></html>"""


class SetupHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/status"):
            body = json.dumps(STATE, ensure_ascii=False).encode()
            ctype = "application/json"
        else:
            body = SETUP_HTML.encode()
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def run(cmd, stage, p0, p1, expect_lines=200):
    """Run a command, stream its output into the setup log, move the progress bar from p0 to p1."""
    STATE["stage"] = stage
    log("$ " + " ".join(str(c) for c in cmd)[:300])
    proc = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    n = 0
    for line in proc.stdout:
        n += 1
        if any(k in line for k in ("Collecting", "Downloading", "Installing", "Successfully", "ERROR", "error:")):
            log(line)
        STATE["pct"] = int(p0 + (p1 - p0) * min(0.98, n / expect_lines))
    if proc.wait() != 0:
        raise RuntimeError(f"{stage} failed (see {LOG / 'setup.log'})")
    STATE["pct"] = p1


def install():
    try:
        if not venv_py().exists():
            run([sys.executable, "-m", "venv", VENV], "สร้างสภาพแวดล้อม Python", 0, 5, 5)
        pip = [venv_py(), "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"]
        run(pip + ["-U", "pip", "wheel", "setuptools"], "อัปเดตตัวติดตั้ง", 5, 8, 20)
        run(pip + ["-r", REQ], "ติดตั้งไลบรารี AI (นานที่สุด)", 8, 92, 420)
        run(pip + ["--no-deps", "git+https://github.com/myshell-ai/OpenVoice.git"], "ติดตั้ง OpenVoice (โคลนเสียง)", 92, 98, 15)
        (VENV / ".genmedi-ready").write_text(req_hash())
        STATE.update(stage="ติดตั้งเสร็จแล้ว กำลังเปิดแอป…", pct=100, ready=True)
    except Exception as e:  # noqa
        STATE["error"] = str(e)
        log("ERROR " + str(e))


def start_server():
    env = dict(os.environ)
    env.update({
        "GENMEDI_WEB": str(WEB), "GENMEDI_DATA": str(DATA), "GENMEDI_PORT": str(PORT),
        "GENMEDI_BIN": str(RES / "bin"), "HF_HOME": str(DATA / "hf"), "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    out = open(LOG / "server.log", "a")
    return subprocess.Popen([str(venv_py()), str(HERE / "genmedi_server.py")], env=env, stdout=out, stderr=subprocess.STDOUT, cwd=str(DATA))


def wait_port(p, sec=180):
    t = time.time()
    while time.time() - t < sec:
        if port_busy(p):
            return True
        time.sleep(0.5)
    return False


def main():
    if port_busy(PORT):  # already running → just show it
        webbrowser.open(f"http://localhost:{PORT}/")
        return
    setup = None
    if not ready():
        setup = ThreadingHTTPServer(("127.0.0.1", PORT), SetupHandler)
        threading.Thread(target=setup.serve_forever, daemon=True).start()
        webbrowser.open(f"http://localhost:{PORT}/")
        install()
        if STATE["error"]:
            while True:  # keep showing the error until the user quits the app
                time.sleep(3600)
        STATE["app"] = True
        time.sleep(2.5)
        setup.shutdown()
        setup.server_close()
    child = start_server()

    def stop(*_):
        try:
            child.terminate()
            child.wait(10)
        except Exception:
            child.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if wait_port(PORT) and not setup:
        webbrowser.open(f"http://localhost:{PORT}/")
    child.wait()


if __name__ == "__main__":
    main()

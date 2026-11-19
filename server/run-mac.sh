#!/bin/bash
# Gen Medi for Mac — run from Terminal (one command):
#   curl -fsSL https://raw.githubusercontent.com/mengnattawitmarin/ai-voice/main/server/run-mac.sh | bash
set -e
DIR="$HOME/GenMedi"
echo "== Gen Medi for Mac (Terminal) =="
[ "$(uname -m)" = "arm64" ] || echo "⚠️  ต้องใช้ Mac ชิป Apple (M1 ขึ้นไป)"
if command -v uv >/dev/null 2>&1; then UV=$(command -v uv); elif [ -x "$HOME/.local/bin/uv" ]; then UV="$HOME/.local/bin/uv"; else
  echo "• ติดตั้ง uv (ตัวจัดการ Python)"; curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; UV="$HOME/.local/bin/uv"; fi
mkdir -p "$DIR/bin"; cd "$DIR"
echo "• ดาวน์โหลดโค้ดล่าสุดของ Gen Medi"
curl -fsSL https://github.com/mengnattawitmarin/ai-voice/archive/refs/heads/main.zip -o app.zip
rm -rf app ai-voice-main && unzip -q app.zip && mv ai-voice-main app && rm -f app.zip
if [ ! -x bin/cloudflared ]; then
  echo "• ดาวน์โหลด cloudflared (ลิงก์ให้มือถือสั่งงาน)"
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar -xz -C bin; chmod +x bin/cloudflared
fi
echo "• เตรียม Python 3.11"
"$UV" python install 3.11 >/dev/null 2>&1 || true
PY=$("$UV" python find 3.11)
echo "• เริ่ม Gen Medi (ครั้งแรกจะติดตั้งไลบรารี AI ~2–3 GB ใช้เวลา 5–20 นาที)"
cd app/server
GENMEDI_WEB="$DIR/app" GENMEDI_BIN="$DIR/bin" exec "$PY" launcher.py

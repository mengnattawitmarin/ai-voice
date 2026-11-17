#!/bin/bash
# AI Voice companion server for macOS (Apple Silicon uses the GPU via Metal/MPS)
set -e
cd "$(dirname "$0")"

PY=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "ต้องใช้ Python 3.10 ขึ้นไป — ติดตั้งด้วย:  brew install python@3.11"
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "แนะนำให้ติดตั้ง ffmpeg ก่อน:  brew install ffmpeg"
fi

if [ ! -d .venv ]; then
  echo "สร้าง virtualenv ด้วย $PY ..."
  "$PY" -m venv .venv
fi
source .venv/bin/activate
python -m pip install -q -U pip
echo "ติดตั้งไลบรารี (ครั้งแรกใช้เวลาหลายนาที) ..."
python -m pip install -q -r requirements.txt

export PYTORCH_ENABLE_MPS_FALLBACK=1
python server.py "$@"

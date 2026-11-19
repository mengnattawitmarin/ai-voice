#!/bin/bash
# Developer start (from a git checkout). Normal users: download GenMedi-mac.dmg instead — no Terminal needed.
cd "$(dirname "$0")"
PY=$(command -v python3.11 || command -v python3)
GENMEDI_WEB="$(cd .. && pwd)" exec "$PY" launcher.py

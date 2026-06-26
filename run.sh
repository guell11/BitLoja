#!/usr/bin/env sh
set -eu
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
python -m pip install -r requirements.txt
: "${CUSTODY_MODE:=demo}"
: "${LN_MODE:=demo}"
export CUSTODY_MODE LN_MODE
python app.py

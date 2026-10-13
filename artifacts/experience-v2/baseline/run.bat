@echo off
setlocal
if not exist .venv (
  py -m venv .venv
)
call .venv\Scripts\activate
python -m pip install -r requirements.txt
if "%CUSTODY_MODE%"=="" set CUSTODY_MODE=demo
if "%LN_MODE%"=="" set LN_MODE=demo
python app.py

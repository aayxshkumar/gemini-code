@echo off
rem Starts the desktop app with no console window. Run setup.ps1 once first.
set "PYTHONW=%USERPROFILE%\.gemini-code\ui-venv\Scripts\pythonw.exe"
if not exist "%PYTHONW%" (
    echo The app isn't set up yet. Run: powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
    pause
    exit /b 1
)
cd /d "%~dp0"
start "" "%PYTHONW%" -m gemini_code_ui

@echo off
:loop
python F:\github\dsh-pet-desktop\voice\asr_server.py
echo [watchdog] asr exited, restart in 3s...
timeout /t 3 /nobreak >nul
goto loop

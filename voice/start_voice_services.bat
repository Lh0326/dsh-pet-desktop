@echo off
rem 小乖语音双服务一键启动(ASR 9340 + 唤醒 9341)
cd /d F:\github\dsh-pet-desktop\voice
start "xg-asr" /min python asr_server.py
start "xg-wake" /min python wake_server.py
echo voice services starting...

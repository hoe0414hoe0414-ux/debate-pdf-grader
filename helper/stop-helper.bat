@echo off
rem Debate PDF Grader - stop grading helper and remove autostart
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0helper\install-autostart.ps1" -Root "%~dp0." -Remove
timeout /t 5

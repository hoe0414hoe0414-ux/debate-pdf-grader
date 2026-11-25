@echo off
rem Debate PDF Grader - install grading helper: desktop shortcut opens the app and starts the helper hidden
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0helper\install-launcher.ps1" -Root "%~dp0."
timeout /t 8

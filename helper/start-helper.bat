@echo off
rem Debate PDF Grader - install grading helper: run hidden now and at every Windows sign-in
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0helper\install-autostart.ps1" -Root "%~dp0."
timeout /t 8

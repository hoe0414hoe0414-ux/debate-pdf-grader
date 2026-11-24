@echo off
rem Debate PDF Grader - grading helper (watches this folder and grades with Claude Code)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0helper\grading-helper.ps1"
pause

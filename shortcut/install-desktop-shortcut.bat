@echo off
rem Debate PDF Grader - desktop shortcut installer (Windows)
rem Creates (or refreshes) a Desktop shortcut that opens the web app in your default browser.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://hoe0414hoe0414-ux.github.io/debate-pdf-grader/';$n=-join([char[]]@(53664,47200,32,80,68,70,32,52292,51216,44592));$d=[Environment]::GetFolderPath('Desktop');$dir=Join-Path $env:LOCALAPPDATA 'DebatePdfGrader';New-Item -ItemType Directory -Force -Path $dir | Out-Null;$ico=Join-Path $dir 'icon-v2.ico';try{[Net.ServicePointManager]::SecurityProtocol='Tls12';Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/hoe0414hoe0414-ux/debate-pdf-grader/main/assets/favicon.ico' -OutFile $ico}catch{};$old=Join-Path $d ($n+'.url');if(Test-Path $old){Remove-Item $old -Force};$f=Join-Path $d ($n+'.lnk');if(Test-Path $f){Remove-Item $f -Force};$s=(New-Object -ComObject WScript.Shell).CreateShortcut($f);$s.TargetPath=(Join-Path $env:WINDIR 'explorer.exe');$s.Arguments=$u;$s.IconLocation=$ico+',0';$s.Description=$n;$s.Save();try{ie4uinit.exe -show}catch{};Write-Host ('OK: '+$f)"
echo.
echo Desktop shortcut created. You can close this window.
pause

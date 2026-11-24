@echo off
rem Debate PDF Grader - desktop shortcut installer (Windows)
rem Creates a shortcut on your Desktop that opens the web app.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='https://hoe0414hoe0414-ux.github.io/debate-pdf-grader/';$n=-join([char[]]@(53664,47200,32,80,68,70,32,52292,51216,44592));$d=[Environment]::GetFolderPath('Desktop');$dir=Join-Path $env:LOCALAPPDATA 'DebatePdfGrader';New-Item -ItemType Directory -Force -Path $dir | Out-Null;$ico=Join-Path $dir 'icon.ico';try{[Net.ServicePointManager]::SecurityProtocol='Tls12';Invoke-WebRequest -UseBasicParsing ($u+'assets/favicon.ico') -OutFile $ico}catch{};$f=Join-Path $d ($n+'.url');$nl=[string][char]13+[char]10;$t='[InternetShortcut]'+$nl+'URL='+$u+$nl+'IconIndex=0'+$nl+'IconFile='+$ico+$nl;[IO.File]::WriteAllText($f,$t,[Text.Encoding]::Default);Write-Host ('OK: '+$f)"
echo.
echo Desktop shortcut created. You can close this window.
pause

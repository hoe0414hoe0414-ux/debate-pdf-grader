# 채점 도우미 자동 실행 등록 (관리자 권한 필요 없음)
#  - 시작프로그램 폴더에 숨김 실행 파일(.vbs)을 넣어 PC를 켤 때마다 창 없이 켜지게 하고
#  - 지금 바로 백그라운드로 켠다.
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [switch]$Remove)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ps1 = Join-Path $Root 'helper\grading-helper.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup '토론PDF채점도우미.vbs'
function Stop-Helper {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*grading-helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($Remove) {
  Stop-Helper
  Remove-Item $vbs -ErrorAction SilentlyContinue
  Write-Host '채점 도우미를 끄고, PC 시작 시 자동 실행도 해제했어요.' -ForegroundColor Green
  exit
}
if (-not (Test-Path $ps1)) { Write-Host "도우미 파일이 없어요: $ps1" -ForegroundColor Red; exit 1 }
$cmd = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $ps1 + '""'
$text = "Set s = CreateObject(""WScript.Shell"")`r`ns.Run ""$cmd"", 0, False`r`n"
[IO.File]::WriteAllText($vbs, $text, [Text.Encoding]::Unicode)   # 한글 경로를 위해 UTF-16
Stop-Helper   # 예전 버전이 돌고 있으면 새 버전으로 바꿔 켬
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code(claude 명령)를 찾지 못했어요. https://claude.com/claude-code 에서 설치·로그인해 주세요.' -ForegroundColor Yellow
}
Write-Host '완료: 채점 도우미가 백그라운드에서 켜졌고, 앞으로 PC를 켤 때마다 자동으로 켜져요.' -ForegroundColor Green
Write-Host '이 창은 닫아도 돼요. (끄려면 ‘채점 도우미 끄기.bat’)'

# 바탕화면 ‘토론 PDF 채점 판독기’ 바로가기를 “프로그램 + 채점 도우미 함께 켜기”로 바꾼다 (관리자 권한 필요 없음)
#  - 바로가기를 누르면: 채점 도우미가 창 없이(백그라운드) 켜지고, 채점 판독기 웹 프로그램이 열린다.
#  - 프로그램 창을 닫으면 도우미도 같이 꺼진다 (채점 중이면 끝날 때까지 기다림).
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [switch]$Remove)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$url = 'https://hoe0414hoe0414-ux.github.io/debate-pdf-grader/'
$name = '토론 PDF 채점기'
$ps1 = Join-Path $Root 'helper\grading-helper.ps1'
$vbs = Join-Path $Root 'helper\launch.vbs'
$desk = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desk ($name + '.lnk')
$icoDir = Join-Path $env:LOCALAPPDATA 'DebatePdfGrader'
$ico = Join-Path $icoDir 'icon-v2.ico'
function Stop-Helper {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*grading-helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
# 바로가기 만들기: 새 바로가기를 임시 이름으로 먼저 만든 뒤 바꿔 끼운다 → 도중에 실패해도 기존 아이콘이 사라지지 않음
# (주의: $args 는 PowerShell 예약 변수라 매개변수 이름으로 쓰면 안 됨 — 예전 버전에서 이 때문에 아이콘이 지워짐)
function Make-Shortcut([string]$target, [string]$arguments) {
  New-Item -ItemType Directory -Force -Path $icoDir | Out-Null
  if (-not (Test-Path $ico)) { try { [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/hoe0414hoe0414-ux/debate-pdf-grader/main/assets/favicon.ico' -OutFile $ico } catch {} }
  $tmp = Join-Path $desk ($name + '.new.lnk')
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)
  $s.TargetPath = $target
  $s.Arguments = $arguments
  if (Test-Path $ico) { $s.IconLocation = "$ico,0" }
  $s.Description = $name
  $s.Save()
  Move-Item -LiteralPath $tmp -Destination $lnk -Force
  Remove-Item (Join-Path $desk ($name + '.url')) -ErrorAction SilentlyContinue
}
# 예전 방식(PC 시작 시 자동 실행)은 지운다
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) '토론PDF채점도우미.vbs') -ErrorAction SilentlyContinue

if ($Remove) {
  Stop-Helper
  try { Make-Shortcut (Join-Path $env:WINDIR 'explorer.exe') $url } catch { Write-Host "바로가기를 되돌리지 못했어요: $($_.Exception.Message)" -ForegroundColor Red }
  Write-Host '채점 도우미를 껐어요. 바탕화면 바로가기는 프로그램만 여는 원래 방식으로 돌렸어요.' -ForegroundColor Green
  exit
}
if (-not (Test-Path $ps1)) { Write-Host "도우미 파일이 없어요: $ps1" -ForegroundColor Red; exit 1 }
$cmd = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $ps1 + '""'
$text = "Set s = CreateObject(""WScript.Shell"")`r`n" +
        "s.Run ""$cmd"", 0, False`r`n" +
        "If WScript.Arguments.Count = 0 Then s.Run ""$url""`r`n"
[IO.File]::WriteAllText($vbs, $text, [Text.Encoding]::Unicode)   # 한글 경로를 위해 UTF-16
try {
  Make-Shortcut (Join-Path $env:WINDIR 'System32\wscript.exe') ('"' + $vbs + '"')
} catch {
  Write-Host "바로가기를 바꾸지 못했어요: $($_.Exception.Message)" -ForegroundColor Red
  if (-not (Test-Path $lnk)) { try { Make-Shortcut (Join-Path $env:WINDIR 'explorer.exe') $url } catch {} }  # 아이콘만은 꼭 남긴다
}
try { ie4uinit.exe -show } catch {}
Stop-Helper   # 예전 버전이 돌고 있으면 새 버전으로
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`" nobrowser" -WindowStyle Hidden
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code(claude 명령)를 찾지 못했어요. https://claude.com/claude-code 에서 설치·로그인해 주세요.' -ForegroundColor Yellow
}
Write-Host "완료: 바탕화면 ‘$name’을 열면 채점 도우미가 백그라운드에서 같이 켜지고, 프로그램을 닫으면 같이 꺼져요. (지금도 켜 두었어요)" -ForegroundColor Green
Write-Host '이 창은 닫아도 돼요.'

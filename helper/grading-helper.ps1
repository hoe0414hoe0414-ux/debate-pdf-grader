# 채점 도우미: 이 폴더의 채점요청을 지켜보다가 Claude Code(구독 로그인)로 채점합니다.
# 바탕화면 ‘토론 PDF 채점기’ 바로가기로 프로그램을 열면 창 없이(백그라운드) 같이 켜집니다. (설정: ‘채점 도우미 켜기.bat’ 한 번)
# 프로그램 창을 닫으면 같이 꺼집니다(채점 중이면 끝난 뒤). 바로 끄기: ‘채점 도우미 끄기.bat’
$ErrorActionPreference = 'Continue'
# 이미 켜져 있으면 하나만 돌도록
$mutex = New-Object Threading.Mutex($false, 'Local\DebatePdfGraderHelper')
if (-not $mutex.WaitOne(0)) { exit }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root '채점요청'))) { $root = $PSScriptRoot }
$req = Join-Path $root '채점요청'
New-Item -ItemType Directory -Force -Path $req | Out-Null
$claude = Get-Command claude -ErrorAction SilentlyContinue
function Write-Json($path, $obj) { [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false)) }
Write-Host "채점 도우미 시작: $req"
if (-not $claude) { Write-Host "Claude Code(claude 명령)를 찾지 못했어요. https://claude.com/claude-code 에서 설치·로그인한 뒤 다시 켜 주세요." -ForegroundColor Yellow }
$started = (Get-Date).AddSeconds(-5)
while ($true) {
  # 프로그램(브라우저)이 열려 있는 동안 채점요청/app.json 을 자주 고친다.
  #  창을 닫으면 closed=true 를 남기거나(새로고침은 곧 다시 신호가 오므로 25초 기다림) 소식이 3분 끊김 → 도우미도 끈다.
  #  처음 켤 때는 프로그램이 폴더를 다시 허용받을 때까지 10분 기다려 준다.
  $af = Join-Path $req 'app.json'
  $appAt = $null; $closed = $false
  if (Test-Path $af) {
    $appAt = (Get-Item $af).LastWriteTime
    try { $closed = [bool]((Get-Content $af -Raw -Encoding UTF8 | ConvertFrom-Json).closed) } catch {}
  }
  $now = Get-Date
  $gone = if ($appAt -and $appAt -gt $started) { ($closed -and ($now - $appAt).TotalSeconds -gt 25) -or (($now - $appAt).TotalMinutes -gt 3) } else { ($now - $started).TotalMinutes -gt 10 }
  if ($gone) { Write-Host '프로그램이 닫혀 도우미도 끕니다.'; Remove-Item (Join-Path $req 'helper.json') -ErrorAction SilentlyContinue; break }
  Write-Json (Join-Path $req 'helper.json') @{ at = (Get-Date).ToString('o'); claude = [bool]$claude; error = $(if ($claude) { $null } else { 'Claude Code가 설치되어 있지 않아요' }) }
  if ($claude) {
    Get-ChildItem -Path $req -Directory | Sort-Object Name | ForEach-Object {
      $d = $_.FullName
      if ((Test-Path "$d\request.json") -and -not (Test-Path "$d\result.json") -and -not (Test-Path "$d\.running") -and -not (Test-Path "$d\.failed")) {
        New-Item -ItemType File -Path "$d\.running" | Out-Null
        Write-Json "$d\status.json" @{ state = 'grading'; message = 'Claude가 채점을 시작했어요' }
        Write-Host "[$(Get-Date -Format HH:mm:ss)] 채점 시작: $($_.Name)"
        Push-Location $d
        $prompt = '이 폴더의 GRADING.md 지침을 정확히 따라 request.json 의 PDF를 채점하고 result.json 을 쓰세요. 진행 상황은 status.json 에 쓰세요. 이 폴더 밖의 파일은 건드리지 마세요.'
        & claude -p $prompt --permission-mode acceptEdits --allowedTools "Read" "Write" "Edit" "Glob" "Grep" "Bash(python:*)" "Bash(py:*)" *>&1 | Tee-Object -FilePath "$d\claude.log"
        Pop-Location
        Remove-Item "$d\.running" -ErrorAction SilentlyContinue
        if (Test-Path "$d\result.json") { Write-Json "$d\status.json" @{ state = 'done' }; Write-Host "  → 완료" -ForegroundColor Green }
        else { New-Item -ItemType File -Path "$d\.failed" | Out-Null; Write-Json "$d\status.json" @{ state = 'error'; message = 'result.json 이 만들어지지 않았어요 (claude.log 확인)' }; Write-Host "  → 실패 (claude.log 확인)" -ForegroundColor Red }
      }
    }
  }
  Start-Sleep -Seconds 3
}

# Windows version of codex-agent.sh (PowerShell 5.1+ or 7). Use the Codex CLI as a one-shot agent: start `codex exec`, give it one
# task, wait, print its final message, let it exit. Nothing stays running.
#
#   .\codex-agent.ps1 [-Dir DIR] [-Model MODEL] [-Sandbox read-only|workspace-write] [-Seconds N] [-OutFile FILE] [-Watch (ignored: a window always opens)] [-Image PATH,...] "the task"
# Prints the final message on stdout; exits 1 if there is none or it timed out. Read-only sandbox by default, session not kept (--ephemeral).
# UNTESTED on a real Windows machine: written alongside codex-agent.sh, check it before relying on it.
param(
  [string]$Dir = (Get-Location).Path, [string]$Model = '', [string]$Sandbox = 'read-only', [int]$Seconds = 600,
  [string]$OutFile = '', [switch]$Watch, [string[]]$Image = @(),
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Task
)
$ErrorActionPreference = 'Stop'
if (-not $Task) { Write-Error 'give the task'; exit 2 }
$taskText = $Task -join ' '
if ($Sandbox -notin 'read-only', 'workspace-write') { Write-Error "invalid sandbox: $Sandbox (use read-only or workspace-write)"; exit 2 }
if ($Model -and $Model -notmatch '^[A-Za-z0-9._:/-]+$') { Write-Error "invalid model name: $Model"; exit 2 }
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { Write-Error "no such folder: $Dir"; exit 2 }
$Dir = (Resolve-Path -LiteralPath $Dir).Path
foreach ($i in $Image) { if (-not (Test-Path -LiteralPath $i -PathType Leaf)) { Write-Error "no such image: $i"; exit 2 } }

# Windows PowerShell 5.1 joins an argument array without quoting, so quote each argument for CreateProcess ourselves.
function Quote($a) { if ($a -notmatch '[\s"]' -and $a -ne '') { return $a }; '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('codex-agent-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$last = Join-Path $work 'last.txt'; $out = Join-Path $work 'stdout.txt'; $err = Join-Path $work 'stderr.txt'
try {
  $a = @('exec', '--skip-git-repo-check', '--ephemeral', '-s', $Sandbox, '-C', $Dir, '-o', $last)
  if ($Model) { $a += @('-m', $Model) }
  foreach ($i in $Image) { $a += @('-i', (Resolve-Path -LiteralPath $i).Path) }
  $a += @('--', $taskText)
  '' | Set-Content -LiteralPath $err
  if ($true) { # always show a window: no headless runs
    $w = "Write-Host 'codex-agent: working...'; Get-Content -LiteralPath '$err' -Wait"
    Start-Process powershell -ArgumentList '-NoProfile', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($w))) | Out-Null
  }
  $p = Start-Process codex -ArgumentList (($a | ForEach-Object { Quote $_ }) -join ' ') -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit($Seconds * 1000)) { try { & taskkill /PID $p.Id /T /F | Out-Null } catch {} }
  if (-not (Test-Path -LiteralPath $last) -or (Get-Item -LiteralPath $last).Length -eq 0) {
    $tail = try { (Get-Content -Raw -LiteralPath $err) } catch { '' }
    if ($tail.Length -gt 400) { $tail = $tail.Substring($tail.Length - 400) }
    [Console]::Error.WriteLine("codex returned no final message (timed out after ${Seconds}s or failed). stderr: $tail")
    exit 1
  }
  if ($OutFile) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent ([IO.Path]::GetFullPath($OutFile))) | Out-Null; Copy-Item -LiteralPath $last -Destination $OutFile -Force }
  Get-Content -Raw -LiteralPath $last
} finally {
  Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}

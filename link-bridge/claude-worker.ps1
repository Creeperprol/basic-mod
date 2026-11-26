# Windows version of claude-worker.sh (PowerShell 5.1+ or 7): open a Claude Code window as a link-bridge worker, for another CLI (agy, Codex) to call.
#   .\claude-worker.ps1 [-Dir DIR] [-Model MODEL] [-Name NAME] [-Extra "first task"] [-DryRun]
# Always a visible window (no headless mode). Claude Code must already trust the folder (~/.claude.json is only read).
# Checked under PowerShell 7 on macOS (parsing, dry run, trust check); window opening needs a real Windows machine.
param([string]$Dir = (Get-Location).Path, [string]$Model = '', [string]$Name = ('claude-' + [guid]::NewGuid().ToString('N').Substring(0, 4)), [string]$Extra = '', [switch]$DryRun)
$ErrorActionPreference = 'Stop'
if ($Model -and $Model -notmatch '^[A-Za-z0-9._:\[\]-]+$') { Write-Error "invalid model name: $Model"; exit 2 }
if ($Name -notmatch '^[A-Za-z0-9_-]+$') { Write-Error "invalid name: $Name"; exit 2 }
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { Write-Error "no such folder: $Dir"; exit 2 }
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$cfg = if ($env:CLAUDE_JSON) { $env:CLAUDE_JSON } else { Join-Path $HOME '.claude.json' }
$norm = { param($p) ($p -replace '\\', '/').TrimEnd('/').ToLowerInvariant() }
$trusted = $true
try {
  $j = Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json
  $ok = @($j.projects.PSObject.Properties | Where-Object { $_.Value.hasTrustDialogAccepted -eq $true } | ForEach-Object { & $norm $_.Name })
  $cur = & $norm $Dir; $trusted = $false
  while ($cur) { if ($ok -contains $cur) { $trusted = $true; break }; $up = $cur -replace '/[^/]*$', ''; if ($up -eq $cur) { break }; $cur = $up }
} catch { $trusted = $true }
if (-not $trusted) { [Console]::Error.WriteLine("Claude Code does not trust $Dir yet: a window there would stop at the trust prompt. Use a trusted folder, or run claude there once and accept."); exit 3 }
$prompt = "You are a worker in a multi-agent setup, linked as $Name. Tasks arrive typed into your prompt as [link TASK <id> ...] lines. Do exactly what a TASK says, then call link_report with that task_id and a short result (what you did, what you verified, what you did not). Write no chat text between tool calls. $Extra"
$pq = "'" + ($prompt -replace "'", "''") + "'"; $dq = "'" + ($Dir -replace "'", "''") + "'"
$m = if ($Model) { " --model $Model" } else { '' }
$inner = "Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue; Set-Location -LiteralPath $dq; `$env:LINK_CLI='claude'; `$env:LINK_NAME='$Name'; `$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW='100000'; claude$m $pq"
if ($DryRun) { Write-Output $inner; exit 0 }
Start-Process wt -ArgumentList '-w','new','powershell','-NoExit','-NoProfile','-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))) | Out-Null
Write-Output "Opened a Claude worker window in $Dir as $Name. Hand it work with link_assign to `"$Name`"."

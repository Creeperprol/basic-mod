# Windows version of agy-worker.sh (PowerShell 5.1+ or 7). Starts an Antigravity CLI (agy) session as a link-bridge worker:
# it waits on link_inbox, does each task, and answers with link_report. The host hands it work with link_assign.
#
#   .\agy-worker.ps1 [-Model MODEL] [-Dir DIR] [-Window] [-DryRun] [-Extra "extra instructions"]
#     -Model   agy model id (default gemini-3.8-flash-low)
#     -Dir     working folder (default: current folder); it must already be trusted by agy
#     -Window  accepted and ignored: the worker always opens a new PowerShell window (interactive agy); there is no headless mode
#     -DryRun  print the command and exit
#
# One-time setup:  agy mcp add --env LINK_CLI=agy link (Get-Command node).Source C:\path\to\link-bridge\server.mjs
# UNTESTED on a real Windows machine: written alongside agy-worker.sh, check it before relying on it.
param([string]$Model = 'gemini-3.8-flash-low', [string]$Dir = (Get-Location).Path, [switch]$Window, [switch]$DryRun, [string]$Extra = '')
$ErrorActionPreference = 'Stop'

if ($Model -notmatch '^[A-Za-z0-9._-]+$') { Write-Error "invalid model name: $Model"; exit 2 }
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { Write-Error "no such folder: $Dir"; exit 2 }
$Dir = (Resolve-Path -LiteralPath $Dir).Path

# agy asks "Do you trust the contents of this project?" in an untrusted folder and an interactive window waits forever.
# Read-only check against trustedWorkspaces; this script never trusts a folder for you.
$settings = if ($env:AGY_SETTINGS) { $env:AGY_SETTINGS } else { Join-Path $HOME '.gemini\antigravity-cli\settings.json' }
function Test-Trusted {
  try { $entries = @((Get-Content -Raw -LiteralPath $settings | ConvertFrom-Json).trustedWorkspaces) } catch { return $true }
  $norm = { param($p) ($p -replace '\\', '/').TrimEnd('/').ToLowerInvariant() }
  $d = & $norm $Dir
  foreach ($e in $entries) {
    if (-not $e) { continue }
    $r = & $norm ($e -replace '^~', $HOME)
    if ($d -eq $r -or $d.StartsWith($r + '/')) { return $true }
  }
  return $false
}
if (-not (Test-Trusted)) {
  [Console]::Error.WriteLine("agy does not trust $Dir yet: an interactive window there would stop at the trust question and never start.")
  [Console]::Error.WriteLine("Use a trusted folder (trustedWorkspaces in $settings), or run agy there once and answer the question.")
  exit 3
}

$prompt = "You are a worker in a multi-agent setup. Tasks arrive typed into your prompt as [link TASK <id> ...] lines. Do not poll or wait. When a TASK arrives, do exactly what it says, then call link_report with that task_id and a short result (what you did, what you verified, what you did not). Write no chat text. $Extra"
$pq = "'" + ($prompt -replace "'", "''") + "'"
$dq = "'" + ($Dir -replace "'", "''") + "'"
$utf16 = { param($t) [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($t)) }

$inner = "Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue; Set-Location -LiteralPath $dq; agy --dangerously-skip-permissions --model $Model -i $pq"
if ($DryRun) { Write-Output $inner; exit 0 }
Start-Process wt -ArgumentList '-w','new','powershell','-NoExit','-NoProfile','-EncodedCommand', (& $utf16 $inner) | Out-Null
Write-Output "Opened an agy worker window in $Dir (model $Model)."

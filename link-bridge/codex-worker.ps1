# Windows: opens an interactive Codex session (the real Codex UI) in a Windows Terminal window as a link-bridge worker.
# It waits for tasks typed into the window as [link TASK <id> ...] lines and answers with link_report.
#
#   .\codex-worker.ps1 [-Dir DIR] [-Model MODEL] [-Name NAME] [-Safe] [-DryRun] [-Extra "extra instructions"]
#     -Safe   workspace-write sandbox with approval prompts (default: bypass approvals and sandbox, like link-grid)
param([string]$Dir = (Get-Location).Path, [string]$Model = '', [string]$Name = '', [switch]$Safe, [switch]$DryRun, [string]$Extra = '')
$ErrorActionPreference = 'Stop'
if ($Model -and $Model -notmatch '^[A-Za-z0-9._:/-]+$') { Write-Error "invalid model name: $Model"; exit 2 }
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { Write-Error "no such folder: $Dir"; exit 2 }
$Dir = (Resolve-Path -LiteralPath $Dir).Path
if (-not $Name) { $Name = 'codex-' + ([guid]::NewGuid().ToString('N').Substring(0, 4)) }
$prompt = "You are link worker $Name in a multi-agent setup. Tasks arrive typed into your prompt as [link TASK <id> ...] lines. When a TASK arrives, do exactly what it says, then call link_report with that task_id and a short result (what you did, what you verified, what you did not). Write no chat text otherwise. $Extra"
$q = { param($s) "'" + ($s -replace "'", "''") + "'" }
$mode = if ($Safe) { '-s workspace-write -a on-request' } else { '--dangerously-bypass-approvals-and-sandbox' }
$m = if ($Model) { " -m $Model" } else { '' }
$inner = "Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue; Set-Location -LiteralPath $(& $q $Dir); `$env:LINK_CLI='codex'; `$env:LINK_NAME=$(& $q $Name); codex -c check_for_update_on_startup=false $mode$m -C $(& $q $Dir) -c 'mcp_servers.link.env.LINK_NAME=`"$Name`"' $(& $q $prompt)"
if ($DryRun) { Write-Output $inner; exit 0 }
Start-Process wt -ArgumentList '-w','new','powershell','-NoExit','-NoProfile','-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))) | Out-Null
Write-Output "Opened a Codex worker window $Name in $Dir."

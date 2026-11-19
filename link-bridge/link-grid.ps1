# Windows version of link-grid.sh (PowerShell 5.1+ or 7): opens COUNT separate PowerShell windows, each running a Claude, Codex or agy worker.
# One window per worker (not tmux panes), so the host can bring each forward and type tasks into it: each window is its own address (win:<pid>).
#
#   .\link-grid.ps1 [-Dir DIR] [-Count 1-8] [-Mix claude|codex|agy|mix] [-Model sonnet]
# Workers are named <cli>-<n>. Codex runs with the approval and sandbox bypass flag; agy with --dangerously-skip-permissions.
# UNTESTED on a real Windows machine.
param([string]$Dir = (Get-Location).Path, [ValidateRange(1, 8)][int]$Count = 4, [ValidateSet('claude', 'codex', 'agy', 'mix')][string]$Mix = 'mix', [string]$Model = 'sonnet')
$ErrorActionPreference = 'Stop'
if ($Model -notmatch '^[A-Za-z0-9._:-]+$') { Write-Error 'invalid model name'; exit 2 }
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { Write-Error "no such folder: $Dir"; exit 2 }
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$dq = "'" + ($Dir -replace "'", "''") + "'"
for ($i = 1; $i -le $Count; $i++) {
  $cli = $Mix
  if ($Mix -eq 'mix') { $cli = if ($i % 2 -eq 1) { 'codex' } else { 'agy' } }
  $pre = "Set-Location -LiteralPath $dq; `$env:LINK_CLI='$cli'; `$env:LINK_NAME='$cli-$i'; "
  switch ($cli) {
    'claude' { $cmd = $pre + "foreach (`$v in 'CLAUDECODE','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_SESSION_ATTENDED','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_CODE_ENTRYPOINT','AI_AGENT') { Remove-Item Env:`$v -ErrorAction SilentlyContinue }; claude --model $Model" }
    'codex' { $cmd = $pre + "codex --dangerously-bypass-approvals-and-sandbox -C $dq -c 'mcp_servers.link.env.LINK_NAME=`"codex-$i`"'" }
    'agy' { $cmd = $pre + 'agy --dangerously-skip-permissions' }
  }
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))) | Out-Null
  Start-Sleep -Milliseconds 600
}
Write-Output "$Count windows opened in $Dir ($Mix). Close a window to stop its worker."

// Parent processes of a process, nearest first, on macOS, Linux and Windows. Used to tell which link
// session belongs to which Claude Code window: the session's MCP server and the window's hooks share the
// same claude process as their nearest common parent.
import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'

const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out))))

export const ancestors = async (pid, depth = 8) => {
  const out =
    process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'])
      : await run('ps', ['-A', '-o', 'pid=,ppid='])
  const parent = new Map()
  for (const line of out.split(/\r?\n/)) {
    const [a, b] = line.trim().split(/\s+/).map(Number)
    if (a) parent.set(a, b)
  }
  const chain = []
  let p = pid
  for (let i = 0; i < depth; i++) {
    const q = parent.get(p)
    if (!q || q <= 1 || chain.includes(q)) break
    chain.push(q)
    p = q
  }
  return chain
}

// ---- Windows: terminal window of a session, bringing it forward and typing into it ----
// A session on Windows is identified by `win:<pid>`, the nearest ancestor process that owns a window (Windows Terminal, conhost, ...).
// Limit: two tabs or panes of one Windows Terminal window share that pid, so only the window can be targeted, not the tab.
const ps = (script, env = {}) =>
  new Promise(resolve =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20_000, windowsHide: true, env: { ...process.env, ...env } }, (err, out) => resolve(err ? '' : String(out).trim())),
  )

export const windowPid = async chain => {
  if (process.platform !== 'win32' || !chain?.length) return ''
  const out = await ps('foreach ($i in ($env:LINK_CHAIN -split ",")) { $p = Get-Process -Id ([int]$i) -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { $i; break } }', { LINK_CHAIN: chain.join(',') })
  return /^\d+$/.test(out) ? out : ''
}

const FOCUS = '$w = New-Object -ComObject WScript.Shell; $ok = $w.AppActivate([int]$env:LINK_WINPID); if ($ok) { "ok" } else { "none" }'
export const winFocus = async pid => (/^\d+$/.test(String(pid)) ? (await ps(FOCUS, { LINK_WINPID: String(pid) })) === 'ok' : false)

// SendKeys treats + ^ % ~ ( ) { } [ ] as commands; wrap each in braces to type it literally.
const SEND =
  'Add-Type -AssemblyName System.Windows.Forms; $w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate([int]$env:LINK_WINPID)) { "none"; exit }; Start-Sleep -Milliseconds 400; ' +
  '$t = [regex]::Replace($env:LINK_TEXT, "[\+\^%~\(\)\{\}\[\]]", { param($m) "{" + $m.Value + "}" }); [System.Windows.Forms.SendKeys]::SendWait($t); Start-Sleep -Seconds ([double]$env:LINK_GAP); [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); "ok"'
export const winType = async (pid, text, gapSeconds) =>
  /^\d+$/.test(String(pid)) ? (await ps(SEND, { LINK_WINPID: String(pid), LINK_TEXT: text, LINK_GAP: String(gapSeconds) })) === 'ok' : false

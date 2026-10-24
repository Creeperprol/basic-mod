// Parent processes of a process, nearest first, on macOS, Linux and Windows. Used to tell which link
// session belongs to which Claude Code window: the session's MCP server and the window's hooks share the
// same claude process as their nearest common parent.
import { execFile } from 'node:child_process'

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

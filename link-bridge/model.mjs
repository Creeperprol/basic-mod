// Which model a running AI CLI session is using, read from what that CLI itself records.
// Dependency-free, Node 18+. Every lookup is best effort and returns '' when it cannot tell.
//   claude: ~/.claude/sessions/<pid>.json -> the session transcript -> model of its newest reply
//   agy:    the agy process's own log (~/.gemini/antigravity-cli/log/cli-*.log, found with lsof)
//           -> its newest "selected model" line, else settings.json "model"
//   codex:  the model shown in its tmux pane footer ("GPT-6-Luna high · Context ..."),
//           else --model / -m on its command line, else ~/.codex/config.toml model
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const run = (cmd, args, timeout = 4000) =>
  new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : String(out || '')))
  })

const readTail = (file, bytes = 262144) => {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, bytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

// "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-5-5-20261001" -> "Sonnet 5.5"; anything else unchanged.
export function prettyModel(id) {
  const s = String(id || '').trim()
  const m = s.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i)
  if (!m) return s
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}${m[4] ? ' 1M' : ''}`
}

// Short form for narrow lists: "Gemini 4 Hydrogen (High)" -> "Hydrogen High", "GPT-6-Luna high" -> "GPT-6-Luna high".
export function shortModel(name) {
  return String(name || '')
    .replace(/^Gemini\s+[\d.]+\s+/i, '')
    .replace(/^Claude\s+/i, '')
    .replace(/\s*\(([^)]+)\)\s*$/, ' $1')
    .trim()
}

// Newest model id in a Claude Code transcript (JSONL), skipping synthetic entries.
export function modelFromTranscript(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const m = JSON.parse(line)?.message?.model
      if (m && !m.startsWith('<')) return m
    } catch {
      // a partial first line of the tail
    }
  }
  return ''
}

// Newest model label in an agy log.
export function modelFromAgyLog(text) {
  const all = [...String(text || '').matchAll(/selected model override to backend: label="([^"]+)"/g)]
  return all.length ? all[all.length - 1][1] : ''
}

// Model in a Codex footer line: "  GPT-6-Luna high · Context 0% used · ..."
export function modelFromCodexScreen(text) {
  const lines = String(text || '').split('\n').reverse()
  for (const l of lines) {
    const m = l.match(/^\s*([A-Za-z][\w.\-]*(?: (?:minimal|low|medium|high|xhigh))?)\s+·\s+(?:Context|\d+% context)/)
    if (m) return m[1]
  }
  return ''
}

async function claudeModel(pid, home) {
  const sess = readJson(path.join(home, '.claude', 'sessions', `${pid}.json`))
  if (!sess?.sessionId) return ''
  const projects = path.join(home, '.claude', 'projects')
  let file = ''
  try {
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${sess.sessionId}.jsonl`)
      if (fs.existsSync(f)) { file = f; break }
    }
  } catch {
    return ''
  }
  return file ? prettyModel(modelFromTranscript(readTail(file))) : ''
}

// agy names each process's log after its start time (cli-YYYYMMDD_HHMMSS.log, local time, 0-2 s after start).
export function agyLogForStart(logNames, startMs) {
  let best = ''
  let bestDiff = Infinity
  for (const n of logNames) {
    const m = n.match(/^cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.log$/)
    if (!m) continue
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
    const diff = t - startMs
    if (diff >= -1000 && diff <= 5000 && Math.abs(diff) < bestDiff) { best = n; bestDiff = Math.abs(diff) }
  }
  return best
}

const agyLogCache = new Map() // pid -> log path

async function agyLogFile(pid, home) {
  if (agyLogCache.has(pid)) return agyLogCache.get(pid)
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'log')
  let file = ''
  const start = Date.parse((await run('ps', ['-o', 'lstart=', '-p', String(pid)])).trim())
  if (Number.isFinite(start)) {
    try {
      const n = agyLogForStart(fs.readdirSync(dir), start)
      if (n) file = path.join(dir, n)
    } catch {
      // no log folder
    }
  }
  if (!file) {
    const out = await run('lsof', ['-p', String(pid), '-Fn'])
    file = out.split('\n').find(l => /^n.*antigravity-cli\/log\/cli-[^/]*\.log$/.test(l))?.slice(1) || ''
  }
  if (file) agyLogCache.set(pid, file)
  return file
}

async function agyModel(pid, home) {
  const log = await agyLogFile(pid, home)
  const fromLog = log ? modelFromAgyLog(readTail(log, 1 << 20)) : ''
  if (fromLog) return fromLog
  return readJson(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'))?.model || ''
}

async function codexModel(pid, pane, home) {
  if (pane) {
    const screen = await run('tmux', ['capture-pane', '-p', '-t', pane])
    const m = modelFromCodexScreen(screen)
    if (m) return m
  }
  if (pid) {
    const args = (await run('ps', ['-o', 'args=', '-p', String(pid)])).trim()
    const m = args.match(/(?:--model|-m)[ =](\S+)/)
    if (m) return m[1]
  }
  if (!pid) return ''
  try {
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    return toml.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || ''
  } catch {
    return ''
  }
}

// Is this process really that CLI? (Claude Code's binary is named after its version, agy runs as agy-real.)
export function processIsCli(comm, cli) {
  const c = path.basename(String(comm || '').trim()).toLowerCase().replace(/-real$/, '')
  if (cli === 'claude') return c === 'claude' || /^\d+(\.\d+)+$/.test(c)
  return c === cli
}

/** Model of one running session: { cli, pid (the CLI process), pane (tmux pane id, optional) }. */
export async function detectModel({ cli, pid, pane = '' } = {}, { home = os.homedir() } = {}) {
  try {
    if (process.platform === 'win32') return ''
    // Only a process that really is that CLI: never guess from a wrapper, a shell or a test runner.
    const isCli = pid ? processIsCli(await run('ps', ['-o', 'comm=', '-p', String(pid)]), cli) : false
    if (cli === 'claude' && isCli) return await claudeModel(pid, home)
    if (cli === 'agy' && isCli) return await agyModel(pid, home)
    if (cli === 'codex') return await codexModel(isCli ? pid : 0, pane, home)
  } catch {
    // best effort
  }
  return ''
}

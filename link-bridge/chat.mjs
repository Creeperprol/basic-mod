// The whole conversation of a running AI session as plain text, for the AI Remote phone app's Chat view.
// A tmux pane alone cannot give it: Claude Code and Codex draw in the alternate screen, which has no scrollback.
//   claude: ~/.claude/sessions/<pid>.json -> the session transcript (JSONL)
//   codex:  the ~/.codex/sessions rollout whose text matches what the pane shows (started after the process)
//   others (agy, ...) and fallback: the pane's full tmux history
// Dependency-free, Node 18+. Best effort: returns '' when nothing can be read.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const run = (cmd, args, timeout = 5000) =>
  new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 32 << 20 }, (err, out) => resolve(err ? '' : String(out || '')))
  })
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readText = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const MAX_TOOL_ARG = 120
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const brief = s => { const t = oneLine(s); return t.length > MAX_TOOL_ARG ? t.slice(0, MAX_TOOL_ARG - 1) + '…' : t }
const toolArgs = input => {
  if (input == null) return ''
  if (typeof input === 'string') return brief(input)
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
  return brief(v ?? JSON.stringify(input))
}

// Claude Code transcript (JSONL) -> "❯ user" / "⏺ assistant" / "⏺ Tool(args)" blocks.
export function renderClaudeTranscript(jsonl) {
  const out = []
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.isMeta || d.isSidechain || !d.message) continue
    const c = d.message.content
    if (d.type === 'user') {
      if (typeof c === 'string') {
        if (c.startsWith('<') && !c.startsWith('<pasted')) continue // command echoes, reminders
        out.push(`❯ ${c.trim()}`)
      } else if (Array.isArray(c)) {
        const text = c.filter(b => b.type === 'text' && !String(b.text).startsWith('<')).map(b => b.text).join('\n').trim()
        if (text) out.push(`❯ ${text}`)
      }
    } else if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && String(b.text).trim()) out.push(`⏺ ${b.text.trim()}`)
        else if (b.type === 'tool_use') out.push(`⏺ ${b.name}(${toolArgs(b.input)})`)
      }
    }
  }
  return out.join('\n\n')
}

// Codex rollout (JSONL) -> the same shape.
export function renderCodexRollout(jsonl) {
  const out = []
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type !== 'response_item') continue
    const p = d.payload || {}
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content || []).map(x => x.text || '').join('\n').trim()
      if (!text || (p.role === 'user' && text.startsWith('<'))) continue // environment / instructions blocks
      out.push(`${p.role === 'user' ? '❯' : '⏺'} ${text}`)
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args = p.arguments ?? p.input ?? p.action
      try { if (typeof args === 'string') args = JSON.parse(args) } catch { /* keep as text */ }
      out.push(`⏺ ${p.name || 'shell'}(${toolArgs(args?.cmd ? [].concat(args.cmd).join(' ') : args)})`)
    }
  }
  return out.join('\n\n')
}

// Split into pieces of at most `size` chars on line breaks, counted from the START, so earlier pieces never change
// while the chat grows (only the last one does). A single longer line is cut.
export function chunkText(text, size = 19000) {
  const chunks = []
  let cur = ''
  for (const raw of String(text || '').split('\n')) {
    let line = raw
    while (line.length > size) { if (cur) { chunks.push(cur); cur = '' } chunks.push(line.slice(0, size)); line = line.slice(size) }
    const next = cur ? cur + '\n' + line : line
    if (next.length > size) { chunks.push(cur); cur = line } else cur = next
  }
  if (cur || chunks.length === 0) chunks.push(cur)
  return chunks
}

async function claudeTranscript(pid, home) {
  const sess = readJson(path.join(home, '.claude', 'sessions', `${pid}.json`))
  if (!sess?.sessionId) return ''
  const projects = path.join(home, '.claude', 'projects')
  try {
    for (const d of fs.readdirSync(projects)) {
      const f = path.join(projects, d, `${sess.sessionId}.jsonl`)
      if (fs.existsSync(f)) return renderClaudeTranscript(readText(f))
    }
  } catch {
    // no projects folder
  }
  return ''
}

const codexCache = new Map() // pid -> rollout path

// Distinctive lines on screen (letters, 20+ chars) used to tell which rollout belongs to a pane.
const screenKeys = screen => String(screen || '').split('\n').map(l => l.replace(/^[\s›>•⏺❯│┃]+/, '').trim())
  .filter(l => l.length >= 20 && /[a-z]{3}/i.test(l)).map(l => l.slice(0, 60))

async function codexTranscript(pid, pane, home) {
  let file = codexCache.get(pid) || ''
  if (!file) {
    const start = Date.parse((await run('ps', ['-o', 'lstart=', '-p', String(pid)])).trim())
    if (!Number.isFinite(start)) return ''
    const root = path.join(home, '.codex', 'sessions')
    const days = [0, 1].map(n => new Date(Date.now() - n * 864e5)).map(d => path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')))
    const candidates = []
    for (const dir of days) {
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const f = path.join(dir, n)
        const first = readText(f).split('\n', 1)[0]
        let t = NaN
        try { t = Date.parse(JSON.parse(first)?.payload?.timestamp) } catch { /* not a rollout */ }
        if (Number.isFinite(t) && t >= start - 5000) candidates.push(f)
      }
    }
    if (candidates.length === 1) file = candidates[0]
    else if (candidates.length > 1 && pane) {
      const keys = screenKeys(await run('tmux', ['capture-pane', '-p', '-J', '-t', pane]))
      let best = 0
      for (const f of candidates) {
        const body = readText(f)
        const score = keys.filter(k => body.includes(k)).length
        if (score > best) { best = score; file = f }
      }
    }
    if (file) codexCache.set(pid, file)
  }
  return file ? renderCodexRollout(readText(file)) : ''
}

const paneHistory = async pane => (pane ? (await run('tmux', ['capture-pane', '-p', '-J', '-S', '-', '-E', '-', '-t', pane])).replace(/\s+$/, '') : '')

/** Whole conversation of one session: { cli, pid (the CLI process), pane }. */
export async function chatText({ cli, pid, pane = '' } = {}, { home = os.homedir() } = {}) {
  try {
    if (cli === 'claude' && pid) {
      const t = await claudeTranscript(pid, home)
      if (t) return t
    }
    if (cli === 'codex' && pid) {
      const t = await codexTranscript(pid, pane, home)
      if (t) return t
    }
  } catch {
    // fall back to the pane
  }
  return paneHistory(pane)
}

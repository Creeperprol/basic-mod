#!/usr/bin/env node
// link-bridge: a stdio MCP server that lets coding-agent sessions (Claude Code, Codex, Qwen Code, ...)
// find and message each other, and lets one session host and hand out work to the others.
// State lives in plain files under LINK_HOME (default ~/.session-link); no dependencies. The server itself never
// touches the network: lan.mjs, run separately, links machines on one network (see README).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { ancestors } from './proc.mjs'

const HOME = process.env.LINK_HOME || path.join(os.homedir(), '.session-link')
const CLI = process.env.LINK_CLI || 'agent'
const CWD = process.cwd()
const ID = crypto.randomUUID()
// <cli>-<id>: the folder is not part of the name (it is in the registry entry), so a user name or project path never becomes a session name.
const NAME0 = process.env.LINK_NAME || `${CLI}-${ID.slice(0, 4)}`
const STALE_MS = 60_000
const BEAT_MS = 10_000
// Push delivery: instead of waiting for the agent to poll link_inbox, type the message into the target's terminal.
// LINK_WAKE=0 turns it off; LINK_WAKE_LOG=<file> only records what would be typed (used by the tests).
const WAKE = process.env.LINK_WAKE !== '0'
const WAKE_LOG = process.env.LINK_WAKE_LOG || ''
const WAKE_GAP_MS = Number(process.env.LINK_WAKE_GAP_MS) || 1000 // text first, Enter a moment later: Codex treats fast Enter as part of a paste
// Codex starts MCP servers from its shared app-server daemon: no terminal and no TMUX_PANE, so link-grid.sh passes LINK_PANE explicitly.
const PANE = process.env.LINK_PANE || process.env.TMUX_PANE || ''
const myTty = process.env.LINK_TTY ?? (() => {
  try {
    const t = execFileSync('ps', ['-o', 'tty=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim()
    return t && !t.startsWith('?') ? t.replace(/^\/dev\//, '') : ''
  } catch {
    return ''
  }
})()

const dir = (...p) => path.join(HOME, ...p)
for (const d of ['peers', 'inbox', 'tasks']) fs.mkdirSync(dir(d), { recursive: true })

let myName = NAME0
const received = new Map() // task id -> { hostId, hostName }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- files ----------
const writeJson = (file, value) => {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}
const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// ---------- presence ----------
// chain: this server's parent processes, so listen.mjs (a Claude Code hook) can find the session of its own window.
let myChain = []
const beat = () => writeJson(dir('peers', `${ID}.json`), { id: ID, name: myName, cli: CLI, cwd: CWD, pid: process.pid, chain: myChain, tty: myTty, pane: PANE, seen: Date.now() })

const peers = ({ includeSelf = false } = {}) => {
  const out = []
  for (const f of fs.readdirSync(dir('peers'))) {
    if (!f.endsWith('.json')) continue
    const p = readJson(dir('peers', f))
    if (!p) continue
    // A session on another machine (written by lan.mjs) has no local process: it is live while lan.mjs keeps refreshing it.
    if (Date.now() - p.seen > STALE_MS || (!p.remote && !alive(p.pid))) {
      fs.rmSync(dir('peers', f), { force: true })
      continue
    }
    if (p.id !== ID || includeSelf) out.push(p)
  }
  return out.sort((a, z) => z.seen - a.seen)
}

const pick = (list, q) => {
  const w = String(q).toLowerCase()
  const exact = list.filter(p => p.name.toLowerCase() === w || p.id === q)
  if (exact.length) return exact
  return list.filter(p => p.name.toLowerCase().startsWith(w) || p.id.startsWith(q))
}

const hostRecord = () => {
  const h = readJson(dir('host.json'))
  if (!h) return null
  const p = readJson(dir('peers', `${h.id}.json`))
  return p && Date.now() - p.seen <= STALE_MS && alive(p.pid) ? h : null
}
const amHost = () => hostRecord()?.id === ID

// ---------- messages ----------
const send = (to, kind, body) => {
  const box = dir('inbox', to)
  fs.mkdirSync(box, { recursive: true })
  const file = path.join(box, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`)
  const msg = { kind, from: ID, fromName: myName, at: Date.now(), ...body }
  writeJson(file, msg)
  if (kind !== 'rename') wake(to, msg, file)
}

// ---------- push delivery ----------
const oneLine = t => String(t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500)
const typed = m => {
  if (m.kind === 'task') return `[link TASK ${m.taskId} from host "${m.fromName}"] ${oneLine(m.text)} (When finished, call link_report with task_id "${m.taskId}" and a short result.)`
  if (m.kind === 'result') return `[link RESULT ${m.taskId} from "${m.fromName}"] ${oneLine(m.text)}`
  return `[link MESSAGE from "${m.fromName}"] ${oneLine(m.text)}`
}
const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 15_000 }, (err, out) => resolve(err ? '' : String(out).trim())))
const OSA = `on run argv
  set theTTY to item 1 of argv
  set theText to item 2 of argv
  set theGap to (item 3 of argv) as real
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTTY then
          do script theText in t
          delay theGap
          do script "" in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "nomatch"
end run`
// Returns true when the text was typed into the target's prompt (tmux pane or macOS Terminal tab).
const typeInto = async (peer, line) => {
  if (WAKE_LOG) {
    fs.appendFileSync(WAKE_LOG, JSON.stringify({ to: peer.name, tty: peer.tty, pane: peer.pane, line }) + '\n')
    return true
  }
  if (peer.pane) {
    const a = await run('tmux', ['send-keys', '-t', peer.pane, '-l', '--', line])
    if (a === '') {
      await sleep(WAKE_GAP_MS)
      return (await run('tmux', ['send-keys', '-t', peer.pane, 'Enter'])) === ''
    }
  }
  if (peer.tty && process.platform === 'darwin') {
    return (await run('osascript', ['-e', OSA, `/dev/${peer.tty}`, line, String(WAKE_GAP_MS / 1000)])) === 'ok'
  }
  return false
}
const chains = new Map() // one delivery at a time per target so two messages never interleave
const wake = (to, msg, file) => {
  if (!WAKE) return
  const peer = readJson(dir('peers', `${to}.json`))
  if (!peer || (!peer.pane && !peer.tty) || (peer.tty && peer.tty === myTty && !peer.pane)) return
  const prev = chains.get(to) || Promise.resolve()
  const next = prev
    .then(async () => {
      // Delivered by typing: drop the inbox copy so the agent does not see it twice. If typing failed, link_inbox still has it.
      if (await typeInto(peer, typed(msg))) fs.rmSync(file, { force: true })
    })
    .catch(() => {})
  chains.set(to, next)
}

const takeInbox = () => {
  const box = dir('inbox', ID)
  if (!fs.existsSync(box)) return []
  const out = []
  for (const f of fs.readdirSync(box).sort()) {
    if (!f.endsWith('.json')) continue
    const m = readJson(path.join(box, f))
    fs.rmSync(path.join(box, f), { force: true })
    if (m) out.push(m)
  }
  return out
}

// A rename is applied by the receiving server itself, and only when it comes from the host.
const applyRenames = () => {
  const box = dir('inbox', ID)
  if (!fs.existsSync(box)) return
  for (const f of fs.readdirSync(box)) {
    const m = readJson(path.join(box, f))
    if (m && m.kind === 'rename') {
      fs.rmSync(path.join(box, f), { force: true })
      const h = readJson(dir('host.json'))
      const name = String(m.name || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
      const remoteHost = m.via === 'lan' && readJson(dir('peers', `${m.from}.json`))?.isHost === true
      if (((h && h.id === m.from) || remoteHost) && name) {
        myName = name
        beat()
      }
    }
  }
}

// ---------- from other machines ----------
// lan.mjs drops messages from other machines into this inbox. Nobody on this machine typed them, so this server types
// them into its own session, records tasks so link_report finds the host, and marks results done on its own board.
const lanSeen = new Set()
const lanChain = { p: Promise.resolve() }
const takeLan = () => {
  const box = dir('inbox', ID)
  if (!fs.existsSync(box)) return
  for (const f of fs.readdirSync(box).sort()) {
    if (!f.endsWith('.json') || lanSeen.has(f)) continue
    const file = path.join(box, f)
    const m = readJson(file)
    if (!m || m.via !== 'lan' || m.kind === 'rename') continue
    lanSeen.add(f)
    if (m.kind === 'task') received.set(m.taskId, { hostId: m.from, hostName: m.fromName })
    if (m.kind === 'result') {
      const tasks = loadTasks(ID)
      if (tasks.some(x => x.id === m.taskId)) writeJson(tasksFile(ID), tasks.map(x => (x.id === m.taskId ? { ...x, status: 'done', result: String(m.text).slice(0, 2000) } : x)))
    }
    if (!WAKE) continue
    const me = { name: myName, tty: myTty, pane: PANE }
    if (!me.tty && !me.pane) continue
    lanChain.p = lanChain.p.then(async () => {
      if (await typeInto(me, typed(m))) fs.rmSync(file, { force: true })
    }).catch(() => {})
  }
}

const tasksFile = hostId => dir('tasks', `${hostId}.json`)
// A task typed into the prompt never went through link_inbox, so find its host from the host's task board.
const findTask = id => {
  for (const f of fs.readdirSync(dir('tasks'))) {
    if (!f.endsWith('.json')) continue
    const hostId = f.slice(0, -5)
    const t = (readJson(dir('tasks', f), []) || []).find(x => x.id === id && x.toId === ID)
    if (t) return { hostId, hostName: readJson(dir('peers', `${hostId}.json`))?.name || 'host' }
  }
  return null
}
const loadTasks = hostId => readJson(tasksFile(hostId), [])

const show = m => {
  if (m.kind === 'task') {
    received.set(m.taskId, { hostId: m.from, hostName: m.fromName })
    return `TASK ${m.taskId} from host "${m.fromName}":\n${m.text}\n(When finished, call link_report with task_id "${m.taskId}" and a short result.)`
  }
  if (m.kind === 'result') return `RESULT ${m.taskId} from "${m.fromName}":\n${m.text}`
  return `MESSAGE from "${m.fromName}":\n${m.text}`
}

// ---------- tools ----------
const TOOLS = [
  { name: 'link_peers', description: 'List the other running agent sessions (Claude Code, Codex, Qwen, ...) you can message.', inputSchema: { type: 'object', properties: {} } },
  { name: 'link_tell', description: 'Send a message to one other session, by name or id prefix.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] } },
  { name: 'link_tellall', description: 'Send a message to every other session.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'link_inbox', description: 'Fallback only: messages, tasks and results are normally typed into your prompt as [link ...] lines. Reads and clears anything that could not be typed. wait_seconds (max 120) waits for something to arrive.', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number' } } } },
  { name: 'link_host', description: 'Make this session the host that hands out work (on: true), or stop hosting (on: false).', inputSchema: { type: 'object', properties: { on: { type: 'boolean' } } } },
  { name: 'link_assign', description: 'Host only. Give a task to a worker session by name, or "all". Results are typed into your prompt as [link RESULT ...] lines and shown by link_board.', inputSchema: { type: 'object', properties: { worker: { type: 'string' }, task: { type: 'string' } }, required: ['worker', 'task'] } },
  { name: 'link_report', description: 'Worker only. Send the result of an assigned task back to the host.', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, result: { type: 'string' } }, required: ['task_id', 'result'] } },
  { name: 'link_board', description: 'Host only. Show the task board; clear: true drops finished tasks.', inputSchema: { type: 'object', properties: { clear: { type: 'boolean' } } } },
  { name: 'link_rename', description: 'Host only. Rename a worker session as listed by link_peers.', inputSchema: { type: 'object', properties: { worker: { type: 'string' }, name: { type: 'string' } }, required: ['worker', 'name'] } },
]

const ok = text => ({ content: [{ type: 'text', text }] })
const fail = text => ({ content: [{ type: 'text', text }], isError: true })

const listWith = list => (list.length ? list.map(p => `${p.name}  [${p.cli}]  ${path.basename(p.cwd)}${p.remote ? `  on ${p.machine}` : ''}  (${p.id.slice(0, 8)})`).join('\n') : 'No other sessions running.')

const call = async (name, a) => {
  applyRenames()
  switch (name) {
    case 'link_peers': {
      const h = hostRecord()
      return ok(`You are "${myName}" [${CLI}]${amHost() ? ' (host)' : ''}.${h && !amHost() ? ` Host: ${h.name}.` : ''}\n${listWith(peers())}`)
    }
    case 'link_tell': {
      const m = pick(peers(), a.to)
      if (m.length === 0) return fail(`No session matches "${a.to}".`)
      if (m.length > 1) return fail(`"${a.to}" is ambiguous: ${m.map(p => p.name).join(', ')}`)
      send(m[0].id, 'msg', { text: String(a.text) })
      return ok(`Sent to ${m[0].name}.`)
    }
    case 'link_tellall': {
      const list = peers()
      for (const p of list) send(p.id, 'msg', { text: String(a.text) })
      return ok(list.length ? `Sent to ${list.length} session(s).` : 'No other sessions to tell.')
    }
    case 'link_inbox': {
      const until = Date.now() + Math.min(120, Math.max(0, Number(a.wait_seconds) || 0)) * 1000
      let msgs = takeInbox()
      while (msgs.length === 0 && Date.now() < until) {
        await sleep(400)
        applyRenames()
        msgs = takeInbox()
      }
      return ok(msgs.length ? msgs.map(show).join('\n\n') : 'Inbox is empty.')
    }
    case 'link_host': {
      if (a.on === false) {
        if (amHost()) fs.rmSync(dir('host.json'), { force: true })
        return ok('No longer hosting.')
      }
      const h = hostRecord()
      if (h && h.id !== ID) return fail(`"${h.name}" is already the host. It must stop hosting first.`)
      writeJson(dir('host.json'), { id: ID, name: myName })
      return ok(`${myName} is the host. Use link_assign to hand out work.`)
    }
    case 'link_assign': {
      if (!amHost()) return fail('This session is not the host. Call link_host first.')
      const list = peers()
      const chosen = a.worker === 'all' ? list : pick(list, a.worker)
      if (chosen.length === 0) return fail(`No session matches "${a.worker}".`)
      if (a.worker !== 'all' && chosen.length > 1) return fail(`"${a.worker}" is ambiguous: ${chosen.map(p => p.name).join(', ')}`)
      const tasks = loadTasks(ID)
      const out = []
      for (const p of chosen) {
        const taskId = `t${crypto.randomBytes(2).toString('hex')}`
        send(p.id, 'task', { taskId, text: String(a.task) })
        tasks.push({ id: taskId, toId: p.id, toName: p.name, text: String(a.task), status: 'sent', at: Date.now() })
        out.push(`→ ${p.name} (${taskId})`)
      }
      writeJson(tasksFile(ID), tasks.slice(-50))
      return ok(out.join('\n'))
    }
    case 'link_report': {
      const t = received.get(String(a.task_id)) || findTask(String(a.task_id))
      if (!t) return fail(`No task ${a.task_id} was assigned to this session.`)
      // A host on another machine keeps its board there; it marks the task done when the result arrives.
      if (fs.existsSync(tasksFile(t.hostId))) {
        const tasks = loadTasks(t.hostId).map(x => (x.id === a.task_id ? { ...x, status: 'done', result: String(a.result).slice(0, 2000) } : x))
        writeJson(tasksFile(t.hostId), tasks)
      }
      send(t.hostId, 'result', { taskId: String(a.task_id), text: String(a.result) })
      return ok('Result sent to the host.')
    }
    case 'link_board': {
      if (!amHost()) return fail('This session is not the host.')
      let tasks = loadTasks(ID)
      if (a.clear) {
        const before = tasks.length
        tasks = tasks.filter(x => x.status !== 'done')
        writeJson(tasksFile(ID), tasks)
        return ok(`Cleared ${before - tasks.length} finished task(s).`)
      }
      const icon = { sent: '…', done: '✓', failed: '✗' }
      return ok(tasks.length ? tasks.map(x => `${icon[x.status]} ${x.id}  ${x.toName}: ${x.text.slice(0, 60)}${x.result ? `\n    ⇒ ${x.result.slice(0, 200)}` : ''}`).join('\n') : 'No tasks yet.')
    }
    case 'link_rename': {
      if (!amHost()) return fail('This session is not the host.')
      const m = pick(peers(), a.worker)
      if (m.length !== 1) return fail(m.length ? `"${a.worker}" is ambiguous.` : `No session matches "${a.worker}".`)
      send(m[0].id, 'rename', { name: String(a.name) })
      return ok(`Asked ${m[0].name} to rename itself to "${String(a.name).slice(0, 60)}".`)
    }
    default:
      return fail(`Unknown tool ${name}`)
  }
}

// ---------- MCP over stdio ----------
const INSTRUCTIONS = `You can message other coding-agent sessions on this machine (and on other machines on the same network when lan.mjs runs; link_peers shows them as "on <machine>"). Call link_peers to see them, link_tell to message one, and messages, tasks and results sent to you are typed into your prompt automatically (tagged [link ...]); link_inbox is only a fallback for anything that could not be typed. One session can call link_host and then link_assign tasks; a worker answers with link_report.`

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')

const handle = async msg => {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'link-bridge', version: '0.1.0' },
      instructions: INSTRUCTIONS,
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    try {
      return reply(id, await call(params.name, params.arguments || {}))
    } catch (e) {
      return reply(id, fail(`link-bridge error: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  if (id !== undefined && !method.startsWith('notifications/')) return error(id, -32601, `Method not found: ${method}`)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line)).catch(() => {})
    } catch {
      // ignore malformed lines
    }
  }
})

const bye = () => {
  fs.rmSync(dir('peers', `${ID}.json`), { force: true })
  if (amHost()) fs.rmSync(dir('host.json'), { force: true })
  process.exit(0)
}
process.stdin.on('end', bye)
process.on('SIGINT', bye)
process.on('SIGTERM', bye)

beat()
ancestors(process.pid).then(c => {
  myChain = c
  beat()
}).catch(() => {})
setInterval(() => {
  beat()
  applyRenames()
}, BEAT_MS).unref?.()
setInterval(() => {
  applyRenames()
  takeLan()
}, 700).unref?.()

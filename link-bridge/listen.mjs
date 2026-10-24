#!/usr/bin/env node
// listen.mjs: a Claude Code hook that makes a session read its link messages by itself, with no typing.
// Needed where nothing can type into the window (Windows, VS Code, iTerm2, ...); harmless elsewhere.
//
// It runs in the background (an asyncRewake hook, started at session start and after every turn), waits for
// a message, task or result in this session's link inbox, then exits with code 2: Claude Code hands what it
// printed to the model, which reads it at once even when the session was idle. One listener per session.
//
//   node listen.mjs install     add the hooks to ~/.claude/settings.json (user scope)
//   node listen.mjs uninstall   remove them
//
// Env: LINK_HOME (default ~/.session-link).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ancestors } from './proc.mjs'

const HOME = process.env.LINK_HOME || path.join(os.homedir(), '.session-link')
const STALE_MS = 60_000
const TYPED_GRACE_MS = 5_000 // a session that can be typed into gets this long for typing before the hook takes over
const dir = (...p) => path.join(HOME, ...p)
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- install ----------
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const SELF = fileURLToPath(import.meta.url).replace(/\\/g, '/')
const COMMAND = `node "${SELF}"`
const isOurs = h => typeof h?.command === 'string' && h.command.includes('listen.mjs') && h.command.includes('link-bridge')
const HOOK = { type: 'command', command: COMMAND, asyncRewake: true, timeout: 86_400, rewakeMessage: 'AI Link: new message(s) from other sessions. Act on them (answer a TASK with link_report):', rewakeSummary: 'AI Link message' }

const [cmd] = process.argv.slice(2)
if (cmd === 'install' || cmd === 'uninstall') {
  const s = readJson(SETTINGS, {})
  if (!s || typeof s !== 'object') {
    console.error(`${SETTINGS} is not valid JSON; not touching it.`)
    process.exit(1)
  }
  s.hooks ??= {}
  for (const ev of ['SessionStart', 'Stop']) {
    const groups = (s.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length)
    if (cmd === 'install') groups.push({ hooks: [HOOK] })
    if (groups.length) s.hooks[ev] = groups
    else delete s.hooks[ev]
  }
  if (!Object.keys(s.hooks).length) delete s.hooks
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak`)
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  console.log(cmd === 'install' ? `Installed: new Claude Code sessions read link messages by themselves (${SETTINGS}, backup .bak).` : `Removed the listen.mjs hooks from ${SETTINGS}.`)
  process.exit(0)
}
if (cmd) {
  console.error('usage: node listen.mjs [install | uninstall]   (with no argument it runs as a Claude Code hook)')
  process.exit(2)
}

// ---------- hook ----------
try {
  fs.readFileSync(0) // drain the hook's JSON input; nothing in it is needed
} catch {
  // no input
}

// This window's link session: the local peer whose parent processes meet ours soonest (the shared claude process).
const findMe = async () => {
  const mine = await ancestors(process.pid)
  let best = null
  for (const f of fs.existsSync(dir('peers')) ? fs.readdirSync(dir('peers')) : []) {
    const p = f.endsWith('.json') && readJson(dir('peers', f))
    if (!p || p.remote || !Array.isArray(p.chain) || Date.now() - p.seen > STALE_MS || !alive(p.pid)) continue
    for (let i = 0; i < mine.length; i++) {
      const j = p.chain.indexOf(mine[i])
      if (j < 0) continue
      const score = i + j
      if (!best || score < best.score) best = { score, peer: p }
      break
    }
  }
  // Only a shared parent close by counts (hook shell -> claude <- server); a shared terminal or desktop does not.
  return best && best.score <= 3 ? best.peer : null
}

let me = null
for (let i = 0; i < 30 && !me; i++) {
  me = await findMe() // at session start the MCP server may not have registered yet
  if (!me) await sleep(2_000)
}
if (!me) process.exit(0)

// One listener per session: the hooks of every later turn exit here while one is waiting.
const lockDir = dir('listen')
fs.mkdirSync(lockDir, { recursive: true })
const lock = path.join(lockDir, `${me.id}.pid`)
const holder = Number(readJson(lock))
if (holder && holder !== process.pid && alive(holder)) process.exit(0)
fs.writeFileSync(lock, JSON.stringify(process.pid))
const release = () => {
  if (Number(readJson(lock)) === process.pid) fs.rmSync(lock, { force: true })
}
process.on('exit', release)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))

const oneLine = t => String(t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
const show = m => {
  if (m.kind === 'task') return `[link TASK ${m.taskId} from host "${m.fromName}"] ${oneLine(m.text)} (When finished, call link_report with task_id "${m.taskId}" and a short result.)`
  if (m.kind === 'result') return `[link RESULT ${m.taskId} from "${m.fromName}"] ${oneLine(m.text)}`
  return `[link MESSAGE from "${m.fromName}"] ${oneLine(m.text)}`
}

const box = dir('inbox', me.id)
for (;;) {
  const peer = readJson(dir('peers', `${me.id}.json`))
  if (!peer || !alive(peer.pid)) process.exit(0) // the session ended
  const typeable = !!(peer.tty || peer.pane)
  const out = []
  for (const f of fs.existsSync(box) ? fs.readdirSync(box).sort() : []) {
    if (!f.endsWith('.json')) continue
    const file = path.join(box, f)
    const m = readJson(file)
    if (!m || m.kind === 'rename') continue // renames are applied by the server itself
    let age = 0
    try {
      age = Date.now() - fs.statSync(file).mtimeMs
    } catch {
      continue
    }
    if (typeable && age < TYPED_GRACE_MS) continue
    if (m.via === 'lan' && m.kind === 'task' && age < 1_500) continue // let server.mjs note the task first, so link_report finds its host
    fs.rmSync(file, { force: true })
    out.push(show(m))
  }
  if (out.length) {
    process.stderr.write(out.join('\n') + '\n')
    process.exit(2)
  }
  await sleep(1_000)
}

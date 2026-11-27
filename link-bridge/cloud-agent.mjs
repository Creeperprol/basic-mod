#!/usr/bin/env node
// AI Link cloud agent: syncs this Mac's sessions to the Cloudflare relay (ai-remote/cloud) and runs
// the prompts / nudges / spawns the AI Remote app queues there. Needs ~/.ai-link/cloud.json {"url","key"}.
// Dependency-free, Node 18+, macOS (tmux panes or Terminal.app tabs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { chatText, chunkText } from './chat.mjs'

const HOME = path.join(os.homedir(), '.ai-link')
const cfg = JSON.parse(fs.readFileSync(process.env.LINK_CLOUD_CONFIG || path.join(HOME, 'cloud.json'), 'utf8'))
const BASE = String(cfg.url).replace(/\/+$/, '')
const INTERVAL = Number(process.env.LINK_CLOUD_INTERVAL_MS) || 3000
const MACHINE = os.hostname()
const MID = (() => {
  try { return fs.readFileSync(path.join(HOME, 'lan-id'), 'utf8').trim() } catch { return MACHINE }
})()

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { timeout: 8000 }, (e, out) => res(e ? null : out)))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

const KEYS = { enter: ['Enter'], esc: ['Escape'], 'ctrl-c': ['C-c'], up: ['Up'], down: ['Down'], yes: ['-l', 'y', ';', 'Enter'] }
const CLIS = { claude: 'claude', codex: 'codex', agy: 'agy' }

const localPeers = () => {
  const dir = path.join(HOME, 'peers')
  const host = readJson(path.join(HOME, 'host.json'))
  const wd = readJson(path.join(HOME, 'watchdog.json'))
  const wdFresh = wd && Date.now() - wd.updatedAt < 30000 ? wd.peers || {} : {}
  const out = []
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = f.endsWith('.json') && readJson(path.join(dir, f))
    if (!p || p.remote || !p.id || !p.pid || !alive(p.pid)) continue
    out.push({
      id: p.id, name: p.name || p.id.slice(0, 8), cli: p.cli || 'claude', cwd: p.cwd || '',
      remote: false, machine: MACHINE, pane: p.pane || '', tty: p.tty || '', cliPid: Array.isArray(p.chain) ? p.chain[0] : 0,
      isHost: !!host && host.id === p.id, seen: p.seen || Date.now(),
      watchdog: wdFresh[p.id] || null,
    })
  }
  return out
}

const OSA = `on run argv
  set theTTY to item 1 of argv
  set theText to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTTY then
          do script theText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "nomatch"
end run`

const typeInto = async (peer, text) => {
  if (peer.pane) {
    if ((await run('tmux', ['send-keys', '-t', peer.pane, '-l', '--', text])) !== null) {
      await sleep(250)
      return (await run('tmux', ['send-keys', '-t', peer.pane, 'Enter'])) !== null
    }
  }
  if (peer.tty) return ((await run('osascript', ['-e', OSA, `/dev/${peer.tty}`, text])) || '').trim() === 'ok'
  return false
}

const handle = async (cmd, peers) => {
  const byId = new Map(peers.map(p => [p.id, p]))
  if (cmd.type === 'prompt') {
    const tag = cmd.kind === 'task' ? '[remote task] ' : cmd.kind === 'msg' ? '[remote msg] ' : ''
    const targets = cmd.to === 'all' ? peers : [byId.get(cmd.to)].filter(Boolean)
    for (const p of targets) await typeInto(p, tag + cmd.text)
  } else if (cmd.type === 'nudge') {
    const p = byId.get(cmd.to)
    const keys = KEYS[cmd.action]
    if (p?.pane && keys) {
      if (cmd.action === 'yes') {
        await run('tmux', ['send-keys', '-t', p.pane, '-l', 'y'])
        await run('tmux', ['send-keys', '-t', p.pane, 'Enter'])
      } else await run('tmux', ['send-keys', '-t', p.pane, ...keys])
    }
  } else if (cmd.type === 'spawn') {
    const bin = CLIS[cmd.cli]
    if (bin) await run('osascript', ['-e', `tell application "Terminal" to do script "cd ~ && ${bin}"`, '-e', 'tell application "Terminal" to activate'])
  }
}

// Chat view: the app watches "<session id>-chat-last" or "<session id>-chat-<n>" and gets that piece of the whole
// conversation (pieces of <= 19000 chars counted from the start, so older ones never change), headed "#chat <n>/<total>".
const CHAT_ID = /^(.+)-chat-(last|\d+)$/
const capture = async (peers, ids) => {
  const panes = {}
  const chats = new Map() // one read per session per sync, however many pieces are watched
  for (const id of ids) {
    const cm = id.match(CHAT_ID)
    if (cm) {
      const p = peers.find(x => x.id === cm[1])
      if (!p) continue
      if (!chats.has(p.id)) chats.set(p.id, chunkText(await chatText({ cli: p.cli, pid: p.cliPid, pane: p.pane })))
      const chunks = chats.get(p.id)
      const n = cm[2] === 'last' ? chunks.length - 1 : Math.min(Number(cm[2]), chunks.length - 1)
      panes[id] = `#chat ${n}/${chunks.length}\n${chunks[n]}`
      continue
    }
    const p = peers.find(x => x.id === id)
    if (!p) continue
    const out = p.pane ? await run('tmux', ['capture-pane', '-p', '-e', '-t', p.pane, '-S', '-200']) : null
    // The relay keeps the last 20000 chars; trim on a line break here so it never splits a color code.
    const trimmed = out && out.length > 19000 ? out.slice(out.indexOf('\n', out.length - 19000) + 1) : out
    panes[id] = trimmed ?? (p.pane ? '(could not read pane)' : 'No tmux pane for this session; run it inside tmux to view it here.')
  }
  return panes
}

let watch = []
let failures = 0
console.log(`link cloud-agent: ${MACHINE} -> ${BASE}`)
for (;;) {
  try {
    const peers = localPeers()
    const res = await fetch(`${BASE}/agent/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machine: MACHINE, mid: MID, peers: peers.map(({ tty, cliPid, ...rest }) => rest), panes: await capture(peers, watch) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { cmds = [], watch: w = [] } = await res.json()
    watch = w
    for (const c of cmds) await handle(c, peers)
    failures = 0
  } catch (e) {
    if (failures++ % 20 === 0) console.error(`link cloud-agent: ${e.message}`)
  }
  await sleep(Math.min(INTERVAL * (1 + failures), 30000))
}

#!/usr/bin/env node
// Interactive left-side session picker for AI Link (Claude Code, Codex, Antigravity / agy, and other CLIs).
// Zero external dependencies (Node 18+). Works in two modes:
//   1. Standalone sidebar (e.g. narrow Terminal.app window pinned to the left edge via picker.sh):
//      lists all running Claude, Codex and agy sessions (link-bridge peers, tmux panes, and Terminal windows)
//      and raises/focuses the chosen window or tmux pane on click or Enter.
//   2. Tmux workspace sidebar (--tmux-sidebar, launched by link-workspace.sh):
//      stays pinned on the left pane of the workspace window and swaps the chosen session into the right pane.
//
// Usage:
//   node picker.mjs [--tmux-sidebar] [--tmux] [--list] [--json] [--live-only] [--past-limit <n>]
//                   [--focus <name|id>] [--continue <claude|codex|agy>] [--interval <ms>] [--dir <cwd>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { winFocus } from './proc.mjs'

const DEFAULT_HOME = process.env.LINK_HOME || path.join(os.homedir(), '.ai-link')
const FRESH_MS = 60_000
const AI_CLIS = new Set(['claude', 'codex', 'agy', 'qwen', 'gemini'])
const PRIMARY_ORDER = ['claude', 'codex', 'agy']

const run = (cmd, args, timeout = 5000) =>
  new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => {
      resolve({ ok: !err, stdout: String(out || ''), err })
    })
  })

const alive = pid => {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export const parseEtime = t => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(t || '').trim())
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0
}

export const folderBase = cwd =>
  String(cwd || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || ''

export const ago = ms => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]+$/

const readHead = (filePath, maxBytes = 32_768) => {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(maxBytes)
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

const readTail = (filePath, maxBytes = 262_144) => {
  let fd
  try {
    const stat = fs.statSync(filePath)
    const size = stat.size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return ''
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.allocUnsafe(len)
    const bytesRead = fs.readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8', 0, bytesRead)
    if (start > 0) {
      const nl = text.indexOf('\n')
      return nl >= 0 ? text.slice(nl + 1) : text
    }
    return text
  } catch {
    return ''
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

const cleanTitle = raw => {
  const s = String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > 60 ? s.slice(0, 59) + '…' : s
}

const extractTextFromContent = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue
      if (typeof part === 'string' && part.trim()) return part
      if (typeof part.text === 'string' && part.text.trim()) return part.text
    }
  }
  return ''
}

const fileMetaCache = new Map() // filePath -> { mtime, data }

const readJsonlMetaCached = (filePath, mtime, parseFn) => {
  const cached = fileMetaCache.get(filePath)
  if (cached && cached.mtime === mtime) return cached.data
  const data = parseFn(readHead(filePath, 32_768))
  fileMetaCache.set(filePath, { mtime, data })
  return data
}

function readClaudePastSessions(claudeDir, limit) {
  const candidates = []
  let projDirs = []
  try {
    projDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const d of projDirs) {
    if (!d.isDirectory()) continue
    const dirPath = path.join(claudeDir, d.name)
    let files = []
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const full = path.join(dirPath, f.name)
      try {
        const st = fs.statSync(full)
        if (st.size === 0) continue
        candidates.push({ file: full, stem: f.name.replace(/\.jsonl$/, ''), mtime: st.mtimeMs })
      } catch {
        // skip unreadable file
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  const maxScan = Number.isFinite(limit) ? limit * 3 : candidates.length
  const out = []
  const seenIds = new Set()
  for (const c of candidates.slice(0, maxScan)) {
    if (out.length >= limit) break
    const meta = readJsonlMetaCached(c.file, c.mtime, head => {
      let sessionId = c.stem
      let cwd = ''
      let customTitle = ''
      let firstPrompt = ''
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (typeof j.sessionId === 'string' && j.sessionId) sessionId = j.sessionId
          if (!cwd && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd
          if (typeof j.customTitle === 'string' && j.customTitle.trim()) customTitle = j.customTitle.trim()
          if (!firstPrompt && j.type === 'user' && j.message) {
            const txt = extractTextFromContent(j.message.content).trim()
            if (txt && !txt.startsWith('<') && !txt.startsWith('/')) firstPrompt = txt
          }
        } catch {
          // partial last line from head slice
        }
      }
      return { sessionId, cwd, title: cleanTitle(customTitle || firstPrompt) }
    })
    if (!meta.sessionId || seenIds.has(meta.sessionId)) continue
    seenIds.add(meta.sessionId)
    out.push({
      cli: 'claude',
      sessionId: meta.sessionId,
      name: meta.title || `claude-${meta.sessionId.slice(0, 8)}`,
      cwd: meta.cwd,
      seen: c.mtime,
    })
  }
  return out
}

function readCodexPastSessions(codexDir, limit) {
  const candidates = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full)
          if (st.size === 0) continue
          candidates.push({ file: full, name: e.name, mtime: st.mtimeMs })
        } catch {
          // skip
        }
      }
    }
  }
  walk(codexDir, 0)
  candidates.sort((a, b) => b.mtime - a.mtime)

  const maxScan = Number.isFinite(limit) ? limit * 3 : candidates.length
  const out = []
  const seenIds = new Set()
  for (const c of candidates.slice(0, maxScan)) {
    if (out.length >= limit) break
    const meta = readJsonlMetaCached(c.file, c.mtime, head => {
      let sessionId = ''
      let cwd = ''
      let metaTitle = ''
      let firstPrompt = ''
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          if (j.type === 'session_meta' && j.payload) {
            sessionId = String(j.payload.id || j.payload.session_id || sessionId)
            if (!cwd && typeof j.payload.cwd === 'string') cwd = j.payload.cwd
            if (!metaTitle && typeof j.payload.title === 'string') metaTitle = j.payload.title
          } else if (!firstPrompt && j.type === 'event_msg' && j.payload?.type === 'user_message' && typeof j.payload.message === 'string') {
            const txt = j.payload.message.trim()
            if (txt && !txt.startsWith('<')) firstPrompt = txt
          } else if (!firstPrompt && j.type === 'response_item' && j.payload?.role === 'user') {
            const txt = extractTextFromContent(j.payload.content).trim()
            if (txt && !txt.startsWith('<')) firstPrompt = txt
          }
        } catch {
          // partial last line
        }
      }
      if (!sessionId) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(c.name)
        if (m) sessionId = m[1]
      }
      return { sessionId, cwd, title: cleanTitle(metaTitle || firstPrompt) }
    })
    if (!meta.sessionId || seenIds.has(meta.sessionId)) continue
    seenIds.add(meta.sessionId)
    out.push({
      cli: 'codex',
      sessionId: meta.sessionId,
      name: meta.title || `codex-${meta.sessionId.slice(0, 8)}`,
      cwd: meta.cwd,
      seen: c.mtime,
    })
  }
  return out
}

function readAgyPastSessions(agyDir, limit) {
  const byId = new Map()
  const histFile = path.join(agyDir, 'history.jsonl')
  let content = ''
  try {
    content = fs.readFileSync(histFile, 'utf8')
  } catch {
    content = ''
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      const id = typeof j.conversationId === 'string' ? j.conversationId.trim() : ''
      if (!id) continue
      const ts = Number(j.timestamp || 0)
      const ws = typeof j.workspace === 'string' ? j.workspace : ''
      const disp = typeof j.display === 'string' ? j.display.trim() : ''
      const isSlash = j.type === 'slash_command' || disp.startsWith('/')
      const cur = byId.get(id) || { sessionId: id, cwd: '', seen: 0, title: '', fallback: '' }
      if (ts >= cur.seen) {
        cur.seen = ts
        if (ws) cur.cwd = ws
      }
      if (!cur.title && disp && !isSlash) cur.title = disp
      if (disp) cur.fallback = disp
      byId.set(id, cur)
    } catch {
      // skip malformed line
    }
  }
  // Also include brain/<uuid> sessions not present in history.jsonl
  const brainDir = path.join(agyDir, 'brain')
  try {
    for (const d of fs.readdirSync(brainDir, { withFileTypes: true })) {
      if (!d.isDirectory() || byId.has(d.name) || !SAFE_SESSION_ID.test(d.name)) continue
      try {
        const st = fs.statSync(path.join(brainDir, d.name))
        byId.set(d.name, { sessionId: d.name, cwd: '', seen: st.mtimeMs, title: '', fallback: '' })
      } catch {
        // skip
      }
    }
  } catch {
    // no brain dir
  }
  const sorted = [...byId.values()].sort((a, b) => b.seen - a.seen)
  const sliced = Number.isFinite(limit) ? sorted.slice(0, limit) : sorted
  return sliced.map(r => ({
    cli: 'agy',
    sessionId: r.sessionId,
    name: cleanTitle(r.title || r.fallback) || `agy-${r.sessionId.slice(0, 8)}`,
    cwd: r.cwd,
    seen: r.seen,
  }))
}

// Reads resumable past sessions from Claude, Codex, and agy local session stores (all by default).
export function readPastSessions({
  claudeDir = path.join(os.homedir(), '.claude', 'projects'),
  codexDir = path.join(os.homedir(), '.codex', 'sessions'),
  agyDir = path.join(os.homedir(), '.gemini', 'antigravity-cli'),
  limitPerCli = Infinity,
} = {}) {
  const limit = limitPerCli === undefined || limitPerCli === null ? Infinity : Number(limitPerCli)
  if (!Number.isFinite(limit) && limit !== Infinity) return []
  if (limit <= 0) return []
  return [
    ...readClaudePastSessions(claudeDir, limit),
    ...readCodexPastSessions(codexDir, limit),
    ...readAgyPastSessions(agyDir, limit),
  ]
}

const normalizeCli = raw => {
  const c = String(raw || '').trim().toLowerCase()
  if (c === 'claude-code') return 'claude'
  return c
}

// Reads live bridge peer files from $LINK_HOME/peers.
export const readBridgePeers = (home = DEFAULT_HOME, now = Date.now()) => {
  const peersDir = path.join(home, 'peers')
  let files = []
  try {
    files = fs.readdirSync(peersDir)
  } catch {
    return { peers: [], hostId: null }
  }
  let hostId = null
  try {
    const h = JSON.parse(fs.readFileSync(path.join(home, 'host.json'), 'utf8'))
    if (h && typeof h.id === 'string') hostId = h.id
  } catch {
    // no host
  }
  const peers = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const p = JSON.parse(fs.readFileSync(path.join(peersDir, f), 'utf8'))
      if (!p || typeof p.name !== 'string' || typeof p.cli !== 'string') continue
      if (now - Number(p.seen) > FRESH_MS) continue
      if (!p.remote && !alive(Number(p.pid))) continue
      peers.push({
        id: String(p.id || f.replace(/\.json$/, '')),
        name: p.name,
        cli: normalizeCli(p.cli),
        cwd: String(p.cwd || ''),
        pid: Number(p.pid || 0),
        tty: String(p.tty || '').replace(/^\/dev\//, ''),
        pane: String(p.pane || ''),
        seen: Number(p.seen || now),
        remote: Boolean(p.remote),
        machine: p.machine ? String(p.machine) : '',
      })
    } catch {
      // skip corrupt peer file
    }
  }
  return { peers, hostId }
}

// Collects open terminal AI processes, tmux panes, and process elapse times in parallel.
export async function probeSystem() {
  if (process.platform === 'win32') {
    return { procWindows: [], tmuxPanes: [], etimes: new Map(), psTree: [] }
  }
  const [psAllRes, tmuxRes] = await Promise.all([
    run('ps', ['-A', '-o', 'pid=,ppid=,tty=,etime=,comm=,args=']),
    run('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_active}\t#{window_active}\t#{pane_tty}\t#{pane_current_command}\t#{session_attached}']),
  ])

  const etimes = new Map()
  const kids = new Map()
  const procInfo = new Map()
  const ttyCandidates = []

  for (const line of psAllRes.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/)
    if (!m) continue
    const [, pidStr, ppidStr, ttyRaw, etimeStr, commRaw, argsRaw = ''] = m
    const pid = Number(pidStr)
    const tty = ttyRaw === '??' || ttyRaw === '-' ? '' : ttyRaw.replace(/^\/dev\//, '')
    // agy runs as agy-real behind its wrapper; count it as agy.
    const comm = path.basename(commRaw).toLowerCase().replace(/-real$/, '')
    etimes.set(pid, parseEtime(etimeStr))
    kids.set(ppidStr, [...(kids.get(ppidStr) || []), pidStr])
    procInfo.set(pidStr, { pid, tty, comm, args: argsRaw })
    if (tty && AI_CLIS.has(comm)) {
      ttyCandidates.push({ pid, tty, cli: comm })
    }
  }

  // Resolve cwd for open terminal AI processes in one lsof call if any exist.
  const cwdByPid = new Map()
  if (ttyCandidates.length > 0) {
    const pids = ttyCandidates.map(c => String(c.pid)).join(',')
    const lsofRes = await run('lsof', ['-a', '-d', 'cwd', '-p', pids, '-Fpn'])
    let curPid = 0
    for (const line of lsofRes.stdout.split('\n')) {
      if (line.startsWith('p')) curPid = Number(line.slice(1))
      else if (line.startsWith('n') && curPid) cwdByPid.set(curPid, line.slice(1))
    }
  }

  const procWindows = ttyCandidates.map(c => ({
    cli: c.cli,
    tty: c.tty,
    pid: c.pid,
    cwd: cwdByPid.get(c.pid) || '',
  }))

  // Identify AI CLIs running inside tmux panes, and also include regular tmux windows so they can be continued/attached.
  const tmuxPanes = []
  if (tmuxRes.ok && tmuxRes.stdout.trim()) {
    for (const line of tmuxRes.stdout.split('\n')) {
      if (!line.trim()) continue
      const [session, winIdx, winName, paneId, panePid, paneCwd, paneActive, winActive, paneTty, paneCmd = '', sessAttached = '0'] = line.split('\t')
      if (!paneId || !panePid) continue
      const todo = [panePid]
      let detectedCli = ''
      let detectedPid = 0
      // Another picker's sidebar pane is a controller, not a session: never list it.
      if (/\bpicker\.mjs\b/.test(procInfo.get(panePid)?.args || '')) continue
      for (let i = 0; i < todo.length && i < 200; i++) {
        const cur = todo[i]
        const info = procInfo.get(cur)
        if (info) {
          if (AI_CLIS.has(info.comm)) {
            detectedCli = info.comm
            detectedPid = info.pid
            break
          }
          // Check argv[1] for node-wrapped CLIs (e.g. node .../codex or node .../agy)
          const toks = info.args.split(/\s+/).slice(0, 3).map(t => path.basename(t).toLowerCase().replace(/-real$/, ''))
          const hit = toks.find(t => AI_CLIS.has(t))
          if (hit) {
            detectedCli = hit
            detectedPid = info.pid
            break
          }
        }
        for (const ch of kids.get(cur) || []) todo.push(ch)
      }
      tmuxPanes.push({
        cli: detectedCli || 'tmux',
        pid: detectedPid || Number(panePid),
        session,
        windowIndex: Number(winIdx),
        windowName: winName || '',
        pane: paneId,
        cwd: paneCwd || '',
        paneActive: paneActive === '1',
        windowActive: winActive === '1',
        paneCmd: paneCmd || '',
        attached: sessAttached !== '0',
        tty: String(paneTty || '').replace(/^\/dev\//, ''),
      })
    }
  }

  return { procWindows, tmuxPanes, etimes }
}

// Pure merge/dedupe/group function (easily unit-tested without touching the OS).
export function buildSessionGroups({
  bridgePeers = [],
  hostId = null,
  procWindows = [],
  tmuxPanes = [],
  etimes = new Map(),
  pastSessions = [],
  selfPane = '',
  selfTty = '',
  now = Date.now(),
} = {}) {
  const tmuxByPane = new Map(tmuxPanes.map(t => [t.pane, t]))
  const tmuxTtys = new Set(tmuxPanes.map(t => t.tty).filter(Boolean))
  const claimedTmuxPanes = new Set()
  const claimedProcTtys = new Set()

  // Prepare non-tmux terminal windows for matching bridge peers that lack a tty (e.g. Codex app-server).
  const openWindows = procWindows
    .filter(w => !tmuxTtys.has(w.tty))
    .map(w => ({ ...w, used: false }))

  const items = []

  // Group bridge peers by CLI and apply youngest-first deduplication per folder/window count.
  for (const cli of new Set(bridgePeers.map(p => p.cli))) {
    const mine = bridgePeers
      .filter(p => p.cli === cli)
      .map(p => ({ ...p, up: etimes.get(p.pid) ?? 0 }))
      .sort((a, z) => a.up - z.up)

    // Peers with an explicit tmux pane are always unique by pane.
    const panePeers = []
    const nonPanePeers = []
    for (const p of mine) {
      if (p.pane && tmuxByPane.has(p.pane)) {
        if (!panePeers.some(x => x.pane === p.pane)) panePeers.push(p)
      } else {
        nonPanePeers.push(p)
      }
    }

    const cliOpen = openWindows.filter(w => w.cli === cli)
    const perFolder = nonPanePeers.filter((f, k) => {
      const sameFolderPrior = nonPanePeers.slice(0, k).filter(g => g.cwd === f.cwd).length
      const openInFolder = Math.max(1, cliOpen.filter(w => w.cwd === f.cwd).length)
      return sameFolderPrior < openInFolder
    })
    const keptNonPane = cliOpen.length > 0 ? perFolder.slice(0, cliOpen.length) : perFolder

    for (const row of panePeers) {
      const tp = tmuxByPane.get(row.pane)
      claimedTmuxPanes.add(row.pane)
      items.push({
        id: row.id,
        key: `${row.cli}:${row.id}`,
        cli: row.cli,
        name: row.name,
        cwd: row.cwd || tp.cwd,
        seen: row.seen,
        tty: row.tty || tp.tty,
        pane: row.pane,
        tmuxSession: tp.session,
        tmuxWindow: tp.windowIndex,
        tmuxActive: tp.paneActive && tp.windowActive,
        isHost: Boolean(hostId && row.id === hostId),
        isCurrent: Boolean(selfPane && row.pane === selfPane),
        remote: row.remote,
        machine: row.machine,
        source: 'bridge+tmux',
      })
    }

    for (const row of keptNonPane) {
      let tty = row.tty
      if (!tty || !cliOpen.some(w => w.tty === tty)) {
        const w = cliOpen.find(x => !x.used && x.cwd === row.cwd) ?? cliOpen.find(x => !x.used)
        if (w) {
          w.used = true
          tty = w.tty
        }
      } else {
        const w = cliOpen.find(x => !x.used && x.tty === tty)
        if (w) w.used = true
      }
      if (tty) claimedProcTtys.add(tty)
      items.push({
        id: row.id,
        key: `${row.cli}:${row.id}`,
        cli: row.cli,
        name: row.name,
        cwd: row.cwd,
        seen: row.seen,
        tty,
        pane: '',
        tmuxSession: '',
        tmuxWindow: -1,
        tmuxActive: false,
        isHost: Boolean(hostId && row.id === hostId),
        isCurrent: Boolean(selfTty && tty === selfTty),
        remote: row.remote,
        machine: row.machine,
        source: 'bridge',
      })
    }
  }

  // Add tmux panes (AI CLIs not registered with bridge + regular tmux windows) so every tmux window can be continued.
  for (const tp of tmuxPanes) {
    if (claimedTmuxPanes.has(tp.pane)) continue
    if (selfPane && tp.pane === selfPane) continue
    const isGenericTmux = tp.cli === 'tmux'
    // tmux names a window after its running program; Claude Code's binary is its version (e.g. 2.1.332),
    // and a shell name says nothing, so neither is used as a label.
    const winName = tp.windowName && !/^\d+(\.\d+)+$/.test(tp.windowName) ? tp.windowName : ''
    const label = isGenericTmux
      ? `${tp.session}:${tp.windowIndex}${winName ? ' ' + winName : ''}`
      : (winName && !['zsh', 'bash', 'sh', 'fish'].includes(winName)
        ? winName
        : `${tp.cli}-${tp.pane.replace('%', '')}`)
    items.push({
      id: `tmux-${tp.pane}`,
      key: `${tp.cli}:tmux:${tp.pane}`,
      cli: tp.cli,
      name: label,
      cwd: tp.cwd,
      seen: now,
      tty: tp.tty,
      pane: tp.pane,
      tmuxSession: tp.session,
      tmuxWindow: tp.windowIndex,
      tmuxActive: tp.paneActive && tp.windowActive,
      tmuxAttached: tp.attached !== false,
      isHost: false,
      isCurrent: Boolean(selfPane && tp.pane === selfPane),
      remote: false,
      machine: '',
      source: 'tmux',
    })
  }

  // Add standalone Terminal windows running an AI CLI that aren't in link-bridge or tmux.
  for (const w of openWindows) {
    if (w.used || claimedProcTtys.has(w.tty)) continue
    if (selfTty && w.tty === selfTty) continue
    items.push({
      id: `tty-${w.tty}`,
      key: `${w.cli}:tty:${w.tty}`,
      cli: w.cli,
      name: `${w.cli}-${w.tty.replace(/^ttys?/, '')}`,
      cwd: w.cwd,
      seen: now,
      tty: w.tty,
      pane: '',
      tmuxSession: '',
      tmuxWindow: -1,
      tmuxActive: false,
      isHost: false,
      isCurrent: false,
      remote: false,
      machine: '',
      source: 'proc',
    })
  }

  // Add resumable past sessions (Claude, Codex, agy history), skipping any already live by sessionId.
  const liveIds = new Set(items.map(i => i.sessionId || i.id).filter(Boolean))
  for (const ps of pastSessions) {
    if (!ps || !ps.cli || !ps.sessionId) continue
    const cli = normalizeCli(ps.cli)
    if (liveIds.has(ps.sessionId)) continue
    items.push({
      id: ps.sessionId,
      sessionId: ps.sessionId,
      key: `${cli}:past:${ps.sessionId}`,
      cli,
      name: ps.name || `${cli}-${ps.sessionId.slice(0, 8)}`,
      cwd: String(ps.cwd || ''),
      seen: Number(ps.seen || 0),
      tty: '',
      pane: '',
      tmuxSession: '',
      tmuxWindow: -1,
      tmuxActive: false,
      isHost: false,
      isCurrent: false,
      isPast: true,
      remote: false,
      machine: '',
      source: 'history',
    })
  }

  // Organize into groups: claude, codex, agy first, then any other running CLI.
  // Live sessions come first (sorted by name), followed by past resumable sessions (newest first).
  const groupMap = new Map(PRIMARY_ORDER.map(cli => [cli, []]))
  for (const item of items) {
    if (!groupMap.has(item.cli)) groupMap.set(item.cli, [])
    groupMap.get(item.cli).push(item)
  }
  const groups = [...groupMap.entries()].map(([cli, list]) => ({
    cli,
    items: list.sort((a, b) => {
      if (Boolean(a.isPast) !== Boolean(b.isPast)) return a.isPast ? 1 : -1
      if (a.isPast && b.isPast) return (b.seen || 0) - (a.seen || 0)
      return a.name.localeCompare(b.name)
    }),
  }))
  const flat = groups.flatMap(g => g.items)
  return { groups, flat }
}

export async function discoverSessions({
  home = DEFAULT_HOME,
  selfPane = process.env.TMUX_PANE || '',
  selfTty = '',
  includePast = true,
  limitPerCli = Infinity,
  claudeDir,
  codexDir,
  agyDir,
} = {}) {
  const now = Date.now()
  const { peers, hostId } = readBridgePeers(home, now)
  const { procWindows, tmuxPanes, etimes } = await probeSystem()
  const pastSessions = includePast ? readPastSessions({ claudeDir, codexDir, agyDir, limitPerCli }) : []
  return buildSessionGroups({ bridgePeers: peers, hostId, procWindows, tmuxPanes, etimes, pastSessions, selfPane, selfTty, now })
}

// Focuses / switches to a live session, or resumes a past session.
export async function focusSession(item, opts = {}) {
  if (!item) return { ok: false, message: 'No session selected' }
  if (item.isPast || item.source === 'history') {
    return resumeSession(item, opts)
  }
  if (opts.logFile) {
    fs.appendFileSync(opts.logFile, JSON.stringify({ action: 'focus', name: item.name, cli: item.cli, tty: item.tty, pane: item.pane, tmuxSession: item.tmuxSession }) + '\n')
    return { ok: true, message: `Switched to ${item.name}` }
  }

  // Tmux workspace sidebar mode:
  // - If the target pane is already visible in the same window, just focus it (never scramble a multi-pane grid).
  // - Only swap panes when this window is a classic 2-pane sidebar + single-main-pane workspace.
  // A target in another window of the same session is never swapped in: just select that window.
  let sameWindow = true
  if (opts.tmuxSidebar && item.pane && opts.selfPane && item.tmuxSession && item.tmuxSession === opts.tmuxSession) {
    const [selfWin, itemWin] = await Promise.all([
      run('tmux', ['display-message', '-p', '-t', opts.selfPane, '#{window_id}']),
      run('tmux', ['display-message', '-p', '-t', item.pane, '#{window_id}']),
    ])
    sameWindow = !selfWin.ok || !itemWin.ok || selfWin.stdout.trim() === itemWin.stdout.trim()
  }
  if (sameWindow && opts.tmuxSidebar && item.pane && opts.selfPane && item.tmuxSession && item.tmuxSession === opts.tmuxSession) {
    const winPanesRes = await run('tmux', ['list-panes', '-t', opts.selfPane, '-F', '#{pane_id}'])
    const siblingPanes = winPanesRes.stdout.split('\n').map(s => s.trim()).filter(p => p && p !== opts.selfPane)
    if (siblingPanes.includes(item.pane)) {
      await run('tmux', ['select-pane', '-t', item.pane])
      return { ok: true, message: `Focused ${item.name}` }
    }
    if (siblingPanes.length === 1) {
      const mainPane = siblingPanes[0]
      const swapped = await run('tmux', ['swap-pane', '-d', '-s', item.pane, '-t', mainPane])
      if (swapped.ok) {
        await run('tmux', ['select-pane', '-t', item.pane])
        return { ok: true, message: `Switched to ${item.name}` }
      }
    }
  }

  // Regular tmux pane/window (either from standalone mode, another tmux session, or detached tmux session).
  if (item.pane) {
    await run('tmux', ['select-window', '-t', item.pane])
    await run('tmux', ['select-pane', '-t', item.pane])
    if (process.env.TMUX && item.tmuxSession) {
      await run('tmux', ['switch-client', '-t', item.tmuxSession])
      return { ok: true, message: `Switched to tmux ${item.name}` }
    }
    // Outside tmux on macOS: focus an attached Terminal client if one exists, else open Terminal and attach.
    if (process.platform === 'darwin' && item.tmuxSession) {
      const cliRes = await run('tmux', ['list-clients', '-t', item.tmuxSession, '-F', '#{client_tty}'])
      const clientTty = cliRes.stdout.split('\n').map(s => s.trim()).find(Boolean)
      if (clientTty) {
        const raised = await focusMacTerminal(clientTty.replace(/^\/dev\//, ''))
        if (raised.ok) return { ok: true, message: `Switched to tmux ${item.name}` }
      }
      const attachCmd = `tmux attach-session -t ${shq(item.tmuxSession)}`
      const script = `tell application "Terminal"\nactivate\ndo script "${attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
      const opened = await run('osascript', ['-e', script])
      if (opened.ok) return { ok: true, message: `Attached tmux ${item.name}` }
    }
    return { ok: true, message: `Selected tmux pane ${item.name}` }
  }

  if (item.tty && /^win:\d+$/.test(item.tty)) {
    const ok = await winFocus(item.tty.slice(4))
    return ok ? { ok: true, message: `Switched to ${item.name}` } : { ok: false, message: `Window not found for ${item.name}` }
  }

  if (item.tty && process.platform === 'darwin') {
    const r = await focusMacTerminal(item.tty)
    return r.ok ? { ok: true, message: `Switched to ${item.name}` } : { ok: false, message: r.message }
  }

  return { ok: false, message: `No terminal window found for ${item.name}` }
}

async function focusMacTerminal(tty) {
  if (!/^ttys\d+$/.test(tty)) return { ok: false, message: `Invalid tty: ${tty}` }
  const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "none"
end tell`
  const r = await run('osascript', ['-e', script])
  return r.stdout.trim() === 'ok' ? { ok: true } : { ok: false, message: 'No Terminal.app window found' }
}

const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`

const CLAUDE_CLEAN_ENV = 'env -u TMUX -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT COLORTERM=truecolor'

export function resumeCommandFor(cli, sessionId, dir = '') {
  const c = normalizeCli(cli)
  if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return ''
  const tag = `${c}-${sessionId.slice(0, 6)}`
  if (c === 'claude') {
    return `${CLAUDE_CLEAN_ENV} LINK_CLI=claude LINK_NAME=${tag} claude --resume ${shq(sessionId)}`
  }
  if (c === 'codex') {
    const cdArg = dir ? `-C ${shq(dir)} ` : ''
    return `codex resume ${cdArg}-c 'mcp_servers.link.env.LINK_NAME="${tag}"' -c "mcp_servers.link.env.LINK_PANE=\\\"\\$TMUX_PANE\\\"" ${shq(sessionId)}`
  }
  if (c === 'agy') {
    return `LINK_CLI=agy LINK_NAME=${tag} agy --resume ${shq(sessionId)}`
  }
  return ''
}

export function continueCommandFor(cli, dir = '') {
  const c = normalizeCli(cli)
  const tag = `${c}-${Math.random().toString(36).slice(2, 5)}`
  if (c === 'claude') {
    return `${CLAUDE_CLEAN_ENV} LINK_CLI=claude LINK_NAME=${tag} claude --continue`
  }
  if (c === 'codex') {
    const cdArg = dir ? `-C ${shq(dir)} ` : ''
    return `codex resume --last ${cdArg}-c 'mcp_servers.link.env.LINK_NAME="${tag}"' -c "mcp_servers.link.env.LINK_PANE=\\\"\\$TMUX_PANE\\\""`
  }
  if (c === 'agy') {
    return `LINK_CLI=agy LINK_NAME=${tag} agy --continue`
  }
  return ''
}

async function launchCliCommand(cmd, { label, dir, tmuxSidebar, inTmux, tmuxSession, selfPane } = {}) {
  const workDir = dir && fs.existsSync(dir) ? dir : process.cwd()
  if (tmuxSidebar && tmuxSession && selfPane) {
    const winPanesRes = await run('tmux', ['list-panes', '-t', selfPane, '-F', '#{pane_id}\t#{pane_width}\t#{pane_height}'])
    const siblings = winPanesRes.stdout
      .split('\n')
      .map(l => l.trim().split('\t'))
      .filter(parts => parts[0] && parts[0] !== selfPane)
      .map(([id, w, h]) => ({ id, w: Number(w) || 0, h: Number(h) || 0, area: (Number(w) || 0) * (Number(h) || 0) }))
    if (siblings.length > 1) {
      const biggest = siblings.sort((a, b) => b.area - a.area)[0]
      const flag = (biggest.h > 0 && biggest.w / biggest.h > 2.2) ? '-h' : '-v'
      const split = await run('tmux', ['split-window', flag, '-t', biggest.id, '-c', workDir, '-P', '-F', '#{pane_id}', cmd])
      if (split.ok) return { ok: true, message: `Opened ${label}` }
    }
    const created = await run('tmux', ['new-window', '-d', '-t', tmuxSession, '-n', label, '-c', workDir, '-P', '-F', '#{pane_id}', cmd])
    const newPane = created.stdout.trim()
    if (created.ok && newPane) {
      const mainPane = siblings[0]?.id
      if (mainPane) {
        await run('tmux', ['swap-pane', '-d', '-s', newPane, '-t', mainPane])
        await run('tmux', ['select-pane', '-t', newPane])
      }
      return { ok: true, message: `Opened ${label}` }
    }
    return { ok: false, message: `Could not open ${label} in tmux` }
  }

  // Launch inside a tmux window (either when already inside $TMUX or explicitly requested via inTmux / 't' / --tmux).
  if (inTmux || process.env.TMUX) {
    let targetSession = tmuxSession || ''
    if (!targetSession && process.env.TMUX) {
      const cur = await run('tmux', ['display-message', '-p', '#{session_name}'])
      targetSession = cur.stdout.trim()
    }
    if (!targetSession) targetSession = 'ai-link'

    const has = await run('tmux', ['has-session', '-t', targetSession])
    let created
    if (has.ok) {
      created = await run('tmux', ['new-window', '-t', targetSession, '-n', label, '-c', workDir, '-P', '-F', '#{pane_id}', cmd])
    } else {
      created = await run('tmux', ['new-session', '-d', '-s', targetSession, '-n', label, '-c', workDir, '-P', '-F', '#{pane_id}', cmd])
      if (created.ok) await run('tmux', ['set-option', '-t', targetSession, 'mouse', 'on'])
    }
    if (!created.ok) return { ok: false, message: `Could not open ${label} in tmux` }

    if (process.env.TMUX) {
      await run('tmux', ['switch-client', '-t', targetSession])
      return { ok: true, message: `Opened ${label} in tmux (${targetSession})` }
    }
    if (process.platform === 'darwin') {
      const cliRes = await run('tmux', ['list-clients', '-t', targetSession, '-F', '#{client_tty}'])
      const clientTty = cliRes.stdout.split('\n').map(s => s.trim()).find(Boolean)
      if (clientTty) {
        await focusMacTerminal(clientTty.replace(/^\/dev\//, ''))
      } else {
        const attachCmd = `tmux attach-session -t ${shq(targetSession)}`
        const script = `tell application "Terminal"\nactivate\ndo script "${attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
        await run('osascript', ['-e', script])
      }
    }
    return { ok: true, message: `Opened ${label} in tmux (${targetSession})` }
  }

  if (process.platform === 'darwin') {
    const full = `cd ${shq(workDir)} && ${cmd}`
    const script = `tell application "Terminal"\nactivate\ndo script "${full.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
    const r = await run('osascript', ['-e', script])
    return r.ok ? { ok: true, message: `Opened ${label}` } : { ok: false, message: `Could not open ${label}` }
  }
  return { ok: false, message: 'Launch only supported in tmux or macOS Terminal' }
}

// Resumes a specific past session by sessionId in its original folder (or fallback dir).
export async function resumeSession(item, opts = {}) {
  const sessionId = item?.sessionId || item?.id || ''
  const dir = (item?.cwd && fs.existsSync(item.cwd)) ? item.cwd : (opts.dir || process.cwd())
  const cmd = resumeCommandFor(item?.cli, sessionId, dir)
  if (!cmd) return { ok: false, message: `Cannot resume ${item?.cli || 'session'}: invalid session id` }
  if (opts.logFile) {
    fs.appendFileSync(opts.logFile, JSON.stringify({ action: 'resume', cli: item.cli, sessionId, name: item.name, cwd: dir, inTmux: Boolean(opts.inTmux), command: cmd }) + '\n')
    return { ok: true, message: `Resuming ${item.name}${opts.inTmux ? ' in tmux' : ''}` }
  }
  const res = await launchCliCommand(cmd, { ...opts, dir, label: `${item.cli}-${sessionId.slice(0, 6)}` })
  return res.ok ? { ok: true, message: `Resuming ${item.name}${opts.inTmux ? ' in tmux' : ''}` } : res
}

// Continues the most recent session for a CLI (--continue / codex resume --last).
export async function continueLatestCli(cli, opts = {}) {
  const dir = opts.dir || process.cwd()
  const cmd = continueCommandFor(cli, dir)
  if (!cmd) return { ok: false, message: `Cannot continue ${cli}` }
  if (opts.logFile) {
    fs.appendFileSync(opts.logFile, JSON.stringify({ action: 'continue', cli, cwd: dir, command: cmd }) + '\n')
    return { ok: true, message: `Continuing latest ${cli}` }
  }
  const res = await launchCliCommand(cmd, { ...opts, dir, label: `${cli}-cont` })
  return res.ok ? { ok: true, message: `Continuing latest ${cli}` } : res
}

// Spawns a new Claude, Codex, or agy session (in tmux workspace if --tmux-sidebar, else new Terminal window).
async function spawnNewCli(cli, opts = {}) {
  const dir = opts.dir || process.cwd()
  const tag = `${cli}-${Math.random().toString(36).slice(2, 5)}`
  const cmd = cli === 'claude'
    ? `${CLAUDE_CLEAN_ENV} LINK_CLI=claude LINK_NAME=${tag} claude`
    : cli === 'codex'
      ? `codex -C ${shq(dir)} -c 'mcp_servers.link.env.LINK_NAME="${tag}"' -c "mcp_servers.link.env.LINK_PANE=\\\"\\$TMUX_PANE\\\""`
      : `LINK_CLI=agy LINK_NAME=${tag} agy`
  return launchCliCommand(cmd, { ...opts, dir, label: tag })
}

async function resolveTargetTmuxSession(item, opts = {}) {
  if (item?.tmuxSession) return item.tmuxSession
  if (opts.tmuxSession) return opts.tmuxSession
  if (process.env.TMUX) {
    const cur = await run('tmux', ['display-message', '-p', '#{session_name}'])
    if (cur.ok && cur.stdout.trim()) return cur.stdout.trim()
  }
  const ls = await run('tmux', ['list-sessions', '-F', '#{session_name}'])
  const first = ls.stdout.split('\n').map(s => s.trim()).find(Boolean)
  return first || 'ai-link'
}

async function attachOrFocusTmuxSession(targetSession) {
  if (process.env.TMUX) {
    await run('tmux', ['switch-client', '-t', targetSession])
    return
  }
  if (process.platform === 'darwin') {
    const cliRes = await run('tmux', ['list-clients', '-t', targetSession, '-F', '#{client_tty}'])
    const clientTty = cliRes.stdout.split('\n').map(s => s.trim()).find(Boolean)
    if (clientTty) {
      await focusMacTerminal(clientTty.replace(/^\/dev\//, ''))
    } else {
      const attachCmd = `tmux attach-session -t ${shq(targetSession)}`
      const script = `tell application "Terminal"\nactivate\ndo script "${attachCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
      await run('osascript', ['-e', script])
    }
  }
}

// Performs tmux window/pane management actions: new-window, split-h, split-v, resize-*, zoom, rename, kill.
export async function tmuxControlAction(action, item = null, opts = {}) {
  const dir = (item?.cwd && fs.existsSync(item.cwd)) ? item.cwd : (opts.dir || process.cwd())
  const pane = item?.pane || ''
  const session = item?.tmuxSession || opts.tmuxSession || ''
  if (opts.logFile) {
    fs.appendFileSync(opts.logFile, JSON.stringify({ action: `tmux:${action}`, pane, session, dir, newName: opts.newName || '' }) + '\n')
    return { ok: true, message: `tmux ${action} ok` }
  }

  const targetSession = await resolveTargetTmuxSession(item, opts)
  const targetPane = pane || (opts.tmuxSidebar && opts.selfPane ? opts.selfPane : '')

  // In --tmux-sidebar mode, pick the largest non-sidebar pane so +W / +S stay balanced and never crush one corner or split the sidebar.
  let siblings = []
  let rightSiblingPane = ''
  let rightSiblingRatio = 1
  if (opts.tmuxSidebar && opts.selfPane) {
    const winPanesRes = await run('tmux', ['list-panes', '-t', opts.selfPane, '-F', '#{pane_id}\t#{pane_width}\t#{pane_height}'])
    siblings = winPanesRes.stdout
      .split('\n')
      .map(l => l.trim().split('\t'))
      .filter(parts => parts[0] && parts[0] !== opts.selfPane)
      .map(([id, w, h]) => ({ id, w: Number(w) || 0, h: Number(h) || 0, area: (Number(w) || 0) * (Number(h) || 0) }))
    const chosen = (pane && siblings.find(s => s.id === pane))
      || [...siblings].sort((a, b) => b.area - a.area)[0]
    if (chosen) {
      rightSiblingPane = chosen.id
      rightSiblingRatio = chosen.h > 0 ? chosen.w / chosen.h : 1
    }
  }

  if (action === 'new-window') {
    if (opts.tmuxSidebar && rightSiblingPane) {
      const autoFlag = rightSiblingRatio > 2.2 ? '-h' : '-v'
      const r = await run('tmux', ['split-window', autoFlag, '-t', rightSiblingPane, '-c', dir])
      if (!r.ok) return { ok: false, message: 'Could not add terminal pane (pane too small)' }
      return { ok: true, message: 'Added terminal pane' }
    }
    const has = await run('tmux', ['has-session', '-t', targetSession])
    const r = has.ok
      ? await run('tmux', ['new-window', '-t', targetSession, '-c', dir])
      : await run('tmux', ['new-session', '-d', '-s', targetSession, '-c', dir])
    if (!r.ok) return { ok: false, message: `Could not add tmux window in ${targetSession}` }
    await run('tmux', ['set-option', '-t', targetSession, 'mouse', 'on'])
    await attachOrFocusTmuxSession(targetSession)
    return { ok: true, message: `Added tmux window in ${targetSession}` }
  }

  if (action === 'split-h' || action === 'split-v') {
    const flag = action === 'split-h' ? '-h' : '-v'
    const splitTarget = rightSiblingPane || pane || targetSession
    const r = await run('tmux', ['split-window', flag, '-t', splitTarget, '-c', dir])
    if (!r.ok) return { ok: false, message: `Could not split tmux pane (${flag})` }
    if (!opts.tmuxSidebar) await attachOrFocusTmuxSession(targetSession)
    return { ok: true, message: `Split tmux pane (${action === 'split-h' ? 'horizontal' : 'vertical'})` }
  }

  if (action === 'resize-left' || action === 'resize-right' || action === 'resize-up' || action === 'resize-down') {
    const dirFlag = action === 'resize-left' ? '-L' : action === 'resize-right' ? '-R' : action === 'resize-up' ? '-U' : '-D'
    const step = (dirFlag === '-L' || dirFlag === '-R') ? '5' : '3'
    const resizeTarget = opts.tmuxSidebar && opts.selfPane
      ? (pane && siblings.some(s => s.id === pane) ? pane : opts.selfPane)
      : (targetPane || targetSession)
    const r = await run('tmux', ['resize-pane', '-t', resizeTarget, dirFlag, step])
    return r.ok ? { ok: true, message: `Resized tmux pane (${dirFlag} ${step})` } : { ok: false, message: 'No tmux pane to resize' }
  }

  if (action === 'zoom') {
    const zoomTarget = (pane && pane !== opts.selfPane) ? pane : (rightSiblingPane || targetSession)
    const r = await run('tmux', ['resize-pane', '-Z', '-t', zoomTarget])
    return r.ok ? { ok: true, message: 'Toggled tmux pane zoom' } : { ok: false, message: 'No tmux pane to zoom' }
  }

  if (action === 'rename') {
    const name = String(opts.newName || '').trim()
    if (!name) return { ok: false, message: 'Window name cannot be empty' }
    const args = ['rename-window']
    if (pane) args.push('-t', pane)
    else args.push('-t', targetSession)
    args.push(name)
    const r = await run('tmux', args)
    return r.ok ? { ok: true, message: `Renamed tmux window to "${name}"` } : { ok: false, message: 'Could not rename tmux window' }
  }

  if (action === 'kill') {
    let killTarget = (pane && pane !== opts.selfPane) ? pane : ''
    if (!killTarget && opts.tmuxSidebar) {
      if (siblings.length > 1) killTarget = siblings[siblings.length - 1].id
      else return { ok: false, message: 'Only 1 terminal pane left' }
    }
    if (!killTarget) return { ok: false, message: 'Select a tmux window/pane first to close it' }
    const pidRes = await run('tmux', ['display-message', '-p', '-t', killTarget, '#{pane_pid}'])
    const panePid = pidRes.stdout.trim()
    const r = await run('tmux', ['kill-pane', '-t', killTarget])
    if (r.ok && /^\d+$/.test(panePid)) {
      const reaper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmux-reap.sh')
      try {
        const child = spawn(reaper, ['pid', panePid], { detached: true, stdio: 'ignore' })
        child.unref()
      } catch {
        // reaper optional
      }
    }
    return r.ok ? { ok: true, message: `Closed pane ${item?.pane === killTarget ? (item.name || killTarget) : killTarget}` } : { ok: false, message: `Could not close ${killTarget}` }
  }

  return { ok: false, message: `Unknown tmux action: ${action}` }
}

// ---------- ANSI TUI Rendering ----------
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inv: '\x1b[7m',
  cyan: '\x1b[38;5;81m',
  green: '\x1b[38;5;114m',
  magenta: '\x1b[38;5;177m',
  yellow: '\x1b[38;5;221m',
  red: '\x1b[38;5;203m',
  white: '\x1b[38;5;255m',
  muted: '\x1b[38;5;244m',
  subtle: '\x1b[38;5;239m',
  gray: '\x1b[38;5;245m',
  bgBlue: '\x1b[48;5;25m\x1b[38;5;255m',
  bgBar: '\x1b[48;5;235m',
  bgPill: '\x1b[48;5;238m',
  bgAgy: '\x1b[48;5;54m\x1b[38;5;225m',
  bgClaude: '\x1b[48;5;24m\x1b[38;5;195m',
  bgCodex: '\x1b[48;5;22m\x1b[38;5;157m',
  bgTmux: '\x1b[48;5;58m\x1b[38;5;229m',
}

const CLI_COLOR = {
  claude: ANSI.cyan,
  codex: ANSI.green,
  agy: ANSI.magenta,
  tmux: ANSI.yellow,
}

const CLI_BADGE = {
  claude: ANSI.bgClaude,
  codex: ANSI.bgCodex,
  agy: ANSI.bgAgy,
  tmux: ANSI.bgTmux,
}

const clip = (str, max) => {
  if (max <= 0) return ''
  return str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str
}

const CLI_KEY_HINT = {
  agy: 'a/A',
  claude: 'c/C',
  codex: 'x/X',
}

const DASHBOARD_ORDER = ['agy', 'claude', 'codex']

const padRight = (str, len) => {
  const s = clip(String(str || ''), len)
  return s + ' '.repeat(Math.max(0, len - s.length))
}

const padLeft = (str, len) => {
  const s = clip(String(str || ''), len)
  return ' '.repeat(Math.max(0, len - s.length)) + s
}

// Places every line at an explicit 1-based terminal row with auto-wrap disabled (\x1b[?7l)
// so a single wide line can NEVER wrap and shift clickable buttonMap/rowMap/hitMap coordinates.
const renderPositionedScreen = (lines, rows) => {
  const limit = Math.min(lines.length, rows)
  let out = '\x1b[?7l\x1b[H\x1b[2J'
  for (let i = 0; i < limit; i++) {
    out += `\x1b[${i + 1};1H${lines[i]}${ANSI.reset}`
  }
  return out
}

const TOP_LEFT_WIDE_BUTTONS = [
  { label: '[+Win]', action: 'new-window', color: ANSI.green },
  { label: '[+SplitH]', action: 'split-h', color: ANSI.cyan },
  { label: '[+SplitV]', action: 'split-v', color: ANSI.cyan },
  { label: '[◀]', action: 'resize-left', color: ANSI.yellow },
  { label: '[▶]', action: 'resize-right', color: ANSI.yellow },
  { label: '[Zoom]', action: 'zoom', color: ANSI.magenta },
  { label: '[Rename]', action: 'rename', color: ANSI.yellow },
  { label: '[×Kill]', action: 'kill', color: ANSI.red },
]

const TOP_LEFT_NARROW_BUTTONS = [
  { label: '[+W]', action: 'new-window', color: ANSI.green },
  { label: '[+H]', action: 'split-h', color: ANSI.cyan },
  { label: '[+V]', action: 'split-v', color: ANSI.cyan },
  { label: '[◀]', action: 'resize-left', color: ANSI.yellow },
  { label: '[▶]', action: 'resize-right', color: ANSI.yellow },
  { label: '[×]', action: 'kill', color: ANSI.red },
]

const TOP_LEFT_COMPACT_BUTTONS = [
  { label: '[+H]', action: 'split-h', color: ANSI.cyan },
  { label: '[+V]', action: 'split-v', color: ANSI.cyan },
  { label: '[◀]', action: 'resize-left', color: ANSI.yellow },
  { label: '[▶]', action: 'resize-right', color: ANSI.yellow },
  { label: '[×]', action: 'kill', color: ANSI.red },
]

function buildTopLeftToolbar(buttons, row, maxCols, bg = ANSI.bgBar) {
  let col = 2 // 1-based leading space
  let plainLen = 1
  let text = `${bg} `
  const buttonMap = []
  for (const b of buttons) {
    if (plainLen + b.label.length + 1 > maxCols) break
    const colStart = col
    const colEnd = col + b.label.length - 1
    buttonMap.push({ row, colStart, colEnd, action: b.action, label: b.label })
    text += `${ANSI.bgPill}${ANSI.bold}${b.color}${b.label}${ANSI.reset}${bg} `
    col = colEnd + 2
    plainLen += b.label.length + 1
  }
  return { text, plainLen, buttonMap }
}

function renderThreeTables({ groups = [], selectedIndex = 0, width = 120, height = 36, status = '', now = Date.now() } = {}) {
  const cols = Math.max(78, width)
  const rows = Math.max(12, height)

  // Map each item in groups to its flat index (preserving buildSessionGroups flat order).
  const byCli = new Map()
  let flatIdx = 0
  for (const g of groups) {
    const entries = g.items.map(item => ({ item, idx: flatIdx++ }))
    byCli.set(g.cli, entries)
  }

  const columns = DASHBOARD_ORDER.map(cli => ({
    cli,
    entries: byCli.get(cli) || [],
  }))
  const tmuxEntries = byCli.get('tmux') || []
  const tmuxPanelRows = tmuxEntries.length > 0 ? Math.min(4, tmuxEntries.length) : 0
  const tmuxChromeRows = tmuxPanelRows > 0 ? tmuxPanelRows + 3 : 0

  const total = flatIdx
  const liveCount = groups.reduce((n, g) => n + g.items.filter(i => !i.isPast).length, 0)
  const pastCount = total - liveCount

  // Layout geometry: 3 equal-width tables with 1-space gap between them.
  const gap = 1
  const tableW = Math.floor((cols - gap * 2) / 3)
  const innerW = Math.max(20, tableW - 2) // inside │ ... │
  const bodyRows = Math.max(3, rows - 10 - tmuxChromeRows)

  // Top bar (row 1): sleek dark strip with clickable pill controls on top-left & title/counts on right
  const summaryRight = `AI-LINK SESSION PICKER  ● ${liveCount} live · ↺ ${pastCount} past `
  const barBudget = Math.max(18, cols - summaryRight.length - 1)
  const toolbar = buildTopLeftToolbar(TOP_LEFT_WIDE_BUTTONS, 1, barBudget, ANSI.bgBar)
  const buttonMap = [...toolbar.buttonMap]
  const rightBudget = Math.max(10, cols - toolbar.plainLen - 1)
  const rightShown = clip(summaryRight, rightBudget)
  const bannerPad = Math.max(1, cols - toolbar.plainLen - rightShown.length)
  const topLines = [
    `${toolbar.text}${' '.repeat(bannerPad)}${ANSI.bold}${ANSI.cyan}${rightShown}${ANSI.reset}`,
    `${ANSI.subtle}${'─'.repeat(cols)}${ANSI.reset}`,
  ]

  // Build each table as an array of rendered strings (exact visual width = tableW) + hit regions.
  const hitMap = [] // { row (1-based), colStart (1-based), colEnd (1-based), flatIdx }
  const rowMap = new Map()
  const renderedTables = columns.map((colDef, colPos) => {
    const color = CLI_COLOR[colDef.cli] || ANSI.yellow
    const badge = CLI_BADGE[colDef.cli] || ANSI.bgPill
    const entries = colDef.entries
    const liveIn = entries.filter(e => !e.item.isPast).length
    const pastIn = entries.length - liveIn
    const selPos = entries.findIndex(e => e.idx === selectedIndex)
    const isActiveCol = selPos >= 0

    let scrollTop = 0
    if (entries.length > bodyRows) {
      const anchor = selPos >= 0 ? selPos : 0
      scrollTop = Math.max(0, Math.min(anchor - Math.floor(bodyRows / 2), entries.length - bodyRows))
    }

    const borderColor = isActiveCol ? color : ANSI.subtle
    const colStart = colPos * (tableW + gap) + 1
    const colEnd = colStart + tableW - 1

    const lines = []
    // Rounded top border
    lines.push(`${borderColor}╭${'─'.repeat(innerW)}╮${ANSI.reset}`)

    // Title row with colored pill badge + live/past count + hotkey hint
    const titleText = `${colDef.cli.toUpperCase()} (${liveIn} live · ${pastIn} past)`
    const rightHint = `[${CLI_KEY_HINT[colDef.cli] || ''}] `
    const titleBudget = Math.max(6, innerW - rightHint.length - 1)
    const shownTitle = clip(titleText, titleBudget)
    const titlePad = ' '.repeat(Math.max(0, innerW - shownTitle.length - 1 - rightHint.length))
    lines.push(
      `${borderColor}│${ANSI.reset}${ANSI.bgBar} ${badge}${ANSI.bold}${shownTitle}${ANSI.reset}${ANSI.bgBar}${titlePad}${ANSI.muted}${rightHint}${ANSI.reset}${borderColor}│${ANSI.reset}`
    )

    // Column subheader
    const dirW = innerW >= 42 ? 11 : innerW >= 32 ? 8 : 0
    const metaW = 7
    const fixedW = 6 + (dirW ? dirW + 1 : 0) + metaW + 2
    const nameW = Math.max(6, innerW - fixedW)
    const hdrName = padRight('SESSION', nameW)
    const hdrDir = dirW ? ` ${padRight('FOLDER', dirW)}` : ''
    const hdrMeta = ` ${padLeft('LOC/AGE', metaW)}`
    const hdrLine = padRight(` # ST ${hdrName}${hdrDir}${hdrMeta} `, innerW)
    lines.push(`${borderColor}│${ANSI.reset}${ANSI.muted}${hdrLine}${ANSI.reset}${borderColor}│${ANSI.reset}`)
    lines.push(`${borderColor}├${'─'.repeat(innerW)}┤${ANSI.reset}`)

    // Body rows (1-based terminal row of first body row = topLines.length + 4 + 1 = 7)
    const firstBodyTermRow = topLines.length + 4 + 1
    for (let r = 0; r < bodyRows; r++) {
      const entry = entries[scrollTop + r]
      if (!entry) {
        if (r === 0 && entries.length === 0) {
          lines.push(`${borderColor}│${ANSI.reset}${ANSI.muted}${padRight('   (no sessions)', innerW)}${ANSI.reset}${borderColor}│${ANSI.reset}`)
        } else {
          lines.push(`${borderColor}│${' '.repeat(innerW)}│${ANSI.reset}`)
        }
        continue
      }
      const { item, idx } = entry
      const isSel = idx === selectedIndex
      const num = idx < 9 ? `${idx + 1}` : ' '
      const dot = item.isPast ? '↺' : item.tmuxActive ? '◆' : item.isHost ? '★' : '●'
      const rightTag = item.isPast
        ? ago(now - item.seen)
        : item.pane
          ? item.pane
          : item.tty
            ? item.tty.replace(/^ttys/, 't')
            : ago(now - item.seen)

      const nameCol = padRight(item.name, nameW)
      const dirCol = dirW ? ` ${padRight(folderBase(item.cwd), dirW)}` : ''
      const metaCol = ` ${padLeft(rightTag, metaW)}`
      const termRow = firstBodyTermRow + r
      hitMap.push({ row: termRow, colStart, colEnd, flatIdx: idx })
      if (!rowMap.has(termRow)) rowMap.set(termRow, idx)

      if (isSel) {
        const fullRow = padRight(`▶${num} ${dot} ${nameCol}${dirCol}${metaCol} `, innerW)
        lines.push(`${borderColor}│${ANSI.reset}${ANSI.bgBlue}${ANSI.bold}${fullRow}${ANSI.reset}${borderColor}│${ANSI.reset}`)
      } else if (item.isPast) {
        const tailStr = `${dirCol}${metaCol} `
        const used = 5 + nameCol.length + tailStr.length
        const extraPad = ' '.repeat(Math.max(0, innerW - used))
        lines.push(
          `${borderColor}│${ANSI.reset}${ANSI.subtle} ${num} ${ANSI.reset}${ANSI.muted}${dot} ${ANSI.gray}${nameCol}${ANSI.muted}${tailStr}${extraPad}${ANSI.reset}${borderColor}│${ANSI.reset}`
        )
      } else {
        const dotColor = item.tmuxActive ? ANSI.cyan : item.isHost ? ANSI.yellow : ANSI.green
        const tailStr = `${dirCol}${metaCol} `
        const used = 5 + nameCol.length + tailStr.length
        const extraPad = ' '.repeat(Math.max(0, innerW - used))
        lines.push(
          `${borderColor}│${ANSI.reset}${ANSI.muted} ${num} ${ANSI.reset}${dotColor}${dot}${ANSI.reset} ${ANSI.bold}${ANSI.white}${nameCol}${ANSI.reset}${ANSI.muted}${tailStr}${extraPad}${ANSI.reset}${borderColor}│${ANSI.reset}`
        )
      }
    }

    // Rounded bottom border (with scroll indicator if overflowing)
    const scrollInfo = entries.length > bodyRows ? ` ${scrollTop + 1}–${Math.min(entries.length, scrollTop + bodyRows)} / ${entries.length} ` : ''
    const leftDash = Math.max(0, innerW - scrollInfo.length)
    lines.push(`${borderColor}╰${'─'.repeat(leftDash)}${ANSI.muted}${scrollInfo}${borderColor}╯${ANSI.reset}`)
    return lines
  })

  // Stitch the 3 tables horizontally
  const tableLineCount = renderedTables[0].length
  const stitched = []
  for (let i = 0; i < tableLineCount; i++) {
    stitched.push(renderedTables.map(t => t[i]).join(' '.repeat(gap)))
  }

  // Optional full-width TMUX WINDOWS panel below the 3 big tables when non-AI tmux windows exist.
  const tmuxLines = []
  const allColumns = [...columns]
  if (tmuxPanelRows > 0) {
    allColumns.push({ cli: 'tmux', entries: tmuxEntries })
    const fullW = tableW * 3 + gap * 2
    const fullInner = Math.max(20, fullW - 2)
    const selPos = tmuxEntries.findIndex(e => e.idx === selectedIndex)
    const isActiveTmux = selPos >= 0
    const bc = isActiveTmux ? ANSI.yellow : ANSI.subtle
    let tScroll = 0
    if (tmuxEntries.length > tmuxPanelRows) {
      const anchor = selPos >= 0 ? selPos : 0
      tScroll = Math.max(0, Math.min(anchor - Math.floor(tmuxPanelRows / 2), tmuxEntries.length - tmuxPanelRows))
    }
    const headerTitle = ` TMUX WINDOWS (${tmuxEntries.length}) · Enter/click to attach `
    const dashLen = Math.max(0, fullInner - headerTitle.length)
    tmuxLines.push(`${bc}╭${ANSI.bgTmux}${ANSI.bold}${headerTitle}${ANSI.reset}${bc}${'─'.repeat(dashLen)}╮${ANSI.reset}`)
    const firstTmuxTermRow = topLines.length + stitched.length + 2
    for (let r = 0; r < tmuxPanelRows; r++) {
      const { item, idx } = tmuxEntries[tScroll + r]
      const isSel = idx === selectedIndex
      const num = idx < 9 ? `${idx + 1}` : ' '
      const dot = item.tmuxActive ? '◆' : '●'
      const stateTag = item.tmuxAttached ? 'attached' : 'detached'
      const meta = `${item.pane} ${stateTag}`
      const dirStr = folderBase(item.cwd)
      const nameBudget = Math.max(10, fullInner - 7 - dirStr.length - meta.length - 3)
      const rowText = padRight(`${isSel ? '▶' : ' '}${num} ${dot} ${padRight(item.name, nameBudget)} ${dirStr}  ${meta} `, fullInner)
      const termRow = firstTmuxTermRow + r
      hitMap.push({ row: termRow, colStart: 1, colEnd: fullW, flatIdx: idx })
      if (!rowMap.has(termRow)) rowMap.set(termRow, idx)
      if (isSel) {
        tmuxLines.push(`${bc}│${ANSI.reset}${ANSI.bgBlue}${ANSI.bold}${rowText}${ANSI.reset}${bc}│${ANSI.reset}`)
      } else {
        tmuxLines.push(`${bc}│${ANSI.reset}${ANSI.yellow}${rowText}${ANSI.reset}${bc}│${ANSI.reset}`)
      }
    }
    const scrollInfo = tmuxEntries.length > tmuxPanelRows ? ` ${tScroll + 1}–${Math.min(tmuxEntries.length, tScroll + tmuxPanelRows)} / ${tmuxEntries.length} ` : ''
    tmuxLines.push(`${bc}╰${'─'.repeat(Math.max(0, fullInner - scrollInfo.length))}${ANSI.muted}${scrollInfo}${bc}╯${ANSI.reset}`)
  }

  const statusText = status
    ? ` ${clip(status, cols - 2)}`
    : ` ${clip('↑↓ move · ←→/Tab table · Enter/click switch·resume · t resume in tmux', cols - 2)}`
  const statusLine = status
    ? `${ANSI.bgBar}${ANSI.bold}${ANSI.yellow}${padRight(statusText, cols)}${ANSI.reset}`
    : `${ANSI.bgBar}${ANSI.muted}${padRight(statusText, cols)}${ANSI.reset}`
  const helpText = ` ${clip('n:+Win  s:+Split  v:+VSplit  [/]:resize  z:zoom  m:rename  K:kill  ·  a/c/x new  A/C/X cont  p past  q quit', cols - 2)}`
  const helpLine = `${ANSI.bgBar}${ANSI.gray}${padRight(helpText, cols)}${ANSI.reset}`

  const screen = renderPositionedScreen(
    [...topLines, ...stitched, ...tmuxLines, `${ANSI.subtle}${'─'.repeat(cols)}${ANSI.reset}`, statusLine, helpLine],
    rows,
  )
  return { screen, rowMap, hitMap, buttonMap, layout: 'tables', columns: allColumns }
}

export function renderSidebar({ groups = [], selectedIndex = 0, width = 32, height = 24, status = '', mode = 'standalone', now = Date.now() } = {}) {
  if (mode !== 'tmux' && width >= 78) {
    return renderThreeTables({ groups, selectedIndex, width, height, status, now })
  }
  const cols = Math.max(20, width)
  const rows = Math.max(10, height)
  const headerLines = []
  const bodyLines = [] // { text, flatIdx?: number }

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const liveCount = groups.reduce((n, g) => n + g.items.filter(i => !i.isPast).length, 0)
  const title = mode === 'tmux' ? 'AI-LINK WORKSPACE' : 'AI-LINK SESSIONS'
  const countBadge = liveCount === total ? `(${total})` : `(${liveCount}/${total})`
  const titleBudget = Math.max(4, cols - countBadge.length - 2)
  const titleShown = clip(` ${title}`, titleBudget)
  const titlePad = ' '.repeat(Math.max(1, cols - titleShown.length - countBadge.length - 1))
  headerLines.push(`${ANSI.bgBar}${ANSI.bold}${ANSI.cyan}${titleShown}${ANSI.reset}${ANSI.bgBar}${titlePad}${ANSI.muted}${countBadge} ${ANSI.reset}`)
  const narrowButtons = cols >= 28 ? TOP_LEFT_NARROW_BUTTONS : TOP_LEFT_COMPACT_BUTTONS
  const narrowBar = buildTopLeftToolbar(narrowButtons, 2, cols, ANSI.bgBar)
  const barFill = ' '.repeat(Math.max(0, cols - narrowBar.plainLen))
  headerLines.push(`${narrowBar.text}${barFill}${ANSI.reset}`)
  headerLines.push(`${ANSI.subtle}${'─'.repeat(cols)}${ANSI.reset}`)

  let flatIdx = 0
  let selectedLineIdx = 0
  for (const g of groups) {
    const badge = CLI_BADGE[g.cli] || ANSI.bgPill
    const liveInGroup = g.items.filter(i => !i.isPast).length
    const pastInGroup = g.items.length - liveInGroup
    const cliTag = ` ${g.cli.toUpperCase()} `
    const rawCount = g.items.length === 0
      ? 'none'
      : pastInGroup > 0
        ? `${liveInGroup} live · ${pastInGroup} past`
        : `${g.items.length}`
    const countBudget = Math.max(0, cols - 3 - cliTag.length) // "╭ " + cliTag + " "
    const clippedCount = countBudget > 0 ? clip(rawCount, countBudget) : ''
    bodyLines.push({ text: `${ANSI.subtle}╭${ANSI.reset} ${badge}${ANSI.bold}${cliTag}${ANSI.reset}${clippedCount ? ` ${ANSI.muted}${clippedCount}${ANSI.reset}` : ''}` })

    if (g.items.length === 0) {
      bodyLines.push({ text: `${ANSI.subtle}│${ANSI.reset} ${ANSI.muted}${clip('(no sessions)', Math.max(1, cols - 2))}${ANSI.reset}` })
    } else {
      for (const item of g.items) {
        const idx = flatIdx++
        const isSel = idx === selectedIndex
        const num = idx < 9 ? `${idx + 1}` : ' '
        const dot = item.isPast ? '↺' : item.tmuxActive ? '◆' : item.isHost ? '★' : '●'
        const folder = folderBase(item.cwd)
        const rightTag = item.isPast
          ? ago(now - item.seen)
          : item.pane
            ? item.pane
            : item.tty
              ? item.tty.replace(/^ttys/, 't')
              : ago(now - item.seen)
        const suffix = folder ? ` ${folder}` : ''
        const meta = rightTag ? ` ${rightTag}` : ''
        // Visual width of left gutter: "▶" + num + " " + dot + " " = 5 chars (or "│" + num + " " + dot + " " = 5 chars)
        const leftW = 5
        const bodyBudget = Math.max(4, cols - leftW - meta.length)
        const nameShown = clip(item.name, bodyBudget)
        const suffixBudget = Math.max(0, bodyBudget - nameShown.length)
        const suffixShown = suffixBudget > 2 ? clip(suffix, suffixBudget) : ''
        const usedW = leftW + nameShown.length + suffixShown.length + meta.length
        const pad = ' '.repeat(Math.max(0, cols - usedW))

        if (isSel) selectedLineIdx = bodyLines.length
        if (isSel) {
          bodyLines.push({
            flatIdx: idx,
            text: `${ANSI.bgBlue}${ANSI.bold}▶${num} ${dot} ${nameShown}${suffixShown}${pad}${meta}${ANSI.reset}`,
          })
        } else if (item.isPast) {
          bodyLines.push({
            flatIdx: idx,
            text: `${ANSI.subtle}│${num} ${ANSI.muted}${dot} ${ANSI.gray}${nameShown}${ANSI.muted}${suffixShown}${pad}${meta}${ANSI.reset}`,
          })
        } else {
          const dotColor = item.tmuxActive ? ANSI.cyan : item.isHost ? ANSI.yellow : ANSI.green
          bodyLines.push({
            flatIdx: idx,
            text: `${ANSI.subtle}│${ANSI.muted}${num} ${dotColor}${dot}${ANSI.reset} ${ANSI.bold}${ANSI.white}${nameShown}${ANSI.reset}${ANSI.muted}${suffixShown}${pad}${meta}${ANSI.reset}`,
          })
        }
      }
    }
    bodyLines.push({ text: '' })
  }

  // Reserve header rows + 3 footer rows (divider, status, help). Scroll body around selected item.
  const maxBody = Math.max(4, rows - headerLines.length - 3)
  let scrollTop = 0
  if (bodyLines.length > maxBody) {
    scrollTop = Math.max(0, Math.min(selectedLineIdx - Math.floor(maxBody / 2), bodyLines.length - maxBody))
  }
  const visibleBody = bodyLines.slice(scrollTop, scrollTop + maxBody)
  const rowMap = new Map() // 1-based terminal row -> flat index
  for (let i = 0; i < visibleBody.length; i++) {
    if (visibleBody[i].flatIdx !== undefined) {
      rowMap.set(headerLines.length + i + 1, visibleBody[i].flatIdx)
    }
  }
  const renderedBody = visibleBody.map(l => l.text)
  while (renderedBody.length < maxBody) renderedBody.push('')

  const statusText = status ? ` ${clip(status, cols - 2)}` : ` ${clip('↑↓/click switch·resume · 1-9', cols - 2)}`
  const statusLine = status
    ? `${ANSI.bgBar}${ANSI.bold}${ANSI.yellow}${padRight(statusText, cols)}${ANSI.reset}`
    : `${ANSI.bgBar}${ANSI.muted}${padRight(statusText, cols)}${ANSI.reset}`
  const helpLine = `${ANSI.bgBar}${ANSI.gray}${padRight(` ${clip('h:+H v:+V [/]:sz a/c/x q', cols - 2)}`, cols)}${ANSI.reset}`

  const screen = renderPositionedScreen(
    [...headerLines, ...renderedBody, `${ANSI.subtle}${'─'.repeat(cols)}${ANSI.reset}`, statusLine, helpLine],
    rows,
  )
  return { screen, rowMap, buttonMap: narrowBar.buttonMap }
}

// ---------- CLI Entrypoint ----------
async function main() {
  const args = process.argv.slice(2)
  const hasFlag = f => args.includes(f)
  const flagVal = f => {
    const i = args.indexOf(f)
    return i >= 0 && i + 1 < args.length ? args[i + 1] : ''
  }

  const tmuxSidebar = hasFlag('--tmux-sidebar')
  const inTmux = hasFlag('--tmux') || Boolean(process.env.TMUX)
  const intervalMs = Math.max(500, Number(flagVal('--interval')) || 2000)
  const dir = flagVal('--dir') || process.cwd()
  const selfPane = process.env.TMUX_PANE || ''
  let includePast = !hasFlag('--live-only')
  const pastLimitRaw = flagVal('--past-limit')
  const pastLimit = pastLimitRaw ? Math.max(0, Number(pastLimitRaw)) : Infinity

  let tmuxSession = ''
  if (tmuxSidebar && selfPane) {
    const r = await run('tmux', ['display-message', '-p', '-t', selfPane, '#{session_name}'])
    tmuxSession = r.stdout.trim()
  }

  let selfTty = ''
  try {
    if (process.platform !== 'win32') {
      selfTty = execFileSync('ps', ['-o', 'tty=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim().replace(/^\/dev\//, '')
      if (selfTty.startsWith('?')) selfTty = ''
    }
  } catch {
    selfTty = ''
  }

  const continueTarget = flagVal('--continue')
  if (continueTarget) {
    const res = await continueLatestCli(continueTarget, { tmuxSidebar, inTmux, tmuxSession, selfPane, dir })
    process.stdout.write(`${res.message}\n`)
    if (!res.ok) process.exitCode = 1
    return
  }

  if (hasFlag('--json') || hasFlag('--list')) {
    const now = Date.now()
    const { groups, flat } = await discoverSessions({ selfPane, selfTty, includePast, limitPerCli: pastLimit })
    if (hasFlag('--json')) {
      process.stdout.write(JSON.stringify({ groups, total: flat.length }, null, 2) + '\n')
    } else {
      for (const g of groups) {
        process.stdout.write(`${g.cli.toUpperCase()} (${g.items.length})\n`)
        for (const i of g.items) {
          if (i.isPast) {
            process.stdout.write(`  ↺ ${i.name}  ${folderBase(i.cwd)}  [resume:${i.sessionId.slice(0, 8)} · ${ago(now - i.seen)}]\n`)
          } else {
            const loc = i.pane ? `tmux:${i.tmuxSession}:${i.pane}` : i.tty || 'no-tty'
            process.stdout.write(`  ${i.isHost ? '★ ' : '● '}${i.name}  ${folderBase(i.cwd)}  [${loc}]\n`)
          }
        }
      }
    }
    return
  }

  const focusTarget = flagVal('--focus')
  if (focusTarget) {
    const { flat } = await discoverSessions({ selfPane, selfTty, includePast, limitPerCli: pastLimit })
    const q = focusTarget.toLowerCase()
    const match = flat.find(i => i.name.toLowerCase() === q || i.id === focusTarget || i.sessionId === focusTarget || i.pane === focusTarget || i.tty === focusTarget)
      || flat.find(i => i.name.toLowerCase().startsWith(q) || (i.sessionId && i.sessionId.startsWith(focusTarget)))
    if (!match) {
      process.stderr.write(`No session matches "${focusTarget}"\n`)
      process.exitCode = 1
      return
    }
    const res = await focusSession(match, { tmuxSidebar, inTmux, tmuxSession, selfPane, dir })
    process.stdout.write(`${res.message}\n`)
    if (!res.ok) process.exitCode = 1
    return
  }

  if (!process.stdin.isTTY) {
    process.stderr.write('picker.mjs requires an interactive terminal (or pass --list / --json / --focus <name>).\n')
    process.exitCode = 1
    return
  }

  // Interactive TUI loop
  let state = { groups: PRIMARY_ORDER.map(cli => ({ cli, items: [] })), flat: [] }
  let selectedIndex = 0
  let status = ''
  let rowMap = new Map()
  let hitMap = []
  let buttonMap = []
  let tableColumns = []
  let renameMode = false
  let renameBuf = ''
  let busy = false

  const draw = () => {
    const cols = process.stdout.columns || 120
    const rows = process.stdout.rows || 36
    const shownStatus = renameMode ? `Rename tmux window: ${renameBuf}█  (Enter save · Esc cancel)` : status
    const rendered = renderSidebar({
      groups: state.groups,
      selectedIndex,
      width: cols,
      height: rows,
      status: shownStatus,
      mode: tmuxSidebar ? 'tmux' : 'standalone',
    })
    rowMap = rendered.rowMap
    hitMap = rendered.hitMap || []
    buttonMap = rendered.buttonMap || []
    tableColumns = rendered.columns || []
    process.stdout.write(rendered.screen)
  }

  const runTmuxAction = async (action, extra = {}) => {
    const item = state.flat[selectedIndex] || null
    if (action === 'rename' && !extra.newName) {
      renameMode = true
      renameBuf = item?.tmuxSession ? (item.name || '') : ''
      draw()
      return
    }
    status = `tmux: ${action}…`
    draw()
    const res = await tmuxControlAction(action, item, { tmuxSidebar, tmuxSession, selfPane, dir, ...extra })
    status = res.message
    await refresh()
  }

  const moveTable = delta => {
    const nonEmpty = tableColumns.filter(c => c.entries.length > 0)
    if (nonEmpty.length === 0) return
    let curCol = nonEmpty.findIndex(c => c.entries.some(e => e.idx === selectedIndex))
    let curRow = 0
    if (curCol >= 0) {
      curRow = Math.max(0, nonEmpty[curCol].entries.findIndex(e => e.idx === selectedIndex))
    } else {
      curCol = 0
    }
    const nextCol = (curCol + delta + nonEmpty.length) % nonEmpty.length
    const targetEntries = nonEmpty[nextCol].entries
    selectedIndex = targetEntries[Math.min(curRow, targetEntries.length - 1)].idx
    status = ''
    draw()
  }

  const moveRow = delta => {
    if (!state.flat.length) return
    if (tableColumns.length > 0) {
      const col = tableColumns.find(c => c.entries.some(e => e.idx === selectedIndex))
      if (col && col.entries.length > 0) {
        const pos = col.entries.findIndex(e => e.idx === selectedIndex)
        const nextPos = (pos + delta + col.entries.length) % col.entries.length
        selectedIndex = col.entries[nextPos].idx
        status = ''
        draw()
        return
      }
    }
    selectedIndex = (selectedIndex + delta + state.flat.length) % state.flat.length
    status = ''
    draw()
  }

  const refresh = async () => {
    if (busy) return
    busy = true
    try {
      const prevKey = state.flat[selectedIndex]?.key
      state = await discoverSessions({ selfPane, selfTty, includePast, limitPerCli: pastLimit })
      if (prevKey) {
        const nextIdx = state.flat.findIndex(i => i.key === prevKey)
        selectedIndex = nextIdx >= 0 ? nextIdx : Math.min(selectedIndex, Math.max(0, state.flat.length - 1))
      } else {
        selectedIndex = Math.min(selectedIndex, Math.max(0, state.flat.length - 1))
      }
      draw()
    } finally {
      busy = false
    }
  }

  const activate = async (idx, extraOpts = {}) => {
    const item = state.flat[idx]
    if (!item) return
    selectedIndex = idx
    const useTmux = Boolean(extraOpts.inTmux ?? inTmux)
    status = item.isPast
      ? `Resuming ${item.name}${useTmux ? ' in tmux' : ''}…`
      : `Switching to ${item.name}…`
    draw()
    const res = await focusSession(item, { tmuxSidebar, inTmux: useTmux, tmuxSession, selfPane, dir })
    status = res.message
    draw()
  }

  const cleanup = () => {
    // Re-enable auto-wrap, disable mouse tracking, show cursor, leave alternate screen
    process.stdout.write('\x1b[?7h\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l')
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.stdout.on('resize', draw)

  // Enter alternate screen, hide cursor, enable SGR mouse tracking
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  process.stdin.on('data', async chunk => {
    // SGR mouse event: \x1b[<button;col;rowM (press) or m (release)
    const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
    let m
    let handledMouse = false
    while ((m = mouseRe.exec(chunk)) !== null) {
      handledMouse = true
      const btn = Number(m[1])
      const col = Number(m[2])
      const row = Number(m[3])
      const kind = m[4]
      if (kind === 'M' && btn === 0) {
        const btnHit = buttonMap.find(b => b.row === row && col >= b.colStart && col <= b.colEnd)
        if (btnHit) {
          await runTmuxAction(btnHit.action)
          continue
        }
        const hit = hitMap.find(h => h.row === row && col >= h.colStart && col <= h.colEnd)
        const idx = hit !== undefined ? hit.flatIdx : rowMap.get(row)
        if (idx !== undefined) await activate(idx)
      } else if (kind === 'M' && btn === 64) {
        moveRow(-1)
      } else if (kind === 'M' && btn === 65) {
        moveRow(1)
      }
    }
    if (handledMouse) return

    // Inline rename prompt for tmux windows
    if (renameMode) {
      if (chunk === '\x03' || chunk === '\x1b') {
        renameMode = false
        renameBuf = ''
        status = 'Rename cancelled'
        draw()
        return
      }
      if (chunk === '\r' || chunk === '\n') {
        const newName = renameBuf.trim()
        renameMode = false
        renameBuf = ''
        await runTmuxAction('rename', { newName })
        return
      }
      if (chunk === '\x7f' || chunk === '\b') {
        renameBuf = renameBuf.slice(0, -1)
        draw()
        return
      }
      if (chunk.length === 1 && chunk >= ' ' && chunk <= '~') {
        renameBuf += chunk
        draw()
      }
      return
    }

    if (chunk === '\x03' || chunk === 'q' || chunk === 'Q') {
      cleanup()
      return
    }
    if (chunk === '\x1b[A' || chunk === 'k') {
      moveRow(-1)
    } else if (chunk === '\x1b[B' || chunk === 'j') {
      moveRow(1)
    } else if (chunk === '\x1b[5~') {
      moveRow(-10)
    } else if (chunk === '\x1b[6~') {
      moveRow(10)
    } else if (chunk === '\x1b[D' || chunk === 'h') {
      moveTable(-1)
    } else if (chunk === '\x1b[C' || chunk === 'l' || chunk === '\t') {
      moveTable(1)
    } else if (chunk === '\r' || chunk === '\n' || chunk === ' ') {
      await activate(selectedIndex)
    } else if (/^[1-9]$/.test(chunk)) {
      const idx = Number(chunk) - 1
      if (idx < state.flat.length) await activate(idx)
    } else if (chunk === 'r' || chunk === 'R') {
      status = 'Refreshing…'
      draw()
      await refresh()
      status = ''
      draw()
    } else if (chunk === 'p' || chunk === 'P') {
      includePast = !includePast
      status = includePast ? 'Showing live + past sessions' : 'Showing live sessions only'
      await refresh()
    } else if (chunk === 'n' || chunk === 'N') {
      await runTmuxAction('new-window')
    } else if (chunk === 's' || chunk === 'S') {
      await runTmuxAction('split-h')
    } else if (chunk === 'v' || chunk === 'V') {
      await runTmuxAction('split-v')
    } else if (chunk === '[' || chunk === '-' || chunk === '<') {
      await runTmuxAction('resize-left')
    } else if (chunk === ']' || chunk === '+' || chunk === '=' || chunk === '>') {
      await runTmuxAction('resize-right')
    } else if (chunk === '{') {
      await runTmuxAction('resize-up')
    } else if (chunk === '}') {
      await runTmuxAction('resize-down')
    } else if (chunk === 'z' || chunk === 'Z') {
      await runTmuxAction('zoom')
    } else if (chunk === 'm' || chunk === 'M') {
      await runTmuxAction('rename')
    } else if (chunk === 'K') {
      await runTmuxAction('kill')
    } else if (chunk === 't' || chunk === 'T') {
      await activate(selectedIndex, { inTmux: true })
    } else if (chunk === 'c' || chunk === 'x' || chunk === 'a') {
      const cli = chunk === 'c' ? 'claude' : chunk === 'x' ? 'codex' : 'agy'
      status = `Opening ${cli}…`
      draw()
      const res = await spawnNewCli(cli, { tmuxSidebar, inTmux, tmuxSession, selfPane, dir })
      status = res.message
      await refresh()
    } else if (chunk === 'C' || chunk === 'X' || chunk === 'A') {
      const cli = chunk === 'C' ? 'claude' : chunk === 'X' ? 'codex' : 'agy'
      status = `Continuing latest ${cli}…`
      draw()
      const res = await continueLatestCli(cli, { tmuxSidebar, inTmux, tmuxSession, selfPane, dir })
      status = res.message
      await refresh()
    }
  })

  await refresh()
  setInterval(refresh, intervalMs)
}

const isMain = () => {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  }
}

if (isMain()) {
  main()
}

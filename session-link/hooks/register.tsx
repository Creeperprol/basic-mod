import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Inbox, Me, Msg, Role, Snap, Task } from '../types'


const PANE = 'session-link'
const log = atom({ plugin: 'session-link', key: 'log' } as const, [])
const me = atom({ plugin: 'session-link', key: 'me' } as const, null)
const role = atom({ plugin: 'session-link', key: 'role' } as const, 'solo')
const tasks = atom({ plugin: 'session-link', key: 'tasks' } as const, [])
const inbox = atom({ plugin: 'session-link', key: 'inbox' } as const, [])
const target = atom({ plugin: 'session-link', key: 'target' } as const, 'all')

const T_ASSIGN = 'mcp__session-link__assign'
const T_REPORT = 'mcp__session-link__report'
const T_PEERS = 'mcp__session-link__peers'
const T_RENAME = 'mcp__session-link__rename'

type Peer = { id: string; name: string; cwd: string; seen: number }

const FRESH_MS = 6 * 3600 * 1000

const ago = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 1 ? 'now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

// Folder name of a path, whether it uses / (macOS, Linux) or \\ (Windows).
const base = (cwd: string) => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? 'session'

async function listPeers($: any, selfId: string): Promise<Peer[]> {
  const now = await $.clock.now()
  const out: Peer[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('peer:')) continue
    const p = (await $.store.get(k)) as Peer | undefined
    if (p && p.id !== selfId && now - p.seen < FRESH_MS) out.push(p)
  }
  return out.sort((a, z) => z.seen - a.seen)
}

const pick = (list: Peer[], q: string) => {
  const w = q.toLowerCase()
  const exact = list.filter(p => p.name.toLowerCase() === w || p.id === q)
  if (exact.length) return exact
  return list.filter(p => p.name.toLowerCase().startsWith(w) || p.id.startsWith(q))
}

async function announce($: any, who: Me, cwd: string) {
  const peer: Peer = { id: who.id, name: who.name, cwd, seen: await $.clock.now() }
  await $.store.set(`peer:${who.id}`, peer)
}

async function remember($: any, m: Msg) {
  await update($, log, l => [...l, m].slice(-50))
  $.ui.invalidate('ui.render')
}

async function deliver($: any, who: Me, p: Peer, text: string): Promise<string | null> {
  const r = await $.session.send({ to: { sessionId: p.id }, text: `[from session "${who.name}"] ${text}` })
  if (r.isDelivered) {
    await remember($, { at: await $.clock.now(), dir: 'out', who: p.name, text })
    return null
  }
  if (/not running|gone/i.test(r.reason)) await $.store.delete(`peer:${p.id}`)
  return `${p.name}: ${r.reason}`
}

const TASK_RE = /\[TASK (\S+) host=(\S+) name="([^"]*)"\]\n([\s\S]*)$/
const RENAME_RE = /\[RENAME host=(\S+)\]\n([\s\S]*)$/
const RESULT_RE = /\[RESULT (\S+) from="([^"]*)"\]\n([\s\S]*)$/

async function hostRecord($: any): Promise<{ id: string; name: string } | null> {
  const h = (await $.store.get('host')) as { id: string; name: string } | undefined
  return h ?? null
}

// Host-ness lives in the shared host record, so it survives a reload of this module.
async function isHost($: any, who: Me | null): Promise<boolean> {
  if (!who) return false
  const h = await hostRecord($)
  return h !== null && h.id === who.id
}

const HANDOFF_MS = 60 * 1000

// Takes the note a just-ended session left for its /clear successor, if it is recent and from this folder.
async function takeHandoff($: any, cwd: string): Promise<{ name: string; host: boolean } | null> {
  const h = (await $.store.get('handoff')) as { fromId: string; name: string; cwd: string; host: boolean; at: number } | undefined
  if (!h) return null
  await $.store.delete('handoff')
  if (h.cwd !== cwd || (await $.clock.now()) - h.at > HANDOFF_MS) return null
  return { name: h.name, host: h.host }
}

// Turns host mode on or off; shared by the /host command and the pane (a plugin's own
// $.command.run does not reach its own hooks).
async function setHost($: any, who: Me, isOn: boolean) {
  await update($, role, () => (isOn ? 'host' : 'solo') as Role)
  if (isOn) {
    await $.store.set('host', { id: who.id, name: who.name })
  } else {
    const h = await hostRecord($)
    if (h && h.id === who.id) await $.store.delete('host')
  }
  $.ui.invalidate('ui.render')
}

// Names are plain text: drop any markup, such as the closing tag of the message envelope.
const cleanName = (raw: string) => raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

// Asks one worker to take a new session name.
async function renameWorker($: any, who: Me, p: Peer, name: string): Promise<string | null> {
  const failed = await deliver($, who, p, `[RENAME host=${who.id}]\n${name}`)
  // Remember a worker the host has named, so auto-rename never overrides it (the peer list can lag behind a rename).
  if (!failed) await $.store.set(`named:${p.id}`, true)
  return failed
}

// Empties the whole board (the pane's Clear board button).
async function clearBoard($: any) {
  await update($, tasks, () => [])
  $.ui.invalidate('ui.render')
}

// Empties the message log (the pane's Clear messages button).
async function clearLog($: any) {
  await update($, log, () => [])
  $.ui.invalidate('ui.render')
}

// Hands one task to one worker and logs it on the board.
async function assign($: any, who: Me, p: Peer, text: string): Promise<string | null> {
  const id = `t${((await $.clock.now()) % 46656).toString(36)}${(await read($, tasks)).length}`
  const body = `[TASK ${id} host=${who.id} name="${who.name}"]\n${text}\n\nWhen you are finished, call the tool ${T_REPORT} with task_id "${id}" and a short result.`
  const failed = await deliver($, who, p, body)
  // A worker still on its random default name is renamed after its first task.
  if (!failed && /-[0-9a-f]{4}$/.test(p.name) && !(await $.store.get(`named:${p.id}`))) {
    const short = cleanName(text).split(' ').slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)
    const taken = (await listPeers($, who.id)).some(q => q.id !== p.id && q.name === short)
    if (short) await renameWorker($, who, p, taken ? `${short}-${p.id.slice(0, 2)}` : short)
  }
  const t: Task = { id, toId: p.id, toName: p.name, text, status: failed ? 'failed' : 'sent', at: await $.clock.now() }
  await update($, tasks, l => [...l.filter(x => x.status !== 'failed' || t.at - x.at < 600000), t].slice(-30))
  $.ui.invalidate('ui.render')
  return failed
}

// ---- usage pane: helpers ----
const USAGE_PANE = 'usage-bar'
const snap = atom({ plugin: 'session-link', key: 'snap' } as const, null)
const showTools = atom({ plugin: 'session-link', key: 'showTools' } as const, true)
const showWhere = atom({ plugin: 'session-link', key: 'showWhere' } as const, true)
const title = atom({ plugin: 'session-link', key: 'title' } as const, '')
const effort = atom({ plugin: 'session-link', key: 'effort' } as const, '')

const EFFORT_COLOR: Record<string, string> = { low: 'blue', medium: 'cyan', high: 'green', xhigh: 'magenta', max: 'red' }

const human = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const tone = (p: number) => (p < 50 ? 'cyan' : p < 75 ? 'yellow' : p < 90 ? 'magenta' : 'red')

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Smooth bar: full cells, one partial eighth, then a dim track.
const bar = (p: number, width: number) => {
  const cells = (Math.min(100, Math.max(0, p)) / 100) * width
  const full = Math.floor(cells)
  const part = EIGHTHS[Math.floor((cells - full) * 8)]
  return { fill: '█'.repeat(full) + part, track: '░'.repeat(Math.max(0, width - full - (part ? 1 : 0))) }
}

const LABEL: Record<string, string> = { five_hour: '5-HOUR', seven_day: 'WEEKLY', spend_limit: 'SPEND' }
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const reset = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? `resets ${hm}` : `resets ${DAYS[d.getDay()]} ${hm}`
}

const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

type Usage = {
  startedAt: number
  context: { percent?: number; tokens?: number; window: number; breakdown?: any }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const toSnap = (u: Usage, prev: Snap | null): Snap => {
  const b = u.context.breakdown
  return {
    percent: u.context.percent ?? 0,
    tokens: u.context.tokens ?? 0,
    window: u.context.window,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    usd: u.cost ? u.cost.usd : null,
    startedAt: u.startedAt,
    model: b ? b.model : (prev ? prev.model : ''),
    cats: b
      ? b.categories
          .filter((c: any) => c.kind === 'used' && c.tokens > 0)
          .map((c: any) => ({ name: c.name, tokens: c.tokens }))
          .sort((a: any, z: any) => z.tokens - a.tokens)
      : (prev ? prev.cats : []),
    compactAt: b ? (b.autoCompactThreshold ?? null) : (prev ? prev.compactAt : null),
  }
}

// detail: also itemise the window (local estimate, free); the light call keeps the last itemising.
async function refresh($: any, detail: boolean) {
  const prev = await read($, snap)
  const u = await $.session.usage(detail ? { breakdown: 'summary' } : undefined)
  await update($, snap, () => toSnap(u, prev))
  $.ui.invalidate('ui.render')
}

type Call = { id: string; tool: string; hint: string; isDone: boolean }

const hintOf = (input: any): string => {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? ''
  return String(v).replace(/\s+/g, ' ').slice(0, 60)
}

// Called from the shared session.start hook (a module may register each event once).
export async function usageStart($: any, autoOpen: boolean) {
  await $.command.register({ name: 'usage-bar', description: 'Open the usage meters in a side pane' })
  if (autoOpen) void $.ui.open({ id: USAGE_PANE, title: 'Usage' })
  await refresh($, true)
}

// Called from the shared prompt hook: the reasoning effort this turn runs at.
export async function usageEffort($: any, level: string) {
  try {
    if (level) await update($, effort, () => level)
  } catch {
    // cosmetic only
  }
}

// Called from the shared /rename and prompt hooks: the pane header follows the session's name.
export async function usageNamed($: any, name: string) {
  try {
    if (name) await update($, title, () => name)
  } catch {
    // the name is cosmetic; never block anything over it
  }
}


// ---- session link ----
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    let name = options.name ? String(options.name) : `${base(cwd)}-${id.slice(0, 4)}`
    // /clear starts a new session id: carry the name and the host role over from the one it replaced.
    const carried = (e as { source?: string }).source === 'clear' ? await takeHandoff($, cwd) : null
    if (carried && !options.name) name = carried.name
    const who: Me = { id, name }
    await update($, me, () => who)
    await announce($, who, cwd)
    if (carried?.host) await setHost($, who, true)

    const refused: string[] = []
    for (const [name, description] of [
      ['sessions', 'List your other running Claude Code sessions'],
      ['tell', 'Message another session: /tell <name> <message>'],
      ['tellall', 'Message every other session: /tellall <message>'],
      ['link', 'Open the session link pane'],
      ['host', 'Make this session the host that hands out work: /host or /host off'],
      ['assign', 'Host: give a task to a session: /assign <name|all> <task>'],
      ['board', 'Host: show the task board, or /board clear to empty the board and messages'],
      ['setname', 'Host: rename another session: /setname <session> <new name>'],
    ]) {
      try {
        await $.command.register({ name, description })
      } catch (err) {
        refused.push(`/${name}`)
      }
    }
    if (refused.length) $.ui.toast(`session-link: could not register ${refused.join(', ')} (name taken)`)
    try {
    await $.tool.register({
      name: 'assign',
      description: 'Host only. Give a task to another Claude Code session (a worker) and carry on; its result comes back as a message. Use worker "all" for every worker.',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', description: 'Worker session name, or "all"' }, task: { type: 'string', description: 'What the worker should do, self-contained' } },
        required: ['worker', 'task'],
      },
    })
    await $.tool.register({
      name: 'report',
      description: 'Worker only. Send the result of a task the host assigned back to the host.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' }, result: { type: 'string', description: 'Short result or summary' } },
        required: ['task_id', 'result'],
      },
    })
    await $.tool.register({
      name: 'rename',
      description: 'Host only. Rename another Claude Code session (a worker).',
      inputSchema: {
        type: 'object',
        properties: { worker: { type: 'string', description: 'Worker session name' }, name: { type: 'string', description: 'The new session name' } },
        required: ['worker', 'name'],
      },
    })
    await $.tool.register({ name: 'peers', description: 'List the other running Claude Code sessions you can message.' })
    } catch (err) {
      $.ui.toast('session-link: could not register its tools')
    }
    void $.ui.open({ id: PANE, title: 'Sessions' })
    await usageStart($, options.autoOpen !== false)
    return next(e)
  })

  on('command.run', { command: 'host' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (e.args.trim() === 'off') {
      await setHost($, who, false)
      return { text: 'No longer hosting.' }
    }
    await setHost($, who, true)
    return { text: `${who.name} is the host. Give work with /assign <session|all> <task>, or ask me to delegate.` }
  })

  on('command.run', { command: 'assign' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (!(await isHost($, who))) return { text: 'Run /host first to make this session the host.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    if (!target || !text) return { text: 'Usage: /assign <session name|all> <task>' }
    const list = await listPeers($, who.id)
    const chosen = target === 'all' ? list : pick(list, target)
    if (chosen.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (target !== 'all' && chosen.length > 1) return { text: `"${target}" is ambiguous: ${chosen.map(p => p.name).join(', ')}` }
    const out: string[] = []
    for (const p of chosen) {
      const f = await assign($, who, p, text)
      out.push(f ? `✗ ${f}` : `→ ${p.name}`)
    }
    return { text: out.join('\n') }
  })

  on('command.run', { command: 'setname' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    if (!(await isHost($, who))) return { text: 'Run /host first to make this session the host.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const name = cleanName(rest.join(' '))
    if (!target || !name) return { text: 'Usage: /setname <session> <new name>' }
    const matches = pick(await listPeers($, who.id), target)
    if (matches.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (matches.length > 1) return { text: `"${target}" is ambiguous: ${matches.map(p => p.name).join(', ')}` }
    const failed = await renameWorker($, who, matches[0], name)
    return { text: failed ? `Not renamed. ${failed}` : `Asked ${matches[0].name} to rename itself to "${name}".` }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      const before = (await read($, tasks)).length
      await clearBoard($)
      await clearLog($)
      return { text: `Cleared ${before} task${before === 1 ? '' : 's'} and the messages.` }
    }
    const list = await read($, tasks)
    if (list.length === 0) return { text: 'No tasks yet.' }
    const icon = { sent: '…', done: '✓', failed: '✗' }
    return {
      text: list
        .map(t => `${icon[t.status]} ${t.id}  ${t.toName}: ${t.text.slice(0, 60)}${t.result ? `\n    ⇒ ${t.result.slice(0, 200)}` : ''}`)
        .join('\n'),
    }
  })

  // The tools the model calls.
  on('tool.call', { tool: T_PEERS }, async $ => {
    const who = await read($, me)
    const list = await listPeers($, who ? who.id : '')
    return { result: list.length ? list.map(p => `${p.name} (${base(p.cwd)})`).join('\n') : 'No other sessions running.' }
  })

  on('tool.call', { tool: T_ASSIGN }, async ($, e) => {
    const who = await read($, me)
    if (!(await isHost($, who))) return { result: 'This session is not the host. The person must run /host first.' }
    const input = e as unknown as { worker?: string; task?: string }
    const worker = String(input.worker ?? '')
    const task = String(input.task ?? '')
    if (!worker || !task) return { result: 'Both worker and task are required.' }
    const list = await listPeers($, who.id)
    const chosen = worker === 'all' ? list : pick(list, worker)
    if (chosen.length === 0) return { result: `No session matches "${worker}".` }
    if (worker !== 'all' && chosen.length > 1) return { result: `"${worker}" is ambiguous: ${chosen.map(p => p.name).join(', ')}` }
    const out: string[] = []
    for (const p of chosen) {
      const f = await assign($, who, p, task)
      out.push(f ? `failed: ${f}` : `sent to ${p.name}`)
    }
    return { result: out.join('\n') }
  })

  on('tool.call', { tool: T_RENAME }, async ($, e) => {
    const who = await read($, me)
    if (!who || !(await isHost($, who))) return { result: 'This session is not the host. The person must run /host first.' }
    const input = e as unknown as { worker?: string; name?: string }
    const worker = String(input.worker ?? '')
    const name = cleanName(String(input.name ?? ''))
    if (!worker || !name) return { result: 'Both worker and name are required.' }
    const matches = pick(await listPeers($, who.id), worker)
    if (matches.length !== 1) return { result: matches.length ? `"${worker}" is ambiguous.` : `No session matches "${worker}".` }
    const failed = await renameWorker($, who, matches[0], name)
    return { result: failed ? `Not renamed: ${failed}` : `Asked ${matches[0].name} to rename itself to "${name}".` }
  })

  on('tool.call', { tool: T_REPORT }, async ($, e) => {
    const who = await read($, me)
    const input = e as unknown as { task_id?: string; result?: string }
    const id = String(input.task_id ?? '')
    const found = (await read($, inbox)).find(i => i.id === id)
    if (!who || !found) return { result: `No task ${id} was assigned to this session.` }
    const r = await $.session.send({
      to: { sessionId: found.hostId },
      text: `[RESULT ${id} from="${who.name}"]\n${String(input.result ?? '')}`,
    })
    // The task is done: drop it so the worker goes back to normal once nothing is left.
    if (r.isDelivered) {
      // Stay quiet until the person next types here: a stop hook's feedback can arrive after the report.
      await $.store.set(`quiet:${await $.session.id()}`, true)
      await update($, inbox, l => l.filter(i => i.id !== id))
      $.ui.invalidate('ui.render')
    }
    return { result: r.isDelivered ? 'Result sent to the host.' : `Could not reach the host: ${r.reason}` }
  })

  on('command.run', { command: 'link' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sessions' })
    return { text: 'Session pane opened.' }
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const who = await read($, me)
    const list = await listPeers($, who ? who.id : '')
    const now = await $.clock.now()
    if (list.length === 0) return { text: 'No other sessions found. Start Claude Code in another terminal with this mod loaded.' }
    return { text: list.map(p => `${p.name}  ${base(p.cwd)}  ${ago(now - p.seen)}  (${p.id.slice(0, 8)})`).join('\n') }
  })

  on('command.run', { command: 'tell' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    const [target, ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    if (!target || !text) return { text: 'Usage: /tell <session name or id> <message>' }
    const matches = pick(await listPeers($, who.id), target)
    if (matches.length === 0) return { text: `No session matches "${target}". Try /sessions.` }
    if (matches.length > 1) return { text: `"${target}" is ambiguous: ${matches.map(p => p.name).join(', ')}` }
    const failed = await deliver($, who, matches[0], text)
    return { text: failed ? `Not delivered. ${failed}` : `Sent to ${matches[0].name}.` }
  })

  on('command.run', { command: 'tellall' }, async ($, e) => {
    const who = await read($, me)
    if (!who) return { text: 'Session link is not ready yet.' }
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /tellall <message>' }
    const list = await listPeers($, who.id)
    if (list.length === 0) return { text: 'No other sessions to tell.' }
    const failures: string[] = []
    for (const p of list) {
      const f = await deliver($, who, p, text)
      if (f) failures.push(f)
    }
    return { text: `Sent to ${list.length - failures.length}/${list.length} sessions.${failures.length ? '\n' + failures.join('\n') : ''}` }
  })

  // Multi-window: while this session holds a host task, the model only does the work and reports.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      const quiet = Boolean(await $.store.get(`quiet:${await $.session.id()}`))
      if (((await read($, inbox)).length === 0 && !quiet) || (await isHost($, await read($, me)))) return r
    } catch {
      return r
    }
    return {
      sections: [
        ...r.sections,
        {
          id: 'session-link:silent-worker',
          scope: 'session' as const,
          text: `You are a worker in a multi-window setup and a host session has given you a task. Do only that task. Write no chat text between tool calls and no summary or thanks at the end: your only output is tool calls. Do not ask the user questions or offer next steps. When the work is done, call ${T_REPORT} once with the task_id and a short result (one or two sentences), then stop. Hook feedback that arrives after your report (a stop hook, a design or lint finding) is not a reason to write text: act on it with tool calls only, or ignore it, and never explain, triage or summarise it in chat. Your final message after the report must be empty, and this holds until the person next types in this session.`,
        },
      ],
    }
  })

  // Record what other sessions say to this one; the model still reads it as usual.
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
      try {
        const now = await $.clock.now()
        const task = TASK_RE.exec(e.text)
        const result = RESULT_RE.exec(e.text)
        const rename = RENAME_RE.exec(e.text)
        if (task) {
          // A task is only taken from the session registered as the host.
          const h = await hostRecord($)
          if (h && h.id === task[2]) {
            const item: Inbox = { id: task[1], hostId: task[2], hostName: task[3], text: task[4].split('\n\nWhen you are finished')[0] }
            await update($, inbox, l => [...l, item].slice(-30))
            await remember($, { at: now, dir: 'in', who: `task ${item.id}`, text: item.text.slice(0, 300) })
            $.ui.toast(`Task ${item.id} from ${item.hostName}`)
            if (options.autoRun === true) {
              void $.prompt
                .submit({ text: `Task ${item.id} from host "${item.hostName}": ${item.text}\nWhen finished, call ${T_REPORT} with task_id "${item.id}" and a short result.` })
                .catch(() => {})
            }
          }
        } else if (rename) {
          // A rename is only taken from the session registered as the host.
          const h = await hostRecord($)
          const name = cleanName(rename[2])
          const who = await read($, me)
          if (h && h.id === rename[1] && name && who) {
            await $.command.run({ command: 'rename', args: name })
            const renamed: Me = { id: who.id, name }
            await update($, me, () => renamed)
            await announce($, renamed, await $.session.cwd())
            await remember($, { at: now, dir: 'in', who: h.name, text: `renamed this session to "${name}"` })
            $.ui.toast(`${h.name} renamed this session to "${name}"`)
            // The rename is handled here: the model never reads it, so the worker does not answer it.
            return { consumed: 'rename applied' }
          }
        } else if (result) {
          const id = result[1]
          const found = (await read($, tasks)).find(t => t.id === id)
          if (found) {
            await update($, tasks, l => l.filter(t => t.id !== id)) // finished tasks clear themselves; the result still lands in the log
            await remember($, { at: now, dir: 'in', who: `${result[2]} ✓ ${id}`, text: result[3].slice(0, 300) })
            $.ui.toast(`${result[2]} finished ${id}`)
          }
        } else {
          await remember($, { at: now, dir: 'in', who: 'peer', text: e.text.slice(0, 300) })
        }
      } catch {
        // logging must never block delivery
      }
    }
    return next(e)
  })

  // /rename carries the new name as its argument: follow it at once, unless the option fixes one.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const r = await next(e)
    await usageNamed($, e.args.trim())
    try {
      const who = await read($, me)
      const t = e.args.trim()
      if (who && t && !options.name && who.name !== t) {
        const renamed: Me = { id: who.id, name: t }
        await update($, me, () => renamed)
        await announce($, renamed, await $.session.cwd())
        $.ui.invalidate('ui.render')
      }
    } catch {
      // the name is cosmetic; never block /rename over it
    }
    return r
  })

  // Follow the name set with /rename, unless the option fixes one.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await usageNamed($, e.session_title ? String(e.session_title) : '')
    await usageEffort($, e.effort ? String(e.effort.level) : '')
    try {
      const who = await read($, me)
      const t = e.session_title ? String(e.session_title) : ''
      if (who && t && !options.name && who.name !== t) {
        const renamed: Me = { id: who.id, name: t }
        await update($, me, () => renamed)
        await announce($, renamed, await $.session.cwd())
        $.ui.invalidate('ui.render')
      }
    } catch {
      // the name is cosmetic; never block a prompt over it
    }
    return next(e)
  })

  // Keep this session's listing fresh while it is in use.
  on('turn.complete', async ($, e, next) => {
    try {
      const who = await read($, me)
      if (who) await announce($, who, await $.session.cwd())
    } catch {
      // a failed heartbeat must never affect the turn
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const who = await read($, me)
      if (who) {
        // Leave a note so a /clear successor in this folder can pick up the name and the host role.
        const host = await isHost($, who)
        await $.store.set('handoff', { fromId: who.id, name: who.name, cwd: await $.session.cwd(), host, at: await $.clock.now() })
        await $.store.delete(`peer:${who.id}`)
      }
    } catch {
      // leaving quietly
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const who = await read($, me)
    const msgs = await read($, log)
    const myRole: Role = (await isHost($, who)) ? 'host' : 'solo'
    const board = await read($, tasks)
    const waiting = await read($, inbox)
    const pickedId = await read($, target)
    let list: Peer[] = []
    let now = 0
    try {
      now = await $.clock.now()
      list = await listPeers($, who ? who.id : '')
    } catch (err) {
      return <Text color="red">session-link error: {String(err)}</Text>
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">{who ? who.name : '…'}</Text>
        <Text>
          <Text dimColor>{who ? who.id.slice(0, 8) : ''} </Text>
          <Text bold color={myRole === 'host' ? 'yellow' : 'green'}>{myRole === 'host' ? '★ HOST' : 'worker'}</Text>
        </Text>
        <Text> </Text>

        <Text bold>OTHER SESSIONS</Text>
        {list.length === 0 ? <Text dimColor>none running</Text> : null}
        {list.map(p => (
          <Box key={p.id} flexDirection="column">
            <Text>
              <Text color="green">● </Text>
              <Text bold>{p.name}</Text>
              <Text dimColor> {ago(now - p.seen)}</Text>
            </Text>
          </Box>
        ))}
        <Text> </Text>

        {myRole === 'host' ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>TASKS</Text>
            {board.length === 0 ? <Text dimColor>none yet · /assign name task</Text> : null}
            {board.length ? <Button key="clear" label="Clear board" onPress={() => clearBoard($)} /> : null}
            {board.slice(-4).map(t => (
              <Text key={t.id} wrap="truncate">
                <Text color={t.status === 'failed' ? 'red' : 'yellow'}>{t.status === 'failed' ? '✗ ' : '… '}</Text>
                <Text bold>{t.toName.slice(0, 14)} </Text>
                <Text dimColor>{t.text.slice(0, 28)}</Text>
              </Text>
            ))}
          </Box>
        ) : waiting.length ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>FROM THE HOST</Text>
            {waiting.slice(-4).map(i => (
              <Text key={i.id} wrap="truncate">
                <Text color="yellow">● </Text>
                <Text bold>{i.id} </Text>
                <Text dimColor>{i.text}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>PROMPT A WORKER</Text>
          {list.length === 0 ? (
            <Text dimColor>no other sessions yet</Text>
          ) : (
            <Box flexDirection="column">
              <Select
                key="target"
                label="to "
                value={pickedId}
                options={[{ value: 'all', label: 'all workers' }, ...list.map(p => ({ value: p.id, label: p.name }))]}
                onSelect={v => update($, target, () => v)}
              />
              <Input
                key="prompt"
                placeholder="type a task, Enter to send"
                submitLabel="send"
                onSubmit={async text => {
                  const task = text.trim()
                  if (!task || !who) return
                  if (myRole !== 'host') await setHost($, who, true)
                  const chosen = pickedId === 'all' ? list : list.filter(p => p.id === pickedId)
                  let ok = 0
                  for (const p of chosen) if (!(await assign($, who, p, task))) ok += 1
                  $.ui.toast(ok ? `Sent to ${ok} session${ok === 1 ? '' : 's'}` : 'Nothing was delivered')
                }}
              />
            </Box>
          )}
        </Box>

        <Text bold>MESSAGES</Text>
        {msgs.length ? <Button key="clear-msgs" label="Clear messages" onPress={() => clearLog($)} /> : null}
        {msgs.length === 0 ? <Text dimColor>nothing yet</Text> : null}
        {msgs.slice(-8).map((m, i) => (
          <Text key={`${m.at}-${i}`} wrap="truncate">
            <Text color={m.dir === 'in' ? 'yellow' : 'cyan'}>{m.dir === 'in' ? '← ' : '→ '}</Text>
            <Text bold>{m.who} </Text>
            <Text dimColor>{m.text}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Box>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => $.ui.invalidate('ui.render')} />
          <Text> </Text>
          <Button
            key="host"
            label={myRole === 'host' ? 'Stop hosting' : 'Become host'}
            onPress={() => (who ? setHost($, who, myRole !== 'host') : undefined)}
          />
        </Box>
      </Box>
    )
  })

  // ---- usage pane: hooks ----
  let turns = 0
  let askedOnce = false
  let tools = 0
  let calls: Call[] = []
  const counts: Record<string, number> = {}

  on('command.run', { command: 'usage-bar' }, async $ => {
    await $.ui.open({ id: USAGE_PANE, title: 'Usage' })
    return { text: 'Usage pane opened.' }
  })

  // A resumed session already has its name when it starts.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.session_title) await update($, title, () => String(e.session_title))
    } catch {
      // cosmetic only
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    turns += 1
    // A prompt the person types ends a worker's quiet spell.
    if ((e as { origin?: { kind?: string } }).origin?.kind === 'composer') {
      try {
        await $.store.delete(`quiet:${await $.session.id()}`)
      } catch {
        // the store is best effort
      }
    }
    // A pane the mod opens on its own waits below 144 columns; one opened in answer to the
    // person's prompt is seated from 110. So ask once, on their first prompt.
    if (!askedOnce && options.autoOpen !== false) {
      askedOnce = true
      try {
        await $.ui.open({ id: USAGE_PANE, title: 'Usage' })
      } catch {
        // the pane is a convenience; never block a prompt over it
      }
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, true)
    return next(e)
  })

  // Keep the meters moving between turns: refresh after every tool call.
  on('tool.call', async ($, e, next) => {
    tools += 1
    counts[e.tool] = (counts[e.tool] ?? 0) + 1
    const call: Call = { id: e.tool_use_id ?? `${e.tool}-${tools}`, tool: e.tool, hint: hintOf(e), isDone: false }
    calls = [...calls, call].slice(-12)
    $.ui.invalidate('ui.render')
    const r = await next(e)
    calls = calls.map(c => (c.id === call.id ? { ...c, isDone: true } : c))
    try {
      await refresh($, false)
    } catch {
      // a failed refresh must never affect the tool call
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: USAGE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    let s: Snap
    let now = 0
    let isTools = true
    let isWhere = true
    let name = ''
    let level = ''
    let sid = ''
    try {
      s = (await read($, snap)) ?? toSnap(await $.session.usage({ breakdown: 'summary' }), null)
      now = await $.clock.now()
      isTools = await read($, showTools)
      isWhere = await read($, showWhere)
      name = await read($, title)
      level = await read($, effort)
      sid = (await $.session.id()).slice(0, 8)
    } catch (err) {
      return <Text color="red">usage error: {String(err)}</Text>
    }

    const width = Math.max(8, (e.props.bodyColumns ?? 30) - 2)
    const age = Math.max(1, now - s.startedAt)
    const perHour = s.usd !== null ? (s.usd / age) * 3600000 : null

    const Meter = ({ label, p, note }: { label: string; p: number; note?: string }) => {
      const b = bar(p, width)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold>{label}</Text>
            <Text bold color={tone(p)}>  {Math.round(p)}%</Text>
          </Box>
          <Text>
            <Text color={tone(p)}>{b.fill}</Text>
            <Text dimColor>{b.track}</Text>
          </Text>
          {note ? <Text dimColor>{note}</Text> : null}
        </Box>
      )
    }

    const Row = ({ k, v, color }: { k: string; v: string; color?: string }) => (
      <Box>
        <Text dimColor>{k.padEnd(10)}</Text>
        <Text bold color={color}>{v}</Text>
      </Box>
    )

    const top = s.cats.slice(0, 6)
    const biggest = top.length ? top[0].tokens : 1

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="white">{name || 'untitled session'}</Text>
        <Text dimColor>{sid}</Text>
        <Text>
          {s.model ? <Text bold color="cyan">{s.model}</Text> : null}
          <Text dimColor> · effort </Text>
          <Text bold color={EFFORT_COLOR[level] ?? 'white'}>{level || '—'}</Text>
        </Text>
        <Text dimColor>session {span(age)}</Text>
        <Text> </Text>

        <Meter
          label="CONTEXT"
          p={s.percent}
          note={`${human(s.tokens)} / ${human(s.window)} tokens${
            s.compactAt ? ` · compacts at ${human(s.compactAt)}` : ''
          }`}
        />
        {s.limits.map(l => (
          <Meter key={l.kind} label={LABEL[l.kind] ?? l.kind} p={l.percentUsed} note={reset(l.resetsAt)} />
        ))}

        {top.length ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>WHERE CONTEXT GOES</Text>
            {(isWhere ? top : []).map(c => {
              const b = bar((c.tokens / biggest) * 100, 6)
              return (
                <Text key={c.name}>
                  <Text color="cyan">{b.fill}</Text>
                  <Text dimColor>{b.track} </Text>
                  <Text>{c.name} </Text>
                  <Text dimColor>{human(c.tokens)}</Text>
                </Text>
              )
            })}
            {isWhere && s.cats.length > top.length ? (
              <Text dimColor>+{s.cats.length - top.length} more</Text>
            ) : null}
          </Box>
        ) : null}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold>TOOLS</Text>
          {calls.length === 0 ? <Text dimColor>none yet</Text> : null}
          {(isTools ? calls.slice(-5) : []).map(c => (
            <Text key={c.id} wrap="truncate">
              <Text color={c.isDone ? 'green' : 'yellow'}>{c.isDone ? '✓ ' : '● '}</Text>
              <Text bold={!c.isDone}>{c.tool}</Text>
              <Text dimColor> {c.hint}</Text>
            </Text>
          ))}
          {Object.keys(counts).length ? (
            <Text dimColor>
              {Object.entries(counts)
                .sort((a, z) => z[1] - a[1])
                .slice(0, 4)
                .map(([k, n]) => `${k}×${n}`)
                .join('  ')}
            </Text>
          ) : null}
        </Box>

        <Text bold>SESSION</Text>
        <Row k="turns" v={String(turns)} />
        <Row k="tool calls" v={String(tools)} />
        {s.usd !== null ? <Row k="cost" v={`$${s.usd.toFixed(2)}`} color="green" /> : null}
        {perHour !== null && age > 120000 ? <Row k="burn" v={`$${perHour.toFixed(2)}/h`} /> : null}

        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($, true)} />
            <Text> </Text>
            <Button
              key="reset"
              label="Reset counts"
              onPress={() => {
                turns = 0
                tools = 0
                calls = []
                for (const k of Object.keys(counts)) delete counts[k]
                $.ui.invalidate('ui.render')
              }}
            />
          </Box>
          <Box>
            <Button
              key="tools"
              label={isTools ? 'Hide tools' : 'Show tools'}
              onPress={() => update($, showTools, v => !v)}
            />
            <Text> </Text>
            <Button
              key="where"
              label={isWhere ? 'Hide breakdown' : 'Show breakdown'}
              onPress={() => update($, showWhere, v => !v)}
            />
          </Box>
        </Box>
      </Box>
    )
  })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'))
const SERVER = new URL('./server.mjs', import.meta.url).pathname

// A tiny MCP client over stdio.
let paneSeq = 100
const start = (cli, name, extra = {}) => {
  // LINK_WAKE=0: the servers here would otherwise type into the terminal that runs the tests.
  const paneEnv = 'LINK_PANE' in extra ? {} : { LINK_PANE: `%${++paneSeq}` }
  const p = spawn('node', [SERVER], { env: { ...process.env, LINK_WAKE: '0', LINK_HOME: HOME, LINK_CLI: cli, LINK_NAME: name, ...paneEnv, ...extra }, stdio: ['pipe', 'pipe', 'inherit'] })
  let n = 0
  const waiting = new Map()
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', c => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiting.get(m.id)?.(m)
    }
  })
  const rpc = (method, params) =>
    new Promise(res => {
      const id = ++n
      waiting.set(id, res)
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    init: () => rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }),
    list: () => rpc('tools/list', {}),
    tool: async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args })
      return { text: r.result.content[0].text, isError: !!r.result.isError }
    },
    stop: () => p.stdin.end(),
  }
}

test('sessions of different CLIs find each other, hand out work and report back', async () => {
  const host = start('claude', 'boss')
  const codex = start('codex', 'coder')
  const qwen = start('qwen', 'quinn')
  for (const s of [host, codex, qwen]) {
    const r = await s.init()
    assert.equal(r.result.serverInfo.name, 'link-bridge')
    assert.equal((await s.list()).result.tools.length, 9)
  }
  await new Promise(r => setTimeout(r, 300))

  const seen = await host.tool('link_peers')
  assert.match(seen.text, /coder\s+\[codex\]/)
  assert.match(seen.text, /quinn\s+\[qwen\]/)

  // plain message
  assert.match((await host.tool('link_tell', { to: 'cod', text: 'hello there' })).text, /Sent to coder/)
  assert.match((await codex.tool('link_inbox')).text, /MESSAGE from "boss":\nhello there\n\(To answer, call link_tell with to "boss"/)
  assert.match((await codex.tool('link_inbox')).text, /empty/)

  // a missing or misnamed required argument is refused, never sent as "undefined"
  const bad = await host.tool('link_tell', { to: 'coder', message: 'hi' })
  assert.equal(bad.isError, true)
  assert.match(bad.text, /link_tell needs "text" \(got "to", "message"\)/)
  assert.match((await codex.tool('link_inbox')).text, /empty/)

  // only the host may assign
  assert.equal((await codex.tool('link_assign', { worker: 'all', task: 'x' })).isError, true)
  assert.match((await host.tool('link_host')).text, /boss is the host/)
  assert.equal((await qwen.tool('link_host')).isError, true)

  const out = (await host.tool('link_assign', { worker: 'all', task: 'say hi' })).text
  assert.match(out, /coder/)
  assert.match(out, /quinn/)

  const task = (await codex.tool('link_inbox')).text
  const id = /TASK (t\w+) from host "boss"/.exec(task)[1]
  assert.match((await codex.tool('link_report', { task_id: id, result: 'Hi from codex' })).text, /sent to the host/)

  const board = (await host.tool('link_board')).text
  assert.match(board, /✓ .*coder: say hi\n\s+⇒ Hi from codex/)
  assert.match(board, /… .*quinn: say hi/)
  assert.match((await host.tool('link_inbox')).text, /RESULT .* from "coder":\nHi from codex/)

  assert.match((await host.tool('link_board', { clear: true })).text, /Cleared 1/)

  // a worker can not report a task it was never given
  assert.equal((await qwen.tool('link_report', { task_id: 'nope', result: 'x' })).isError, true)

  // the host renames a worker; the worker applies it itself
  await host.tool('link_rename', { worker: 'quinn', name: 'helper <b>one</b>' })
  await qwen.tool('link_peers') // any call applies pending renames
  assert.match((await host.tool('link_peers')).text, /helper one\s+\[qwen\]/)

  // waiting for an inbox returns as soon as something arrives
  const waiter = codex.tool('link_inbox', { wait_seconds: 5 })
  setTimeout(() => host.tool('link_tell', { to: 'coder', text: 'late news' }), 500)
  assert.match((await waiter).text, /late news/)

  // a stopped session leaves the list
  qwen.stop()
  await new Promise(r => setTimeout(r, 400))
  assert.doesNotMatch((await host.tool('link_peers')).text, /helper one/)

  host.stop()
  codex.stop()
})

test('an Antigravity (agy) session takes a task from a Claude host and reports back', async () => {
  const host = start('claude', 'boss2')
  const agy = start('agy', 'agy-worker-1')
  for (const s of [host, agy]) await s.init()
  await new Promise(r => setTimeout(r, 300))
  assert.match((await host.tool('link_peers')).text, /agy-worker-1\s+\[agy\]/)
  assert.match((await host.tool('link_host', { on: true })).text, /is the host/)
  const assigned = await host.tool('link_assign', { worker: 'agy-worker-1', task: 'what is 17 times 23?' })
  const id = /\((t[0-9a-f]+)\)/.exec(assigned.text)[1]
  const got = await agy.tool('link_inbox', { wait_seconds: 3 })
  assert.match(got.text, new RegExp(`TASK ${id} from host "boss2"`))
  assert.match((await agy.tool('link_report', { task_id: id, result: '391' })).text, /Result sent to the host/)
  assert.match((await host.tool('link_inbox', { wait_seconds: 3 })).text, new RegExp(`RESULT ${id} from "agy-worker-1":\\n391`))
  host.stop()
  agy.stop()
})

test('agy-worker.sh validates the model name and builds a worker command', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./agy-worker.sh', import.meta.url).pathname
  const bad = spawnSync('bash', [script, '-n', '-m', 'x;rm -rf /'], { encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /invalid model name/)
  const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-s-')), 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [os.tmpdir()] }))
  const ok = spawnSync('bash', [script, '-n', '-w', '-d', os.tmpdir(), '-m', 'gemini-3.8-flash-low'], { encoding: 'utf8', env: { ...process.env, AGY_SETTINGS: settings } })
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /agy --dangerously-skip-permissions --model gemini-3\.8-flash-low -i /)
  assert.match(ok.stdout, /link_report/)
})

test('agy-worker.sh refuses a folder agy does not trust (there is no headless mode)', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./agy-worker.sh', import.meta.url).pathname
  const trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trusted-'))
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-other-'))
  const nested = path.join(trusted, 'sub')
  fs.mkdirSync(nested)
  const settings = path.join(trusted, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [trusted] }))
  const run = (...a) => spawnSync('bash', [script, '-n', ...a], { encoding: 'utf8', env: { ...process.env, AGY_SETTINGS: settings } })
  const no = run('-w', '-d', other)
  assert.equal(no.status, 3)
  assert.match(no.stderr, /does not trust/)
  assert.equal(run('-w', '-d', trusted).status, 0)
  assert.equal(run('-w', '-d', nested).status, 0) // trust covers subfolders
  assert.equal(run('-d', other).status, 3) // no headless escape: the window always needs trust
  fs.writeFileSync(settings, 'not json')
  assert.equal(run('-w', '-d', other).status, 0) // unreadable settings do not block
})

test('codex-agent.sh checks its arguments and offers no dangerous sandbox', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./codex-agent.sh', import.meta.url).pathname
  const run = (...a) => spawnSync('bash', [script, ...a], { encoding: 'utf8' })
  assert.equal(run().status, 2)
  assert.match(run().stderr, /give the task/)
  const danger = run('-s', 'danger-full-access', 'x')
  assert.equal(danger.status, 2)
  assert.match(danger.stderr, /invalid sandbox/)
  assert.equal(run('-m', 'x;rm -rf /', 'x').status, 2)
  assert.equal(run('-t', 'soon', 'x').status, 2)
  assert.equal(run('-d', '/no/such/folder', 'x').status, 2)
})

test('default session names are <cli>-<id>, with no folder or user name in them', async () => {
  const mk = (cli, cwd) => spawn('node', [SERVER], { cwd, env: { ...process.env, LINK_HOME: HOME, LINK_CLI: cli, LINK_NAME: '', LINK_PANE: `%${++paneSeq}` }, stdio: ['pipe', 'pipe', 'inherit'] })
  const watcher = start('claude', 'watcher')
  await watcher.init()
  const a = mk('claude', os.homedir())
  const b = mk('codex', os.tmpdir())
  await new Promise(r => setTimeout(r, 600))
  const seen = (await watcher.tool('link_peers')).text
  assert.match(seen, /claude-[0-9a-f]{4}\s+\[claude\]/)
  assert.match(seen, /codex-[0-9a-f]{4}\s+\[codex\]/)
  assert.doesNotMatch(seen, new RegExp(`-${path.basename(os.homedir())}-|-home-|-${path.basename(os.tmpdir())}-`))
  a.kill()
  b.kill()
  watcher.stop()
})

test('push delivery types tasks and results into the prompt, so no link_inbox polling is needed', async () => {
  const log = path.join(HOME, 'wake.log')
  const wake = tty => ({ LINK_WAKE: '1', LINK_WAKE_LOG: log, LINK_TTY: tty, LINK_PANE: '', LINK_TMUX_ONLY: '0', LINK_WAKE_GAP_MS: '10' })
  const host = start('claude', 'pushboss', wake('ttys901'))
  const worker = start('codex', 'pushworker', wake('ttys902'))
  const quiet = start('agy', 'pushquiet', wake(''))
  for (const s of [host, worker, quiet]) await s.init()
  await new Promise(r => setTimeout(r, 300))
  await host.tool('link_host', { on: true })

  const sent = await host.tool('link_assign', { worker: 'pushworker', task: 'line one\nline two\u0007' })
  const taskId = sent.text.match(/\((t[0-9a-f]+)\)/)[1]
  await new Promise(r => setTimeout(r, 300))
  const typedLines = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  let [first] = typedLines()
  assert.equal(first.to, 'pushworker')
  assert.equal(first.tty, 'ttys902')
  assert.equal(first.line, `[link TASK ${taskId} from host "pushboss"] line one line two (When finished, call link_report with task_id "${taskId}" and a short result.)`)
  assert.equal((await worker.tool('link_inbox')).text, 'Inbox is empty.', 'a typed message is not also left in the inbox')

  // the worker never called link_inbox, yet can still report
  assert.match((await worker.tool('link_report', { task_id: taskId, result: 'done ok' })).text, /Result sent/)
  await new Promise(r => setTimeout(r, 300))
  const lines = typedLines()
  assert.equal(lines[1].to, 'pushboss')
  assert.match(lines[1].line, new RegExp(`^\\[link RESULT ${taskId} from "pushworker"\\] done ok`))
  assert.match((await host.tool('link_board')).text, /✓/)

  // a session with no terminal cannot be typed into: its message waits in the inbox instead
  await host.tool('link_tell', { to: 'pushquiet', text: 'ping' })
  await new Promise(r => setTimeout(r, 300))
  assert.equal(typedLines().length, 2)
  assert.match((await quiet.tool('link_inbox')).text, /MESSAGE from "pushboss":\nping/)
  for (const s of [host, worker, quiet]) s.stop()
})

test('link-grid.sh allows 1 to 8 panes and checks its arguments before starting tmux', async () => {
  const grid = new URL('./link-grid.sh', import.meta.url).pathname
  const run = args => new Promise(res => spawn('bash', [grid, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).on('close', code => res(code)))
  assert.equal(await run(['-n', '9']), 2)
  assert.equal(await run(['-n', '0']), 2)
  assert.equal(await run(['-m', 'gemini']), 2)
  assert.equal(await run(['-s', 'bad name']), 2)
  assert.equal(await run(['-d', '/no/such/folder']), 2)
})

test('lan.mjs links two machines: peers, messages, tasks and results cross, unsigned packets are refused', async () => {
  const LAN = new URL('./lan.mjs', import.meta.url).pathname
  const key = 'test-key-0123456789abcdef'
  const homes = [fs.mkdtempSync(path.join(os.tmpdir(), 'lan-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'lan-b-'))]
  const base = 47900 + Math.floor(Math.random() * 50) * 4
  const [udpA, httpA, udpB, httpB] = [base, base + 1, base + 2, base + 3]
  const lan = (home, udp, httpPort, other) =>
    spawn('node', [LAN], { env: { ...process.env, LINK_HOME: home, LINK_LAN_KEY: key, LINK_LAN_UDP: String(udp), LINK_LAN_HTTP: String(httpPort), LINK_LAN_PEERS: `127.0.0.1:${other}`, LINK_LAN_BROADCAST: '0' }, stdio: 'ignore' })
  const daemons = [lan(homes[0], udpA, httpA, udpB), lan(homes[1], udpB, httpB, udpA)]
  const logs = homes.map(h => path.join(h, 'wake.log'))
  // LINK_WAKE on with a log: what would be typed into each session's own window is recorded instead.
  const session = (i, cli, name) => start(cli, name, { LINK_HOME: homes[i], LINK_WAKE: '1', LINK_WAKE_LOG: logs[i], LINK_TTY: `ttys9${i}` })
  const boss = session(0, 'claude', 'boss')
  const far = session(1, 'claude', 'far')
  const until = async (fn, ms = 10_000) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) assert.fail(`timed out: ${fn}`)
      await new Promise(r => setTimeout(r, 200))
    }
  }
  const logged = i => (fs.existsSync(logs[i]) ? fs.readFileSync(logs[i], 'utf8').trim().split('\n').map(l => JSON.parse(l).line).join('\n') : '')
  try {
    await boss.init()
    await far.init()
    await until(async () => / on /.test((await boss.tool('link_peers')).text) && /far/.test((await boss.tool('link_peers')).text))
    await until(async () => /boss .* on /.test((await far.tool('link_peers')).text))

    assert.match((await boss.tool('link_tell', { to: 'far', text: 'hello over wifi' })).text, /Sent to far/)
    await until(() => /\[link MESSAGE from "boss@[^"]+"\] hello over wifi \(To answer, call link_tell with to "boss@[^"]+"/.test(logged(1)))

    await boss.tool('link_host')
    assert.match((await boss.tool('link_assign', { worker: 'far', task: 'count to 3' })).text, /far/)
    const id = (await until(() => /\[link TASK (t\w+) from host "boss@/.exec(logged(1))))[1]
    assert.match((await far.tool('link_report', { task_id: id, result: '1 2 3' })).text, /sent to the host/)
    await until(() => new RegExp(`\\[link RESULT ${id} from "far@[^"]+"\\] 1 2 3`).test(logged(0)))
    await until(async () => /✓ .*far: count to 3\n\s+⇒ 1 2 3/.test((await boss.tool('link_board')).text))

    const unsigned = await fetch(`http://127.0.0.1:${httpA}/deliver`, { method: 'POST', body: JSON.stringify({ to: 'x', msg: { kind: 'msg', text: 'hi' } }) })
    assert.equal(unsigned.status, 401)
  } finally {
    boss.stop()
    far.stop()
    for (const d of daemons) d.kill('SIGTERM')
  }
})

test('listen.mjs (a Claude Code hook) hands a waiting message to the session of its own window and exits 2; install is reversible', async () => {
  const { spawnSync } = await import('node:child_process')
  const LISTEN = new URL('./listen.mjs', import.meta.url).pathname
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-'))
  // LINK_TTY '' : a window nothing can type into, like Windows Terminal.
  const s = start('claude', 'win', { LINK_HOME: home, LINK_TTY: '' })
  await s.init()
  const me = await (async () => {
    for (let i = 0; i < 50; i++) {
      const f = fs.readdirSync(path.join(home, 'peers')).find(f => f.endsWith('.json'))
      const p = f && JSON.parse(fs.readFileSync(path.join(home, 'peers', f), 'utf8'))
      if (p?.chain?.length) return p
      await new Promise(r => setTimeout(r, 200))
    }
    assert.fail('server never recorded its process chain')
  })()
  const hook = spawn('node', [LISTEN], { env: { ...process.env, LINK_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  hook.stdin.end('{}')
  let err = ''
  hook.stderr.on('data', d => (err += d))
  const exited = new Promise(r => hook.on('exit', r))
  await new Promise(r => setTimeout(r, 1500))
  // a second hook (the next turn) leaves the waiting one alone
  const second = spawnSync('node', [LISTEN], { env: { ...process.env, LINK_HOME: home }, input: '{}', encoding: 'utf8', timeout: 30_000 })
  assert.equal(second.status, 0)
  const box = path.join(home, 'inbox', me.id)
  fs.mkdirSync(box, { recursive: true })
  fs.writeFileSync(path.join(box, '1.json'), JSON.stringify({ kind: 'msg', from: 'x', fromName: 'boss@Peemai', at: Date.now(), text: 'hi there' }))
  assert.equal(await exited, 2)
  assert.match(err, /\[link MESSAGE from "boss@Peemai"\] hi there \(To answer, call link_tell with to "boss@Peemai"/)
  assert.equal(fs.readdirSync(box).length, 0)
  s.stop()

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  fs.mkdirSync(path.join(fakeHome, '.claude'))
  const settings = path.join(fakeHome, '.claude', 'settings.json')
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }))
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome }
  assert.equal(spawnSync('node', [LISTEN, 'install'], { env }).status, 0)
  assert.equal(spawnSync('node', [LISTEN, 'install'], { env }).status, 0) // twice: still one entry
  let j = JSON.parse(fs.readFileSync(settings, 'utf8'))
  for (const ev of ['SessionStart', 'Stop']) {
    const ours = j.hooks[ev].flatMap(g => g.hooks).filter(h => h.command.includes('listen.mjs'))
    assert.equal(ours.length, 1)
    assert.equal(ours[0].asyncRewake, true)
  }
  assert.equal(spawnSync('node', [LISTEN, 'uninstall'], { env }).status, 0)
  j = JSON.parse(fs.readFileSync(settings, 'utf8'))
  assert.deepEqual(j, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } })
})

test('link_peers lists AI sessions in other panes of the same tmux window that have not joined', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'win-'))
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
  const fake = spawn(path.join(bin, 'codex'), [], { stdio: 'ignore' })
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "%1 $$"\necho "%7 ${fake.pid}"\n`, { mode: 0o755 })
  const a = start('claude', 'win-a', { LINK_PANE: '%1', PATH: `${bin}:${process.env.PATH}` })
  await a.init()
  const r = await a.tool('link_peers')
  fake.kill()
  a.stop()
  assert.match(r.text, /not linked yet: codex \(pane %7\)/)
})

test('the Windows SendKeys script escapes + ^ % ~ ( ) { } [ ] with real backslashes', async () => {
  const { WIN_SEND_SCRIPT } = await import('./proc.mjs')
  assert.ok(WIN_SEND_SCRIPT.includes('"[\\+\\^%~\\(\\)\\{\\}\\[\\]]"'), WIN_SEND_SCRIPT)
})

test('claude-worker.sh opens only trusted folders, names the worker, and never runs headless', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./claude-worker.sh', import.meta.url).pathname
  const trusted = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-trusted-')))
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-other-')))
  const cfg = path.join(trusted, 'claude.json')
  fs.writeFileSync(cfg, JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }))
  const run = (...a) => spawnSync('bash', [script, '-n', ...a], { encoding: 'utf8', env: { ...process.env, CLAUDE_JSON: cfg } })
  const ok = run('-d', trusted, '-N', 'claude-t1', '-m', 'sonnet', '-p', 'do x')
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /LINK_NAME=claude-t1 .*claude --model sonnet /)
  assert.match(ok.stdout, /link_report/)
  assert.doesNotMatch(ok.stdout, / -p /)
  assert.equal(run('-d', other).status, 3)
  assert.equal(run('-d', trusted, '-m', 'x;rm -rf /').status, 2)
  assert.equal(run('-d', trusted, '-N', 'bad name').status, 2)
})

test('install-skill.sh copies the share skill into the skill folders that exist', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./install-skill.sh', import.meta.url).pathname
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-a-'))
  const r = spawnSync('bash', [script, 'share'], { encoding: 'utf8', env: { ...process.env, SKILLS_DIRS: `${a}:${a}-missing` } })
  assert.equal(r.status, 0)
  assert.ok(fs.existsSync(path.join(a, 'share', 'SKILL.md')))
  assert.match(r.stdout, /skip .*-missing/)
  assert.equal(spawnSync('bash', [script, 'no/such'], { encoding: 'utf8' }).status, 2)
})

test('picker.mjs merges Claude, Codex and agy sessions from bridge, tmux and processes, and renders a clickable left sidebar', async () => {
  const { buildSessionGroups, renderSidebar, focusSession } = await import('./picker.mjs')
  const now = 10_000
  const { groups, flat } = buildSessionGroups({
    now,
    hostId: 'id-claude',
    bridgePeers: [
      { id: 'id-claude', name: 'claude-host', cli: 'claude', cwd: '/work/app', pid: 100, tty: 'ttys001', pane: '', seen: now },
      { id: 'id-codex-new', name: 'codex-1', cli: 'codex', cwd: '/work/app', pid: 201, tty: '', pane: '%2', seen: now },
      { id: 'id-codex-old', name: 'codex-stale', cli: 'codex', cwd: '/work/app', pid: 202, tty: '', pane: '', seen: now },
      { id: 'id-agy', name: 'agy-1', cli: 'agy', cwd: '/work/app', pid: 301, tty: 'ttys003', pane: '', seen: now },
    ],
    tmuxPanes: [
      { cli: 'codex', pid: 201, session: 'ai-link', windowIndex: 1, windowName: 'codex-1', pane: '%2', cwd: '/work/app', paneActive: false, windowActive: false, tty: 'ttys010' },
      { cli: 'agy', pid: 399, session: 'ai-link', windowIndex: 2, windowName: 'agy-unlinked', pane: '%3', cwd: '/work/other', paneActive: true, windowActive: true, tty: 'ttys011' },
    ],
    procWindows: [
      { cli: 'claude', tty: 'ttys001', pid: 100, cwd: '/work/app' },
      { cli: 'codex', tty: 'ttys002', pid: 202, cwd: '/work/app' },
      { cli: 'agy', tty: 'ttys003', pid: 301, cwd: '/work/app' },
    ],
    etimes: new Map([[201, 10], [202, 500]]),
  })

  assert.deepEqual(groups.map(g => g.cli), ['claude', 'codex', 'agy'])
  assert.equal(groups[0].items.length, 1)
  assert.equal(groups[0].items[0].isHost, true)
  assert.equal(groups[1].items.some(i => i.name === 'codex-1' && i.pane === '%2'), true)
  assert.equal(groups[2].items.length, 2)
  assert.equal(groups[2].items.some(i => i.name === 'agy-unlinked' && i.pane === '%3'), true)

  const { screen, rowMap } = renderSidebar({ groups, selectedIndex: 1, width: 32, height: 24, mode: 'tmux', now })
  assert.match(screen, /AI-LINK WORKSPACE/)
  assert.match(screen, /CLAUDE/)
  assert.match(screen, /CODEX/)
  assert.match(screen, /AGY/)
  assert.equal(rowMap.size, flat.length)

  const logFile = path.join(HOME, 'picker-focus.log')
  const res = await focusSession(flat[0], { logFile })
  assert.equal(res.ok, true)
  assert.match(fs.readFileSync(logFile, 'utf8'), /claude-host/)
})

test('picker.sh and link-workspace.sh validate arguments and build commands in dry-run mode', async () => {
  const { spawnSync } = await import('node:child_process')
  const pickerSh = new URL('./picker.sh', import.meta.url).pathname
  const wsSh = new URL('./link-workspace.sh', import.meta.url).pathname

  const pFull = spawnSync('bash', [pickerSh, '-n', '-d', os.tmpdir()], { encoding: 'utf8' })
  assert.equal(pFull.status, 0)
  assert.match(pFull.stdout, /fullscreen: .*picker\.mjs/)
  const pOk = spawnSync('bash', [pickerSh, '-n', '-w', '320', '-d', os.tmpdir()], { encoding: 'utf8' })
  assert.equal(pOk.status, 0)
  assert.match(pOk.stdout, /sidebar\(320px\): .*picker\.mjs/)
  assert.equal(spawnSync('bash', [pickerSh, '-n', '-w', '50'], { encoding: 'utf8' }).status, 2)

  const wOk = spawnSync('bash', [wsSh, '-n', '-s', 'work-1', '-m', 'all', '-w', '30', '-d', os.tmpdir()], { encoding: 'utf8' })
  assert.equal(wOk.status, 0)
  assert.match(wOk.stdout, /workspace session=work-1 mode=all width=30/)
  assert.equal(spawnSync('bash', [wsSh, '-n', '-m', 'bogus'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync('bash', [wsSh, '-n', '-w', '10'], { encoding: 'utf8' }).status, 2)
})

test('picker.mjs discovers past Claude, Codex and agy sessions and resumes/continues them', async () => {
  const { readPastSessions, buildSessionGroups, renderSidebar, focusSession, continueLatestCli, resumeCommandFor, continueCommandFor, ago } = await import('./picker.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-past-'))
  const claudeDir = path.join(root, 'claude-projects', '-work-app')
  const codexDir = path.join(root, 'codex-sessions', '2026', '11', '24')
  const agyDir = path.join(root, 'agy')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.mkdirSync(codexDir, { recursive: true })
  fs.mkdirSync(agyDir, { recursive: true })

  fs.writeFileSync(path.join(claudeDir, '11111111-1111-1111-1111-111111111111.jsonl'), [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: '11111111-1111-1111-1111-111111111111' }),
    JSON.stringify({ type: 'user', cwd: '/work/app', sessionId: '11111111-1111-1111-1111-111111111111', message: { role: 'user', content: 'build the login screen' } }),
  ].join('\n') + '\n')

  fs.writeFileSync(path.join(codexDir, 'rollout-2026-11-24T10-00-00-22222222-2222-2222-2222-222222222222.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: '22222222-2222-2222-2222-222222222222', cwd: '/work/api' } }),
    JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>skip me</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'fix flaky webhook test' }] } }),
  ].join('\n') + '\n')

  fs.writeFileSync(path.join(agyDir, 'history.jsonl'), [
    JSON.stringify({ display: '/clear', timestamp: 1000, workspace: '/work/web', conversationId: '33333333-3333-3333-3333-333333333333', type: 'slash_command' }),
    JSON.stringify({ display: 'add dark mode toggle', timestamp: 2000, workspace: '/work/web', conversationId: '33333333-3333-3333-3333-333333333333' }),
  ].join('\n') + '\n')

  const past = readPastSessions({
    claudeDir: path.join(root, 'claude-projects'),
    codexDir: path.join(root, 'codex-sessions'),
    agyDir,
    limitPerCli: 5,
  })
  assert.equal(past.length, 3)
  assert.equal(past.find(p => p.cli === 'claude')?.name, 'build the login screen')
  assert.equal(past.find(p => p.cli === 'codex')?.name, 'fix flaky webhook test')
  assert.equal(past.find(p => p.cli === 'agy')?.name, 'add dark mode toggle')

  const now = 10_000_000
  const { groups, flat } = buildSessionGroups({
    now,
    bridgePeers: [{ id: 'live-claude', name: 'claude-live', cli: 'claude', cwd: '/work/app', pid: 100, tty: 'ttys001', pane: '', seen: now }],
    procWindows: [{ cli: 'claude', tty: 'ttys001', pid: 100, cwd: '/work/app' }],
    pastSessions: past,
  })
  assert.equal(groups[0].items[0].isPast, undefined)
  assert.equal(groups[0].items[1].isPast, true)
  assert.equal(flat.filter(i => i.isPast).length, 3)

  // Render includes past icon (↺) and live/past counts (narrow sidebar)
  const { screen, rowMap } = renderSidebar({ groups, selectedIndex: 1, width: 36, height: 24, now })
  assert.match(screen, /↺/)
  assert.match(screen, /1 live · 1 past/)
  assert.equal(rowMap.size, flat.length)

  // Wide full-screen render draws 3 side-by-side tables (AGY, CLAUDE, CODEX) with 2D hitMap
  const wide = renderSidebar({ groups, selectedIndex: 0, width: 120, height: 30, now })
  assert.equal(wide.layout, 'tables')
  assert.match(wide.screen, /AI-LINK SESSION PICKER/)
  assert.match(wide.screen, /AGY \(0 live · 1 past\)/)
  assert.match(wide.screen, /CLAUDE \(1 live · 1 past\)/)
  assert.match(wide.screen, /CODEX \(0 live · 1 past\)/)
  assert.equal(wide.hitMap.length, flat.length)
  // All 3 columns have distinct horizontal ranges
  const colStarts = new Set(wide.hitMap.map(h => h.colStart))
  assert.equal(colStarts.size, 3)

  // Resume commands and focusSession delegation
  assert.match(resumeCommandFor('claude', '11111111-1111-1111-1111-111111111111'), /claude --resume '11111111-1111-1111-1111-111111111111'/)
  assert.match(resumeCommandFor('codex', '22222222-2222-2222-2222-222222222222', '/work/api'), /codex resume -C '\/work\/api'.*'22222222-2222-2222-2222-222222222222'/)
  assert.match(resumeCommandFor('agy', '33333333-3333-3333-3333-333333333333'), /agy --resume '33333333-3333-3333-3333-333333333333'/)
  assert.equal(resumeCommandFor('claude', 'bad;rm -rf /'), '')
  assert.match(continueCommandFor('claude'), /claude --continue/)
  assert.match(continueCommandFor('codex'), /codex resume --last/)
  assert.match(continueCommandFor('agy'), /agy --continue/)
  assert.equal(ago(3 * 86_400_000), '3d')

  const logFile = path.join(root, 'resume.log')
  const r1 = await focusSession(groups[0].items[1], { logFile, dir: root })
  assert.equal(r1.ok, true)
  const r2 = await continueLatestCli('agy', { logFile, dir: root })
  assert.equal(r2.ok, true)
  const r3 = await focusSession(groups[0].items[1], { logFile, dir: root, inTmux: true })
  assert.equal(r3.ok, true)
  const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(logLines[0].action, 'resume')
  assert.equal(logLines[0].sessionId, '11111111-1111-1111-1111-111111111111')
  assert.equal(logLines[1].action, 'continue')
  assert.equal(logLines[1].cli, 'agy')
  assert.equal(logLines[2].action, 'resume')
  assert.equal(logLines[2].inTmux, true)

  // Non-AI tmux windows appear in a dedicated TMUX WINDOWS panel in the full-screen view
  const withTmux = buildSessionGroups({
    now,
    tmuxPanes: [
      { cli: 'tmux', pid: 400, session: 'dev', windowIndex: 0, windowName: 'server', pane: '%9', cwd: '/work/api', paneActive: true, windowActive: true, attached: false, tty: 'ttys020' },
    ],
    pastSessions: past,
  })
  const tmuxWide = renderSidebar({ groups: withTmux.groups, selectedIndex: withTmux.flat.length - 1, width: 120, height: 30, now })
  assert.match(tmuxWide.screen, /\[\+Win\]/)
  assert.match(tmuxWide.screen, /\[\+SplitH\]/)
  assert.match(tmuxWide.screen, /\[\+SplitV\]/)
  assert.match(tmuxWide.screen, /TMUX WINDOWS \(1\)/)
  assert.match(tmuxWide.screen, /dev:0 server/)
  assert.match(tmuxWide.screen, /detached/)
  assert.equal(tmuxWide.hitMap.length, withTmux.flat.length)
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'new-window' && b.row === 1 && b.colStart === 2))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'split-h'))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'split-v'))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'resize-left'))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'resize-right'))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'rename'))
  assert.ok(tmuxWide.buttonMap.some(b => b.action === 'kill'))

  // tmuxControlAction logs all tmux window/pane control actions cleanly
  const { tmuxControlAction } = await import('./picker.mjs')
  const tmuxItem = withTmux.flat[withTmux.flat.length - 1]
  for (const act of ['new-window', 'split-h', 'split-v', 'resize-left', 'resize-right', 'zoom', 'kill']) {
    const r = await tmuxControlAction(act, tmuxItem, { logFile, dir: root })
    assert.equal(r.ok, true)
  }
  const rRen = await tmuxControlAction('rename', tmuxItem, { logFile, dir: root, newName: 'api-srv' })
  assert.equal(rRen.ok, true)
  const allLogs = fs.readFileSync(logFile, 'utf8')
  assert.match(allLogs, /"action":"tmux:new-window"/)
  assert.match(allLogs, /"action":"tmux:resize-right"/)
  assert.match(allLogs, /"newName":"api-srv"/)

  // Regression: narrow 23-col tmux sidebar with 169 past sessions never wraps lines or shifts buttonMap off row 2
  const manyPast = Array.from({ length: 169 }, (_, i) => ({
    cli: 'claude',
    sessionId: `sess-${i}`,
    name: `long session title number ${i}`,
    cwd: '/Users/pauldenchat',
    seen: now - i * 60_000,
  }))
  const narrowMany = buildSessionGroups({ now, pastSessions: manyPast })
  const narrow32 = renderSidebar({ groups: narrowMany.groups, selectedIndex: 0, width: 32, height: 24, mode: 'tmux', now })
  assert.ok(narrow32.buttonMap.some(b => b.action === 'split-h' && b.label === '[+H]' && b.row === 2))
  assert.ok(narrow32.buttonMap.some(b => b.action === 'split-v' && b.label === '[+V]' && b.row === 2))
  const narrowRender = renderSidebar({ groups: narrowMany.groups, selectedIndex: 0, width: 23, height: 24, mode: 'tmux', now })
  assert.match(narrowRender.screen, /\x1b\[\?7l/)
  assert.ok(narrowRender.buttonMap.every(b => b.row === 2))
  assert.ok(narrowRender.buttonMap.some(b => b.action === 'split-h'))
  assert.ok(narrowRender.buttonMap.some(b => b.action === 'split-v'))
  // Verify every positioned line fits within 23 visible chars
  const plainLines = narrowRender.screen
    .replace(/\x1b\[\?7l\x1b\[H\x1b\[2J/, '')
    .split(/\x1b\[\d+;1H/)
    .filter(Boolean)
    .map(l => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  for (const l of plainLines) {
    assert.ok(l.length <= 23, `line wrapped (${l.length} > 23): "${l}"`)
  }
})

test('link-bridge uses only tmux AI peers by default unless include_non_tmux is explicitly requested', async () => {
  const tmuxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'link-tmux-only-'))
  const host = start('claude', 'tmux-host', { LINK_HOME: tmuxHome, LINK_PANE: '%10' })
  const tmuxWorker = start('agy', 'tmux-agy', { LINK_HOME: tmuxHome, LINK_PANE: '%11' })
  const looseWorker = start('codex', 'loose-worker', { LINK_HOME: tmuxHome, LINK_PANE: '', LINK_TTY: 'ttys888' })
  for (const s of [host, tmuxWorker, looseWorker]) await s.init()
  await new Promise(r => setTimeout(r, 300))

  // Default link_peers hides non-tmux session and shows hidden count note
  const peersDefault = await host.tool('link_peers')
  assert.match(peersDefault.text, /tmux-agy\s+\[agy\]/)
  assert.doesNotMatch(peersDefault.text, /loose-worker/)
  assert.match(peersDefault.text, /1 non-tmux session\(s\) hidden/)

  // Default link_host + link_assign(all) assigns ONLY to tmux-agy
  await host.tool('link_host', { on: true })
  const assignAll = await host.tool('link_assign', { worker: 'all', task: 'tmux task' })
  assert.match(assignAll.text, /tmux-agy/)
  assert.doesNotMatch(assignAll.text, /loose-worker/)

  // Direct link_assign / link_tell to a non-tmux peer refuses by default
  const assignRefused = await host.tool('link_assign', { worker: 'loose-worker', task: 'x' })
  assert.equal(assignRefused.isError, true)
  assert.match(assignRefused.text, /outside tmux/)
  const tellRefused = await host.tool('link_tell', { to: 'loose-worker', text: 'hi' })
  assert.equal(tellRefused.isError, true)
  assert.match(tellRefused.text, /outside tmux/)

  // Explicit include_non_tmux: true succeeds
  const peersAll = await host.tool('link_peers', { include_non_tmux: true })
  assert.match(peersAll.text, /loose-worker/)
  const tellOk = await host.tool('link_tell', { to: 'loose-worker', text: 'explicit ask', include_non_tmux: true })
  assert.equal(tellOk.isError, false)
  assert.match(tellOk.text, /Sent to loose-worker/)
  const assignOk = await host.tool('link_assign', { worker: 'loose-worker', task: 'explicit task', include_non_tmux: true })
  assert.equal(assignOk.isError, false)
  assert.match(assignOk.text, /loose-worker/)

  for (const s of [host, tmuxWorker, looseWorker]) s.stop()
})

test('tmux-reap.sh kills SIGHUP-ignoring descendant processes by root PID without touching bystanders', async () => {
  const { spawnSync } = await import('node:child_process')
  const reaper = new URL('./tmux-reap.sh', import.meta.url).pathname
  const target = spawn('sh', ['-c', 'trap "" HUP; sleep 60'], { stdio: 'ignore' })
  const innocent = spawn('sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
  const exited = new Promise(res => target.once('exit', () => res(true)))
  await new Promise(r => setTimeout(r, 150))
  const r = spawnSync('bash', [reaper, 'pid', String(target.pid)], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  const reaped = await Promise.race([exited, new Promise(res => setTimeout(() => res(false), 1500))])
  assert.equal(reaped, true, 'target SIGHUP-ignoring process should be reaped')
  const innocentAlive = (() => {
    try { process.kill(innocent.pid, 0); return innocent.exitCode === null } catch { return false }
  })()
  assert.equal(innocentAlive, true, 'unrelated bystander process must remain alive')
  innocent.kill('SIGKILL')
})

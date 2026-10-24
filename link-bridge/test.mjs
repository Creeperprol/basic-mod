import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'))
const SERVER = new URL('./server.mjs', import.meta.url).pathname

// A tiny MCP client over stdio.
const start = (cli, name, extra = {}) => {
  // LINK_WAKE=0: the servers here would otherwise type into the terminal that runs the tests.
  const p = spawn('node', [SERVER], { env: { ...process.env, LINK_WAKE: '0', LINK_HOME: HOME, LINK_CLI: cli, LINK_NAME: name, ...extra }, stdio: ['pipe', 'pipe', 'inherit'] })
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
  assert.match((await codex.tool('link_inbox')).text, /MESSAGE from "boss":\nhello there/)
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
  assert.match(ok.stdout, /agy --model gemini-3\.8-flash-low -i /)
  assert.match(ok.stdout, /link_report/)
})

test('agy-worker.sh refuses an interactive window in a folder agy does not trust, but not a headless run', async () => {
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
  assert.equal(run('-d', other).status, 0) // headless never asks
  fs.writeFileSync(settings, 'not json')
  assert.equal(run('-w', '-d', other).status, 0) // unreadable settings do not block
})

test('agy-image.sh checks its arguments before starting anything', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = new URL('./agy-image.sh', import.meta.url).pathname
  const none = spawnSync('bash', [script], { encoding: 'utf8' })
  assert.equal(none.status, 2)
  assert.match(none.stderr, /description/)
  const badModel = spawnSync('bash', [script, '-m', 'x;rm -rf /', 'a cat'], { encoding: 'utf8' })
  assert.equal(badModel.status, 2)
  assert.match(badModel.stderr, /invalid model name/)
  const badTime = spawnSync('bash', [script, '-t', 'soon', 'a cat'], { encoding: 'utf8' })
  assert.equal(badTime.status, 2)
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
  const mk = (cli, cwd) => spawn('node', [SERVER], { cwd, env: { ...process.env, LINK_HOME: HOME, LINK_CLI: cli, LINK_NAME: '' }, stdio: ['pipe', 'pipe', 'inherit'] })
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
  const wake = tty => ({ LINK_WAKE: '1', LINK_WAKE_LOG: log, LINK_TTY: tty, LINK_WAKE_GAP_MS: '10' })
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

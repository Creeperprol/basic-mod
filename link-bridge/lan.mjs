#!/usr/bin/env node
// lan.mjs: links the link-bridge sessions of several machines on one network (the same Wi-Fi).
// Run one per machine. It announces this machine's sessions over UDP broadcast, lists the other machines'
// sessions in the local registry (so link_peers shows them), and carries messages, tasks and results
// between machines over HTTP. Every packet is signed with a shared key; anything unsigned is dropped.
//
//   node lan.mjs key          make a key on the first machine (prints it)
//   node lan.mjs join <key>   save that key on each other machine
//   node lan.mjs              run (keep it open; Ctrl-C stops it)
//
// Env: LINK_HOME (default ~/.session-link), LINK_LAN_KEY (overrides the saved key),
//   LINK_LAN_UDP (discovery port, default 47811), LINK_LAN_HTTP (message port, default 47812),
//   LINK_LAN_PEERS="192.168.1.20,host:udpPort" (machines to reach directly when the network blocks broadcast),
//   LINK_LAN_BROADCAST=0 (announce only to LINK_LAN_PEERS; the tests use it).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import dgram from 'node:dgram'
import crypto from 'node:crypto'

const HOME = process.env.LINK_HOME || path.join(os.homedir(), '.session-link')
const UDP_PORT = Number(process.env.LINK_LAN_UDP) || 47811
const HTTP_PORT = Number(process.env.LINK_LAN_HTTP) || 47812
const STALE_MS = 60_000
const ANNOUNCE_MS = 3_000
const SKEW_MS = 60_000 // a signed packet older or newer than this is refused (replay guard, with the nonce cache)
const GIVE_UP_MS = 10 * 60_000 // a message no machine accepted for this long is dropped
const MAX_BODY = 64 * 1024

const dir = (...p) => path.join(HOME, ...p)
for (const d of ['peers', 'inbox', 'tasks']) fs.mkdirSync(dir(d), { recursive: true })
const KEY_FILE = dir('lan.key')

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

// ---------- key ----------
const [cmd, arg] = process.argv.slice(2)
if (cmd === 'key') {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 })
  console.log(fs.readFileSync(KEY_FILE, 'utf8').trim())
  console.error(`On each other machine run: node lan.mjs join <this key>`)
  process.exit(0)
}
if (cmd === 'join') {
  if (!arg || arg.length < 16) {
    console.error('usage: node lan.mjs join <key>   (the key printed by "node lan.mjs key" on the first machine)')
    process.exit(2)
  }
  fs.writeFileSync(KEY_FILE, arg.trim(), { mode: 0o600 })
  console.log('Key saved. Now run: node lan.mjs')
  process.exit(0)
}
if (cmd) {
  console.error('usage: node lan.mjs [key | join <key>]')
  process.exit(2)
}
const KEY = process.env.LINK_LAN_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '')
if (KEY.length < 16) {
  console.error('No key. On the first machine run "node lan.mjs key", then "node lan.mjs join <key>" on the others.')
  process.exit(2)
}

// ---------- signing ----------
const sign = body => crypto.createHmac('sha256', KEY).update(body).digest('hex')
const signedOk = (body, sig) => {
  const want = Buffer.from(sign(body), 'hex')
  const got = Buffer.from(String(sig || ''), 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}
const nonces = new Map() // nonce -> expiry
const fresh = (at, nonce) => {
  const now = Date.now()
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n)
  if (typeof at !== 'number' || Math.abs(now - at) > SKEW_MS || typeof nonce !== 'string' || nonces.has(nonce)) return false
  nonces.set(nonce, now + 2 * SKEW_MS)
  return true
}
const pack = obj => {
  const body = JSON.stringify({ ...obj, at: Date.now(), nonce: crypto.randomBytes(12).toString('hex') })
  return { body, sig: sign(body) }
}

// ---------- this machine ----------
const MID = (() => {
  const f = dir('lan-id')
  const v = readJson(f)
  if (v) return v
  const id = crypto.randomUUID()
  writeJson(f, id)
  return id
})()
const MACHINE = (os.hostname() || 'machine').replace(/\.local$/, '').slice(0, 40)

const localPeers = () => {
  const host = readJson(dir('host.json'))
  const out = []
  for (const f of fs.readdirSync(dir('peers'))) {
    if (!f.endsWith('.json')) continue
    const p = readJson(dir('peers', f))
    if (!p || p.remote || Date.now() - p.seen > STALE_MS || !alive(p.pid)) continue
    out.push({ id: p.id, name: p.name, cli: p.cli, cwd: path.basename(p.cwd || ''), isHost: host?.id === p.id })
  }
  return out
}
const remotePeer = id => {
  const p = readJson(dir('peers', `${id}.json`))
  return p && p.remote ? p : null
}

// ---------- discovery (UDP) ----------
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
const targets = () => {
  const list = process.env.LINK_LAN_BROADCAST === '0' ? [] : [['255.255.255.255', UDP_PORT]]
  for (const t of (process.env.LINK_LAN_PEERS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [h, p] = t.split(':')
    list.push([h, Number(p) || UDP_PORT])
  }
  return list
}
const announce = () => {
  const { body, sig } = pack({ v: 1, mid: MID, machine: MACHINE, http: HTTP_PORT, peers: localPeers() })
  const buf = Buffer.from(JSON.stringify({ body, sig }))
  if (buf.length > 60_000) return
  for (const [h, p] of targets()) sock.send(buf, p, h, () => {})
}
sock.on('message', (buf, rinfo) => {
  let pkt, a
  try {
    pkt = JSON.parse(String(buf))
    if (!signedOk(pkt.body, pkt.sig)) return
    a = JSON.parse(pkt.body)
  } catch {
    return
  }
  if (a.v !== 1 || a.mid === MID || !Array.isArray(a.peers) || !fresh(a.at, a.nonce)) return
  const machine = String(a.machine || 'machine').slice(0, 40)
  const keep = new Set()
  for (const p of a.peers.slice(0, 100)) {
    if (typeof p?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.id)) continue
    const mine = readJson(dir('peers', `${p.id}.json`))
    if (mine && !mine.remote) continue // never overwrite a session of this machine
    keep.add(p.id)
    writeJson(dir('peers', `${p.id}.json`), {
      id: p.id,
      name: String(p.name || '').slice(0, 60),
      cli: String(p.cli || 'agent').slice(0, 20),
      cwd: String(p.cwd || '').slice(0, 80),
      remote: true,
      machine,
      mid: a.mid,
      addr: rinfo.address,
      http: Number(a.http) || HTTP_PORT,
      isHost: !!p.isHost,
      pid: 0,
      seen: Date.now(),
    })
  }
  // Sessions that machine no longer lists have ended there.
  for (const f of fs.readdirSync(dir('peers'))) {
    const p = f.endsWith('.json') && readJson(dir('peers', f))
    if (p && p.remote && p.mid === a.mid && !keep.has(p.id)) fs.rmSync(dir('peers', f), { force: true })
  }
})

// ---------- delivery (HTTP) ----------
const server = http.createServer((req, res) => {
  const done = (code, text) => {
    res.writeHead(code, { 'content-type': 'text/plain' })
    res.end(text)
  }
  if (req.method !== 'POST' || req.url !== '/deliver') return done(404, 'not found')
  let body = ''
  let size = 0
  req.setEncoding('utf8')
  req.on('data', c => {
    size += c.length
    if (size > MAX_BODY) {
      done(413, 'too large')
      req.destroy()
    } else body += c
  })
  req.on('end', () => {
    if (res.writableEnded) return
    if (!signedOk(body, req.headers['x-link-sig'])) return done(401, 'bad signature')
    let d
    try {
      d = JSON.parse(body)
    } catch {
      return done(400, 'bad json')
    }
    if (!fresh(d.at, d.nonce)) return done(401, 'stale')
    const to = String(d.to || '')
    const target = /^[0-9a-f-]{36}$/.test(to) && readJson(dir('peers', `${to}.json`))
    if (!target || target.remote) return done(404, 'no such session here')
    const m = d.msg || {}
    if (!['msg', 'task', 'result', 'rename'].includes(m.kind)) return done(400, 'bad kind')
    const msg = {
      kind: m.kind,
      from: String(m.from || ''),
      fromName: `${String(m.fromName || 'someone').slice(0, 60)}@${String(d.machine || 'lan').slice(0, 40)}`,
      at: Number(m.at) || Date.now(),
      ...(m.text !== undefined && { text: String(m.text).slice(0, 20_000) }),
      ...(m.taskId !== undefined && { taskId: String(m.taskId).slice(0, 20) }),
      ...(m.name !== undefined && { name: String(m.name).slice(0, 60) }),
      via: 'lan',
    }
    const box = dir('inbox', to)
    fs.mkdirSync(box, { recursive: true })
    writeJson(path.join(box, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`), msg)
    done(200, 'ok')
  })
})

const post = (peer, to, msg) =>
  new Promise(resolve => {
    const { body, sig } = pack({ to, machine: MACHINE, msg })
    const req = http.request({ host: peer.addr, port: peer.http, path: '/deliver', method: 'POST', timeout: 5_000, headers: { 'content-type': 'application/json', 'x-link-sig': sig, 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(0))
    req.end(body)
  })

// Messages written by this machine's sessions into a remote session's inbox are carried over and removed here.
let busy = false
const forward = async () => {
  if (busy) return
  busy = true
  try {
    for (const to of fs.readdirSync(dir('inbox'))) {
      const peer = remotePeer(to)
      if (!peer) continue
      const box = dir('inbox', to)
      for (const f of fs.readdirSync(box).filter(f => f.endsWith('.json')).sort()) {
        const file = path.join(box, f)
        const msg = readJson(file)
        if (!msg) continue
        const code = await post(peer, to, msg)
        if (code === 200 || code === 404 || code === 400) fs.rmSync(file, { force: true }) // 404/400: that machine will never take it
        else if (Date.now() - (msg.at || 0) > GIVE_UP_MS) fs.rmSync(file, { force: true })
        else break // keep the order: try this target again next round
      }
    }
  } catch {
    // a vanished file or folder: next round
  } finally {
    busy = false
  }
}

sock.bind(UDP_PORT, () => {
  sock.setBroadcast(true)
  server.listen(HTTP_PORT, () => {
    console.log(`link lan: ${MACHINE} on UDP ${UDP_PORT} / HTTP ${HTTP_PORT}. Sessions on other machines with the same key appear in link_peers.`)
    announce()
  })
})
server.on('error', e => {
  console.error(`link lan: ${e.message}`)
  process.exit(1)
})
setInterval(announce, ANNOUNCE_MS)
setInterval(forward, 500)

const bye = () => {
  for (const f of fs.readdirSync(dir('peers'))) {
    const p = f.endsWith('.json') && readJson(dir('peers', f))
    if (p && p.remote) fs.rmSync(dir('peers', f), { force: true })
  }
  process.exit(0)
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)

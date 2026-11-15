// lib/checks.js probes against fake LOCAL servers (127.0.0.1 or localhost,
// port 0): http (status, expect.body, body limit, timeout, strict TLS, tls: insecure exception,
// private IPv4), tcp, tls (expiry, warnDays and critDays, injected clock), dns (silent server),
// and the runCheck second attempt. Timeout, pause and clock injected (CHECK_DEFAULTS), never a 5 s
// wait. TEST certificates generated at startup (tls-fixtures.js, fixtures/tls/gen.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { runCheck, describe, CHECK_DEFAULTS } from '../lib/checks.js'
import { tlsFixtures } from './tls-fixtures.js'
import { USER_AGENT } from '../lib/user-agent.js'

const FIX = tlsFixtures()
const read = f => fs.readFileSync(path.join(FIX, f))
const DAY = 86400_000
const FAST = { timeoutMs: 150, retryDelayMs: 0 }
// TLS handshake (certificate refused, then accepted): the timeout is not what is tested; 150 ms
// was too tight under load ("timeout" instead of the certificate error)
const TLS_OPTS = { timeoutMs: 2000, retryDelayMs: 0 }

const listen = (srv, port, host) => new Promise((resolve, reject) => {
  srv.once('error', reject)
  srv.listen(port, host, () => { srv.off('error', reject); resolve() })
})
const closeAll = list => Promise.all(list.map(x => new Promise(r => { for (const s of x.sockets) s.destroy(); x.srv.close(() => r()) })))

// local HTTP(S) server; handler(req, res, n) with n = rank of the request (1, 2…). For
// host 'localhost' → SAME port on 127.0.0.1 AND ::1 (loopbacks only), because the name does not
// say where the client connects: listen('localhost') resolves without ADDRCONFIG (::1 first in
// verbatim order), net.connect (hence undici) with ADDRCONFIG: without global IPv6 (devbox),
// 127.0.0.1 only; with IPv6, ::1 first. Without IPv6 at all (::1 missing): 127.0.0.1 only.
async function server(t, handler, { tls = null, host = '127.0.0.1' } = {}) {
  const seen = []
  const onReq = (req, res) => {
    seen.push({ path: req.url, headers: req.headers })
    handler(req, res, seen.length)
  }
  const make = () => {
    const srv = tls ? https.createServer({ key: read(`${tls}.key`), cert: read(`${tls}.pem`) }, onReq) : http.createServer(onReq)
    srv.on('tlsClientError', () => {})
    const sockets = new Set()
    srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    return { srv, sockets }
  }
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
  for (let attempt = 0; ; attempt++) {
    const list = []
    try {
      for (const [i, h] of hosts.entries()) {
        const x = make()
        try {
          await listen(x.srv, i === 0 ? 0 : list[0].srv.address().port, h)
        } catch (e) {
          if (i > 0 && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) break // no IPv6
          throw e
        }
        list.push(x)
      }
      t.after(() => closeAll(list))
      return { port: list[0].srv.address().port, seen, hosts: list.map(x => x.srv.address().address) }
    } catch (e) {
      await closeAll(list)
      // port taken on ::1 only: retry with another port
      if (e.code !== 'EADDRINUSE' || attempt >= 4) throw e
    }
  }
}
// closed local port: opened then closed again
async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}

test('prod defaults unchanged: 5 s timeout, second attempt after 500 ms, real clock', () => {
  assert.equal(CHECK_DEFAULTS.timeoutMs, 5000)
  assert.equal(CHECK_DEFAULTS.retryDelayMs, 500)
  assert.ok(Math.abs(CHECK_DEFAULTS.now() - Date.now()) < 1000)
  assert.ok(Object.isFrozen(CHECK_DEFAULTS))
})

test('http status: without expect, < 500 → ok (404 included), ≥ 500 → crit; expect.status number or list', async t => {
  const codes = { '/200': 200, '/404': 404, '/503': 503, '/204': 204 }
  const s = await server(t, (req, res) => { res.writeHead(codes[req.url] ?? 500); res.end('x') })
  const u = p => `http://127.0.0.1:${s.port}${p}`
  const r = async (p, expect) => runCheck({ type: 'http', url: u(p), expect }, FAST)
  assert.deepEqual(pick(await r('/200')), ['ok', 200, undefined])
  assert.deepEqual(pick(await r('/404')), ['ok', 404, undefined])
  assert.deepEqual(pick(await r('/503')), ['crit', 503, 'HTTP 503'])
  assert.deepEqual(pick(await r('/404', { status: 404 })), ['ok', 404, undefined])
  assert.deepEqual(pick(await r('/200', { status: 204 })), ['crit', 200, 'HTTP 200'])
  assert.deepEqual(pick(await r('/204', { status: [200, 204] })), ['ok', 204, undefined])
  const ok = await r('/200')
  assert.ok(Number.isInteger(ok.latencyMs) && ok.latencyMs >= 0)
  // header: the dashboard User-Agent
  assert.equal(s.seen.at(-1).headers['user-agent'], USER_AGENT)
})
const pick = r => [r.state, r.code, r.error]

test('http expect.body: keyword present → ok; missing → crit with keyword missing error; beyond 1 MiB (plus one block read of at most 64 KiB), not read', async t => {
  const big = 'a'.repeat(1024 * 1024 + 256 * 1024) + 'TARDIF'
  const s = await server(t, (req, res) => res.end(req.url === '/big' ? big : '<html>tout va bien</html>'))
  const c = (p, body) => ({ type: 'http', url: `http://127.0.0.1:${s.port}${p}`, expect: { body } })
  assert.deepEqual(pick(await runCheck(c('/', 'tout va bien'), FAST)), ['ok', 200, undefined])
  assert.deepEqual(pick(await runCheck(c('/', 'panne'), FAST)), ['crit', 200, 'mot-clé « panne » absent'])
  assert.deepEqual(pick(await runCheck(c('/big', 'TARDIF'), FAST)), ['crit', 200, 'mot-clé « TARDIF » absent'])
})

test('http timeout: silent server → crit "timeout" at the injected timeout; closed port → crit ECONNREFUSED', async t => {
  const s = await server(t, () => { /* never answers */ })
  const t0 = Date.now()
  const r = await runCheck({ type: 'http', url: `http://127.0.0.1:${s.port}/` }, { timeoutMs: 120, retryDelayMs: 0 })
  assert.deepEqual(pick(r), ['crit', 0, 'timeout'])
  assert.ok(Date.now() - t0 < 2000, 'two attempts of 120 ms, not 5 s')
  assert.equal(s.seen.length, 2, 'second attempt')
  const refused = await runCheck({ type: 'http', url: `http://127.0.0.1:${await closedPort()}/` }, FAST)
  assert.deepEqual(pick(refused), ['crit', 0, 'ECONNREFUSED'])
})

test('http TLS: name (localhost) with an unknown CA → crit, no request; tls: insecure → ok; literal private IPv4 → ok', async t => {
  const s = await server(t, (req, res) => res.end('ok'), { tls: 'leaf-b', host: 'localhost' })
  // never beyond the loopbacks
  assert.ok(s.hosts.every(h => h === '127.0.0.1' || h === '::1'), s.hosts.join(', '))
  const strict = await runCheck({ type: 'http', url: `https://localhost:${s.port}/` }, TLS_OPTS)
  assert.equal(strict.state, 'crit')
  assert.equal(strict.code, 0)
  assert.match(strict.error, /SELF_SIGNED|UNABLE_TO|CERT/)
  assert.equal(s.seen.length, 0)
  const insecure = await runCheck({ type: 'http', url: `https://localhost:${s.port}/`, tls: 'insecure', tlsReason: 'banc' }, TLS_OPTS)
  assert.deepEqual(pick(insecure), ['ok', 200, undefined])
  const a = await server(t, (req, res) => res.end('ok'), { tls: 'leaf-a' })
  assert.deepEqual(pick(await runCheck({ type: 'http', url: `https://127.0.0.1:${a.port}/` }, TLS_OPTS)), ['ok', 200, undefined])
})

test('tcp: open port → ok (tcp code); closed port → crit ECONNREFUSED, after a second attempt', async t => {
  const srv = net.createServer(s => s.end())
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  let accepted = 0
  srv.on('connection', () => accepted++)
  const ok = await runCheck({ type: 'tcp', target: `127.0.0.1:${srv.address().port}` }, FAST)
  assert.deepEqual([ok.state, ok.code, ok.error], ['ok', 'tcp', undefined])
  assert.equal(accepted, 1)
  const bad = await runCheck({ type: 'tcp', target: `127.0.0.1:${await closedPort()}` }, FAST)
  assert.deepEqual([bad.state, bad.code, bad.error], ['crit', 0, 'ECONNREFUSED'])
})

test('tls expiry (injected clock): defaults 21 d and 7 d, config thresholds, expired, issuer; non-TLS server → crit; silent server → timeout', async t => {
  const s = await server(t, (req, res) => res.end(), { tls: 'leaf-a' })
  const validTo = Date.parse(new X509Certificate(read('leaf-a.pem')).validTo)
  const at = (days, extra = {}) => runCheck({ type: 'tls', host: '127.0.0.1', port: s.port, ...extra }, { ...FAST, now: () => validTo - days * DAY })
  const ok = await at(30)
  assert.deepEqual([ok.state, ok.code, ok.tls.daysLeft, ok.tls.issuer, ok.tls.validTo], ['ok', 'tls', 30, 'vigie tests', new Date(validTo).toISOString()])
  assert.deepEqual([(await at(21.5)).state, (await at(20.5)).state], ['ok', 'warn'])
  assert.deepEqual([(await at(7.5)).state, (await at(6.5)).state], ['warn', 'crit'])
  const expired = await at(-2)
  assert.deepEqual([expired.state, expired.error, expired.tls.daysLeft], ['crit', 'certificat expiré', -2])
  assert.equal((await at(50, { warnDays: 60, critDays: 40 })).state, 'warn')
  assert.equal((await at(39, { warnDays: 60, critDays: 40 })).state, 'crit')
  assert.equal((await at(61, { warnDays: 60, critDays: 40 })).state, 'ok')
  // plain HTTP server: the handshake fails
  const plain = await server(t, (req, res) => res.end())
  const notTls = await runCheck({ type: 'tls', host: '127.0.0.1', port: plain.port }, FAST)
  assert.equal(notTls.state, 'crit')
  assert.equal(notTls.code, 0)
  assert.ok(notTls.error)
  // TCP accepted, no TLS answer: injected timeout
  const mute = net.createServer(() => {})
  await new Promise(r => mute.listen(0, '127.0.0.1', r))
  const held = new Set()
  mute.on('connection', c => held.add(c))
  t.after(() => new Promise(r => { for (const c of held) c.destroy(); mute.close(r) }))
  const to = await runCheck({ type: 'tls', host: '127.0.0.1', port: mute.address().port }, { timeoutMs: 100, retryDelayMs: 0 })
  assert.deepEqual([to.state, to.error], ['crit', 'timeout'])
})

test('dns: silent server → crit (injected timeout, second attempt); the rest is covered by dns-check', async t => {
  const sock = dgram.createSocket('udp4')
  let queries = 0
  sock.on('message', () => queries++)
  await new Promise(r => sock.bind(0, '127.0.0.1', r))
  t.after(() => sock.close())
  const t0 = Date.now()
  const r = await runCheck({ type: 'dns', server: `127.0.0.1:${sock.address().port}`, name: 'muet.exemple.test' }, { timeoutMs: 100, retryDelayMs: 0 })
  assert.equal(r.state, 'crit')
  assert.equal(r.code, 0)
  assert.match(r.error, /TIMEOUT/i)
  assert.equal(queries, 2)
  assert.ok(Date.now() - t0 < 3000)
})

test('runCheck second attempt: crit confirmed (2 requests); ok on the second attempt (503 then 200); ok at first try → 1 single request; injected pause respected', async t => {
  const down = await server(t, (req, res) => { res.writeHead(503); res.end() })
  const r1 = await runCheck({ type: 'http', url: `http://127.0.0.1:${down.port}/` }, FAST)
  assert.deepEqual([r1.state, down.seen.length], ['crit', 2])
  const flaky = await server(t, (req, res, n) => { res.writeHead(n === 1 ? 503 : 200); res.end() })
  const r2 = await runCheck({ type: 'http', url: `http://127.0.0.1:${flaky.port}/` }, FAST)
  assert.deepEqual([r2.state, r2.code, flaky.seen.length], ['ok', 200, 2])
  const up = await server(t, (req, res) => res.end())
  const r3 = await runCheck({ type: 'http', url: `http://127.0.0.1:${up.port}/` }, FAST)
  assert.deepEqual([r3.state, up.seen.length], ['ok', 1])
  const slow = await server(t, (req, res) => { res.writeHead(503); res.end() })
  const t0 = Date.now()
  await runCheck({ type: 'http', url: `http://127.0.0.1:${slow.port}/` }, { timeoutMs: 1000, retryDelayMs: 200 })
  assert.ok(Date.now() - t0 >= 195, 'pause between the two attempts')
})

test('describe: labels and display per type', () => {
  assert.deepEqual(describe({ type: 'http', url: 'http://192.0.2.1:8080/x' }), { label: '192.0.2.1:8080', display: 'http://192.0.2.1:8080/x' })
  assert.deepEqual(describe({ type: 'http', url: 'http://appli.exemple.test/' }), { label: 'appli.exemple.test', display: 'http://appli.exemple.test/' })
  assert.deepEqual(describe({ type: 'tcp', target: '192.0.2.1:22' }), { label: 'TCP 22', display: 'tcp://192.0.2.1:22' })
  assert.deepEqual(describe({ type: 'tcp', target: '192.0.2.1:22', name: 'ssh' }), { label: 'ssh', display: 'tcp://192.0.2.1:22' })
  assert.deepEqual(describe({ type: 'tls', host: 'a.test' }), { label: 'certificat', display: 'a.test:443' })
  assert.deepEqual(describe({ type: 'tls', host: '192.0.2.1', servername: 'b.test', port: 8443, label: 'cert' }), { label: 'cert', display: 'b.test:8443' })
  assert.deepEqual(describe({ type: 'dns', server: '192.0.2.53', name: 'x.test' }), { label: 'DNS x.test', display: 'dns://192.0.2.53/x.test' })
})

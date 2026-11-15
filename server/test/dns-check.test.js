// dns check with an expected address (expect.address). Pure verdict,
// then runCheck end to end against a small UDP DNS server on 127.0.0.1 (fake A answers,
// names in .test), and the config schema.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dnsVerdict, runCheck } from '../lib/checks.js'
import { parseConfig } from '../lib/config.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('dnsVerdict: right address (among several) → ok; wrong → crit with the answers and the expected address; none → crit; without expect → unchanged', () => {
  const c = { type: 'dns', expect: { address: '192.0.2.153' } }
  assert.deepEqual(dnsVerdict(['192.0.2.153'], c), { state: 'ok', error: undefined })
  assert.deepEqual(dnsVerdict(['198.51.100.7', '192.0.2.153'], c), { state: 'ok', error: undefined })
  assert.deepEqual(dnsVerdict(['198.51.100.7'], c), { state: 'crit', error: 'réponse 198.51.100.7, attendu 192.0.2.153' })
  assert.deepEqual(dnsVerdict(['198.51.100.7', '198.51.100.8'], c), { state: 'crit', error: 'réponse 198.51.100.7, 198.51.100.8, attendu 192.0.2.153' })
  assert.deepEqual(dnsVerdict([], c), { state: 'crit', error: 'aucune adresse' })
  // without expect: any address is right (previous behavior)
  assert.deepEqual(dnsVerdict(['198.51.100.7'], { type: 'dns' }), { state: 'ok', error: undefined })
  assert.deepEqual(dnsVerdict([], { type: 'dns' }), { state: 'crit', error: 'aucune adresse' })
})

// minimal DNS server: answers any A question with the addresses of answers[name] (NOERROR)
async function dnsServer(answers) {
  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, rinfo) => {
    let i = 12
    const labels = []
    while (msg[i]) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString())
      i += msg[i] + 1
    }
    const qEnd = i + 5 // null byte + type + class
    const ips = answers[labels.join('.')] ?? []
    const head = Buffer.alloc(12)
    msg.copy(head, 0, 0, 2) // identifier
    head.writeUInt16BE(0x8180, 2) // response, recursion, NOERROR
    head.writeUInt16BE(1, 4)
    head.writeUInt16BE(ips.length, 6)
    const recs = ips.map(ip => {
      const r = Buffer.alloc(16)
      r.writeUInt16BE(0xc00c, 0) // name: pointer to the question
      r.writeUInt16BE(1, 2) // A
      r.writeUInt16BE(1, 4) // IN
      r.writeUInt32BE(60, 6)
      r.writeUInt16BE(4, 10)
      ip.split('.').forEach((o, k) => r.writeUInt8(Number(o), 12 + k))
      return r
    })
    sock.send(Buffer.concat([head, msg.subarray(12, qEnd), ...recs]), rinfo.port, rinfo.address)
  })
  await new Promise(r => sock.bind(0, '127.0.0.1', r))
  return { server: `127.0.0.1:${sock.address().port}`, close: () => sock.close() }
}

test('runCheck end to end (local DNS server): right address → ok; wrong → crit with the answers; without expect → ok', async () => {
  const s = await dnsServer({ 'home.exemple.test': ['192.0.2.153'], 'ailleurs.exemple.test': ['198.51.100.7', '198.51.100.8'] })
  try {
    const ok = await runCheck({ type: 'dns', server: s.server, name: 'home.exemple.test', expect: { address: '192.0.2.153' } })
    assert.deepEqual([ok.state, ok.code, ok.error], ['ok', 'dns', undefined])
    const bad = await runCheck({ type: 'dns', server: s.server, name: 'ailleurs.exemple.test', expect: { address: '192.0.2.153' } })
    assert.deepEqual([bad.state, bad.error], ['crit', 'réponse 198.51.100.7, 198.51.100.8, attendu 192.0.2.153'])
    const free = await runCheck({ type: 'dns', server: s.server, name: 'ailleurs.exemple.test' })
    assert.equal(free.state, 'ok')
  } finally {
    s.close()
  }
})

test('schema: IPv4 expect.address accepted; invalid (text, CIDR, IPv6, extra key, missing field) refused; config.example.json valid with expect', () => {
  // config.example.json (plus the prod config.json), dns service with expect
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/fixtures/config.reference.json'), 'utf8'))
  const dns = raw.services.find(x => x.id === 'dns')
  const local = dns.checks.find(c => c.type === 'dns' && c.label === 'résolution locale')
  assert.deepEqual(local, { type: 'dns', server: '192.0.2.53', name: 'vigie.example.net', label: 'résolution locale', expect: { address: '192.0.2.40' } })
  const withCheck = c => ({ ...raw, services: raw.services.map(x => (x.id === 'dns' ? { ...x, checks: [c] } : x)) })
  const base = { type: 'dns', server: '192.0.2.158', name: 'home.exemple.test' }
  assert.ok(!parseConfig(withCheck({ ...base, expect: { address: '192.0.2.153' } })).errors)
  assert.ok(!parseConfig(withCheck(base)).errors)
  for (const expect of [{ address: 'pi.hole' }, { address: '192.0.2.0/24' }, { address: '::1' }, { address: '256.1.1.1' }, { address: '192.0.2.153', port: 53 }, {}, 'x']) {
    assert.ok(parseConfig(withCheck({ ...base, expect })).errors, JSON.stringify(expect))
  }
  assert.ok(!parseConfig(raw).errors)
})

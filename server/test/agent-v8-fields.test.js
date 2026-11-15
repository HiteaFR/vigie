// Fields of agent v8 in the allowlist (fs[].inodes, time.ntpSynced, restart,
// posture, listening), read only from v8 on. Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast, cleanSlow, parseReport, RESTART_UNITS_MAX, LISTENING_MAX } from '../lib/agents.js'

const FS = { mount: '/', type: 'ext4', size: 10, used: 5, avail: 5 }
const fast = (version, extra = {}) => cleanFast({ version, ts: 1, fs: [{ ...FS, inodes: { total: 1000, used: 400 } }], ...extra })
const POSTURE = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const slow = (version, extra = {}) => cleanSlow({ version, ts: 1, restart: { units: ['nginx.service', 'php8.4-fpm.service'], processes: 3 }, posture: POSTURE,
  listening: [{ proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd' }, { proto: 'udp', addr: '127.0.0.1', port: 53, process: 'unbound' }], time: { ntpSynced: true }, ...extra })

test('v8 nominal: inodes (fast), restart, posture, listening and time (slow, form confirmed by infra)', () => {
  const f = fast(8)
  assert.deepEqual(f.fs[0].inodes, { total: 1000, used: 400 })
  assert.ok(!Object.hasOwn(f, 'time'), 'time is in the slow report')
  const s = slow(8)
  assert.deepEqual(s.time, { ntpSynced: true })
  assert.deepEqual(s.restart, { units: ['nginx.service', 'php8.4-fpm.service'], processes: 3 })
  assert.deepEqual(s.posture, POSTURE)
  assert.deepEqual(s.listening, [{ proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd' }, { proto: 'udp', addr: '127.0.0.1', port: 53, process: 'unbound' }])
})

test('v7 and v6: nothing new (fields absent from fast, null in slow), even if the agent sent them', () => {
  for (const v of [7, 6, undefined, '8x']) {
    const f = fast(v)
    assert.ok(!Object.hasOwn(f.fs[0], 'inodes') && !Object.hasOwn(f, 'time'), String(v))
    const s = slow(v)
    assert.deepEqual([s.restart, s.posture, s.listening, s.time], [null, null, null, null], String(v))
  }
})

test('refusal: unknown fields, wrong types, values outside the list, control characters, bounds', () => {
  // inodes: integers ≥ 0, used ≤ total, otherwise null
  for (const bad of [{ total: -1, used: 0 }, { total: 10, used: 11 }, { total: '10', used: 1 }, { total: 1.5, used: 1 }, [1, 2], 'x', null]) {
    assert.equal(fast(8, { fs: [{ ...FS, inodes: bad }] }).fs[0].inodes, null, JSON.stringify(bad))
  }
  assert.deepEqual(fast(8, { fs: [{ ...FS, inodes: { total: 5, used: 5, secret: 'x' } }] }).fs[0].inodes, { total: 5, used: 5 })
  // ntpSynced: true, false, otherwise null
  for (const v of ['true', 1, null, undefined]) assert.equal(slow(8, { time: { ntpSynced: v } }).time.ntpSynced, null, String(v))
  assert.equal(slow(8, { time: { ntpSynced: false } }).time.ntpSynced, false)
  assert.deepEqual(slow(8, { time: 'x' }).time, { ntpSynced: null })
  // restart: valid systemd units only, 50 at most; processes integer ≥ 0
  const units = ['ok.service', 'evil\u001b.service', 'sans-suffixe', 'a b.service', '../x.service', 42, 'web@1.service', 'x.timer']
  assert.deepEqual(slow(8, { restart: { units, processes: -2, extra: 1 } }).restart, { units: ['ok.service', 'web@1.service', 'x.timer'], processes: null })
  const many = Array.from({ length: 70 }, (_, i) => `u${i}.service`)
  assert.equal(RESTART_UNITS_MAX, 50)
  assert.equal(slow(8, { restart: { units: many, processes: 0 } }).restart.units.length, 50)
  assert.equal(slow(8, { restart: 'tout' }).restart, null)
  // posture: values outside the list → null; incomplete or unknown firewall → null; unknown fields ignored
  assert.deepEqual(slow(8, { posture: { ssh: { permitRootLogin: 'without-password', passwordAuth: 'no', key: 'x' }, firewall: { type: 'pf', active: true } } }).posture, { ssh: { permitRootLogin: null, passwordAuth: null }, firewall: null })
  assert.deepEqual(slow(8, { posture: { ssh: null, firewall: { type: 'none', active: false } } }).posture, { ssh: null, firewall: { type: 'none', active: false } })
  assert.deepEqual(slow(8, { posture: { firewall: { type: 'ufw' } } }).posture, { ssh: null, firewall: null })
  assert.equal(slow(8, { posture: [] }).posture, null)
  // listening: protocol, address, integer port 1-65535, process ^[A-Za-z0-9._-]{1,32}$ or absent; 128 at most
  const L = [
    { proto: 'tcp', addr: '[::]', port: 443, process: 'nginx' },
    { proto: 'tcp', addr: '::1', port: 5432, process: null },
    { proto: 'tcp', addr: 'fe80::1%eth0', port: 8080 },
    { proto: 'sctp', addr: '0.0.0.0', port: 1, process: 'x' },
    { proto: 'tcp', addr: '0.0.0.0', port: 0, process: 'x' },
    { proto: 'tcp', addr: '0.0.0.0', port: 70000, process: 'x' },
    { proto: 'tcp', addr: '0.0.0.0', port: '22', process: 'x' },
    { proto: 'tcp', addr: 'evil host', port: 22, process: 'x' },
    { proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'ss\u0007hd' },
    { proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'p'.repeat(33) },
    { proto: 'tcp', addr: '0.0.0.0', port: 22, process: '<img>' },
    null,
  ]
  assert.deepEqual(slow(8, { listening: L }).listening, [
    { proto: 'tcp', addr: '[::]', port: 443, process: 'nginx' },
    { proto: 'tcp', addr: '::1', port: 5432, process: null },
    { proto: 'tcp', addr: 'fe80::1%eth0', port: 8080, process: null },
  ])
  assert.equal(LISTENING_MAX, 128)
  assert.equal(slow(8, { listening: Array.from({ length: 200 }, (_, i) => ({ proto: 'tcp', addr: '0.0.0.0', port: i + 1, process: 'x' })) }).listening.length, 128)
  assert.equal(slow(8, { listening: 'x' }).listening, null) // unknown, not an empty list
  assert.equal(slow(8, { listening: undefined }).listening, null)
  assert.deepEqual(slow(8, { listening: [] }).listening, [])
})

test('multi-line v8 report: JSON parsed whole (infra form: restart, posture, listening, time after versions; process null; "*" turned into "::")', () => {
  const raw = ['{"schema":1,"version":8,"mode":"slow","ts":1800000000,',
    '"apt":null,"autoUpdate":null,"images":[],"versions":{},',
    '"restart":{"units":["cron.service","dbus.service"],"processes":9},',
    '"posture":{"ssh":{"permitRootLogin":"prohibit-password","passwordAuth":true},"firewall":{"type":"nftables","active":false}},',
    '"listening":[{"proto":"tcp","addr":"::","port":25,"process":null},{"proto":"tcp","addr":"0.0.0.0","port":8025,"process":"docker-proxy"}],',
    '"time":{"ntpSynced":true}}'].join('\n')
  const s = cleanSlow(parseReport(raw, 'slow'))
  assert.deepEqual(s.restart, { units: ['cron.service', 'dbus.service'], processes: 9 })
  assert.deepEqual(s.posture.firewall, { type: 'nftables', active: false })
  assert.deepEqual(s.listening, [{ proto: 'tcp', addr: '::', port: 25, process: null }, { proto: 'tcp', addr: '0.0.0.0', port: 8025, process: 'docker-proxy' }])
  assert.deepEqual(s.time, { ntpSynced: true })
})

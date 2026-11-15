// Alert engine: quietResolve (the only engine change for the network module). A validated "new device"
// ("Known") resolves without a "restored" message; a rule without quietResolve keeps
// its message; the option survives a restart (persisted payload).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const { config: cfg } = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], gitea: { owner: 'o' } })

function bench(store, conds) {
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const sig = (key, quietResolve) => ({ key, rule: key.split(':')[0], entity: key, title: key, env: 'prod', severity: 'warning', parents: [], cond: conds[key], quietResolve, noRepeat: true })
  const rules = { evaluate: () => [sig('net_new:1', true), sig('service_down:x', false)], impacted: () => ({}) }
  const engine = createEngine({ cfg, store, rules, notifier, clock: createClock('Europe/Paris'), startedAt: T - 3600_000 })
  return { engine, sent }
}

test('quietResolve: notified opening, silent resolution, even after a restart', () => {
  const store = tmpStore('dash-quiet-')
  const conds = { 'net_new:1': true, 'service_down:x': true }
  const b = bench(store, conds)
  b.engine.evaluate({}, T)
  assert.deepEqual(b.sent, ['open:net_new:1', 'open:service_down:x'])
  // restart: the option is read back from the persisted payload
  const payload = JSON.parse(store.db.prepare("SELECT payload FROM alert_state WHERE key = 'net_new:1'").get().payload)
  assert.equal(payload.quietResolve, true)
  const b2 = bench(store, conds)
  conds['net_new:1'] = false
  conds['service_down:x'] = false
  b2.engine.evaluate({}, T + 60_000)
  // "Known": incident closed, no message; the control rule sends its restoration
  assert.deepEqual(b2.sent, ['resolve:service_down:x'])
  const inc = store.db.prepare("SELECT resolved_at FROM incidents WHERE key = 'net_new:1'").get()
  assert.equal(inc.resolved_at, T + 60_000)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM alert_state WHERE state = 'firing'").get().n, 0)
})

// Two monotonic lines. (1) a cond: false carrying quietResolve makes the resolution
// silent even if the alert went out without it; (2) no "stabilized" for an alert with a silent
// resolution. Bench: signals driven by hand, real engine.
const MIN = 60_000
function bench2(store = tmpStore('dash-quiet-')) {
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const sigs = new Map() // key → { cond, quietResolve, forSec, severity }
  const set = (key, v) => sigs.set(key, { severity: 'warning', forSec: 0, ...sigs.get(key), ...v })
  const rules = {
    evaluate: () => [...sigs].map(([key, v]) => ({ key, rule: key.split(':')[0], entity: key, title: key, env: 'prod', parents: [], ...v })),
    impacted: () => ({}),
  }
  const engine = createEngine({ cfg, store, rules, notifier, clock: createClock('Europe/Paris'), startedAt: T - 3600_000 })
  const run = (from, to, step = MIN) => { for (let t = from; t <= to; t += step) engine.evaluate({}, t) }
  return { store, engine, sent, set, run, del: key => sigs.delete(key) }
}
// emission of a key withdrawn by the network module (rules.js): cond: false + quietResolve
const retiredSig = { cond: false, quietResolve: true, severity: 'info' }

test('net_down and net_ip_changed ongoing, reminder due at the same moment, then Delete → 0 messages', () => {
  const b = bench2()
  for (const k of ['net_down:1', 'net_ip_changed:1', 'service_down:y']) b.set(k, { cond: true })
  b.engine.evaluate({}, T)
  assert.deepEqual(b.sent.sort(), ['open:net_down:1', 'open:net_ip_changed:1', 'open:service_down:y'])
  b.sent.length = 0
  const t = T + 24 * 3600_000 // "warning" reminder due (24 h)
  b.set('net_down:1', retiredSig)
  b.set('net_ip_changed:1', retiredSig)
  b.engine.evaluate({}, t)
  assert.deepEqual(b.sent, ['remind:service_down:y']) // the reminder was indeed due: only the control receives it
  b.run(t + MIN, t + 15 * MIN)
  assert.deepEqual(b.sent, ['remind:service_down:y']) // no restored, no reminder, no escalation
  assert.equal(b.engine.active().filter(a => a.key.endsWith(':1')).length, 0)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM incidents WHERE key LIKE '%:1' AND resolved_at = ?").get(t).n, 2)
})

test('pending alert of a deleted entry → 0 messages', () => {
  const b = bench2()
  b.set('net_ip_changed:2', { cond: true, forSec: 600 })
  b.run(T, T + 5 * MIN)
  b.set('net_ip_changed:2', retiredSig)
  b.run(T + 6 * MIN, T + 30 * MIN)
  assert.deepEqual(b.sent, [])
  assert.equal(b.engine.get('net_ip_changed:2'), null)
})

test('non-regression: controls outside the network and normal net_down keep their "restored"', () => {
  const b = bench2()
  for (const k of ['pve_unreachable:prod', 'service_down:z', 'net_down:3']) b.set(k, { cond: true })
  b.engine.evaluate({}, T)
  for (const k of ['pve_unreachable:prod', 'service_down:z', 'net_down:3']) b.set(k, { cond: false })
  b.engine.evaluate({}, T + MIN)
  assert.deepEqual(b.sent.filter(s => s.startsWith('resolve:')).sort(), ['resolve:net_down:3', 'resolve:pve_unreachable:prod', 'resolve:service_down:z'])
})

// flapping: 4 triggers in 30 min (T, T+2, T+4, T+6 min) → "flap", then stability
function flap(b, key, extra = {}) {
  for (let i = 0; i <= 6; i++) {
    b.set(key, { cond: i % 2 === 0, ...extra })
    b.engine.evaluate({}, T + i * MIN)
  }
}

test('entry deleted during a net_down flap, then 2 h → no "stabilized" nor other message', () => {
  const b = bench2()
  flap(b, 'net_down:4')
  assert.ok(b.sent.includes('flap:net_down:4'))
  b.sent.length = 0
  // Delete at T+20: the key is emitted withdrawn for 15 min (until T+35), then disappears
  b.set('net_down:4', retiredSig)
  b.run(T + 20 * MIN, T + 35 * MIN)
  b.del('net_down:4') // no longer emitted: only evaluations and housekeeping run
  b.run(T + 36 * MIN, T + 155 * MIN)
  assert.deepEqual(b.sent, [])
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM alert_state WHERE key = 'net_down:4'").get().n, 0)
})

test('non-regression: a flapping rule outside the network still receives its "stabilized"', () => {
  const b = bench2()
  flap(b, 'service_down:w')
  b.set('service_down:w', { cond: false })
  b.run(T + 7 * MIN, T + 60 * MIN)
  assert.ok(b.sent.includes('stable:service_down:w'), b.sent.join())
})

test('static check: quietResolve appears only in server/lib/network/ and alerts/engine.js', () => {
  const lib = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib')
  const hits = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('quietResolve')) hits.push(path.relative(lib, p))
    }
  }
  walk(lib)
  assert.ok(hits.length >= 2)
  for (const h of hits) assert.ok(h.startsWith(`network${path.sep}`) || h === path.join('alerts', 'engine.js'), h)
})

// tls probe retried quickly after a failure (no certificate read: ECONNRESET at
// Traefik startup, timeout…): 60 s, then doubled, up to the normal interval; a certificate read
// (even close to expiry) restores the normal interval. "Refresh" (runAll) reruns the failed tls
// probes, never those whose certificate was read, without touching the schedule.
// FAKE probe and timers: no connection, no waiting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createMonitor, retryDelay, RETRY_MS } from '../lib/monitor.js'
import { parseConfig } from '../lib/config.js'

const T = Date.parse('2026-10-31T09:00:00Z')
const SIX_H = 6 * 3600_000
function cfgWith(checks) {
  const p = parseConfig({
    version: 2, title: 't', proxmox: [], gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    hosts: [{ id: 'h', name: 'h', kind: 'appliance', env: 'prod', ip: '192.0.2.10' }],
    services: [{ id: 's', name: 'S', group: 'g', host: 'h', checks }],
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
function fakeTimers() {
  let clock = 0
  let seq = 0
  const pending = new Map()
  return {
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { at: clock + ms, ms, fn }); return id },
    clearTimer: id => pending.delete(id),
    pending: () => [...pending.values()].map(p => p.ms),
    count: () => pending.size,
    async advance(ms) {
      const target = clock + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        clock = due[1].at
        due[1].fn()
        await flush()
      }
      clock = target
    },
  }
}
const flush = () => new Promise(r => setImmediate(r))
const FAIL = { state: 'crit', code: 0, error: 'ECONNRESET' }
const CERT = days => ({ state: days < 7 ? 'crit' : days < 21 ? 'warn' : 'ok', code: 'tls', tls: { validTo: new Date(T + days * 86400_000).toISOString(), daysLeft: days, issuer: 'CA factice' } })

test('retryDelay: 60 s, then doubled, capped at the interval; n = 1 (widgets): min(interval, 60 s), as before', () => {
  assert.equal(RETRY_MS, 60_000)
  assert.deepEqual([1, 2, 3, 4, 9, 10, 30].map(n => retryDelay(n, SIX_H)), [60_000, 120_000, 240_000, 480_000, 15_360_000, SIX_H, SIX_H])
  assert.deepEqual([retryDelay(1, 300_000), retryDelay(1, 30_000), retryDelay(0, 300_000)], [60_000, 30_000, 60_000])
  // widgets: the same mechanism, with n = 1; no own constant any more
  const w = fs.readFileSync(new URL('../lib/widgets.js', import.meta.url), 'utf8')
  assert.match(w, /schedule\(w, ok \? every : retryDelay\(1, every\)\)/)
  assert.doesNotMatch(w, /RETRY_MS/)
})

test('tls: failure at startup (ECONNRESET) → retried 60 s later; certificate read → normal interval (6 h)', async () => {
  const tm = fakeTimers()
  const plan = [FAIL, CERT(60)]
  const m = createMonitor(cfgWith([{ type: 'tls', host: 'proxy.test' }]), { ...tm, random: () => 0, now: () => T, run: async () => plan.shift() })
  m.start()
  await tm.advance(0)
  assert.deepEqual([m.result('s#0').state, m.result('s#0').error, tm.pending()], ['crit', 'ECONNRESET', [60_000]])
  await tm.advance(59_999)
  assert.equal(plan.length, 1, 'not before 60 s')
  await tm.advance(1)
  assert.deepEqual([m.result('s#0').state, m.result('s#0').tls.daysLeft, tm.pending()], ['ok', 60, [SIX_H]])
  m.stop()
})

test('tls: repeated failures → 60 s, 2, 4, 8… min up to the 6 h cap, which stays; a success resets (next failure: 60 s); probe error = failure', async () => {
  const tm = fakeTimers()
  let mode = 'fail'
  const m = createMonitor(cfgWith([{ type: 'tls', host: 'proxy.test' }]), {
    ...tm, random: () => 0, now: () => T,
    run: async () => {
      if (mode === 'boum') throw new Error('sonde cassée')
      return mode === 'fail' ? FAIL : CERT(60)
    },
  })
  m.start()
  const delays = []
  await tm.advance(0)
  for (let i = 0; i < 11; i++) {
    const [d] = tm.pending()
    delays.push(d)
    await tm.advance(d)
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_840_000, 7_680_000, 15_360_000, SIX_H, SIX_H])
  mode = 'ok'
  await tm.advance(tm.pending()[0])
  assert.deepEqual(tm.pending(), [SIX_H])
  mode = 'fail'
  await tm.advance(SIX_H)
  assert.deepEqual(tm.pending(), [60_000], 'counter reset by the success')
  mode = 'boum'
  await tm.advance(60_000)
  assert.deepEqual([m.result('s#0').state, tm.pending()], ['unknown', [120_000]])
  m.stop()
})

test('tls: certificate read 3 days before expiry (crit) = successful read → normal interval, no short retry, and Refresh does not rerun it', async () => {
  const tm = fakeTimers()
  let runs = 0
  const m = createMonitor(cfgWith([{ type: 'tls', host: 'proxy.test' }]), { ...tm, random: () => 0, now: () => T, run: async () => { runs++; return CERT(3) } })
  m.start()
  await tm.advance(0)
  assert.deepEqual([m.result('s#0').state, m.result('s#0').tls.daysLeft, tm.pending()], ['crit', 3, [SIX_H]])
  await m.runAll()
  assert.equal(runs, 1)
  assert.deepEqual(tm.pending(), [SIX_H])
  m.stop()
})

test('Refresh: reruns the failed tls probes (and the other probes), never a tls with a certificate read nor a tls not yet run; no schedule added', async () => {
  const tm = fakeTimers()
  const ran = []
  const state = { 's#0': FAIL, 's#1': CERT(60), 's#3': CERT(90) }
  const m = createMonitor(cfgWith([{ type: 'tls', host: 'ko.test' }, { type: 'tls', host: 'ok.test' }, { type: 'http', url: 'http://192.0.2.10/' }, { type: 'tls', host: 'neuve.test' }]), {
    ...tm, random: () => 0, now: () => T, run: async c => { ran.push(c.id); return state[c.id] ?? { state: 'ok', code: 200 } },
  })
  // before any run: no tls has a result, only the http probe is rerun
  await m.runAll()
  assert.deepEqual([ran, tm.count()], [['s#2'], 0])
  m.start()
  await tm.advance(0)
  ran.length = 0
  const before = tm.pending().sort((a, b) => a - b)
  assert.deepEqual(before, [60_000, 60_000, SIX_H, SIX_H])
  await m.runAll()
  assert.deepEqual(ran.sort(), ['s#0', 's#2'], 'the failing tls and the http probe; not the tls whose certificate was read')
  assert.deepEqual(tm.pending().sort((a, b) => a - b), before, 'schedule unchanged')
  m.stop()
})

test('Refresh and counter: an off-cycle failure counts (the scheduled retry keeps its time, then doubles twice); an off-cycle success: the scheduled retry finds a certificate and goes back to 6 h', async () => {
  for (const [after, expected] of [[FAIL, 240_000], [CERT(60), SIX_H]]) {
    const tm = fakeTimers()
    const plan = [FAIL, after, after]
    let runs = 0
    const m = createMonitor(cfgWith([{ type: 'tls', host: 'proxy.test' }]), { ...tm, random: () => 0, now: () => T, run: async () => { runs++; return plan.shift() } })
    m.start()
    await tm.advance(0)
    await m.runAll()
    assert.deepEqual(tm.pending(), [60_000], 'Refresh reschedules nothing')
    await tm.advance(60_000)
    assert.deepEqual([runs, tm.pending()], [3, [expected]], JSON.stringify(after))
    m.stop()
  }
})

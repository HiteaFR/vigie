// Probe scheduler (lib/monitor.js), DUMMY probe and timers:
// no real probe, no waiting. Startup offset, interval per type or per check,
// published result (subscribers, fails/oks counters), probe error, out-of-cycle run, cap on
// simultaneous probes, stop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonitor, worst } from '../lib/monitor.js'
import { parseConfig } from '../lib/config.js'

const T = Date.parse('2026-10-28T10:00:00Z')
function cfgWith(checks, extra = {}) {
  const p = parseConfig({
    version: 2, title: 't', proxmox: [], gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    hosts: [{ id: 'h', name: 'h', kind: 'appliance', env: 'prod', ip: '192.0.2.10' }],
    services: [{ id: 's', name: 'S', group: 'g', host: 'h', checks }, ...(extra.services ?? [])],
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
// manual timers: fire() triggers the due deadlines, in order
function fakeTimers() {
  let clock = 0
  let seq = 0
  const pending = new Map()
  return {
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { at: clock + ms, ms, fn }); return id },
    clearTimer: id => pending.delete(id),
    pending: () => [...pending.values()].map(p => p.ms),
    count: () => pending.size,
    // advances up to clock + ms, deadline by deadline (a probe rescheduled during the advance
    // runs again if its new deadline falls before the end)
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

test('monitor: probes described (id, service, "accueil" label on the host IP), default interval by type, or that of the check', () => {
  const m = createMonitor(cfgWith([
    { type: 'http', url: 'http://192.0.2.10/' },
    { type: 'http', url: 'http://192.0.2.10/admin', interval: '30s' },
    { type: 'tcp', target: '192.0.2.10:22' },
    { type: 'tls', host: 'a.test', interval: '1h' },
    { type: 'tls', host: 'b.test' },
    { type: 'dns', server: '192.0.2.53', name: 'x.test', interval: '2m' },
  ], { services: [{ id: 'u', name: 'U', group: 'g', env: 'prod', url: 'http://198.51.100.1/' }, { id: 'v', name: 'V', group: 'g', env: 'prod', url: 'http://198.51.100.2/', checks: [] }] }))
  assert.deepEqual(m.checks.map(c => [c.id, c.serviceId, c.label, c.intervalSec]), [
    ['s#0', 's', 'accueil', 60], ['s#1', 's', '/admin', 30], ['s#2', 's', 'TCP 22', 60],
    ['s#3', 's', 'certificat', 3600], ['s#4', 's', 'certificat', 21600], ['s#5', 's', 'DNS x.test', 120],
    // without "checks": http probe on the URL; "checks: []": none
    ['u#0', 'u', '198.51.100.1', 60],
  ])
  assert.equal(m.completed, 0)
})

test('monitor start: first run offset (random × min(interval, 10 s)), then one run per interval; result published to subscribers', async () => {
  const tm = fakeTimers()
  const ran = []
  const m = createMonitor(cfgWith([{ type: 'http', url: 'http://192.0.2.10/' }, { type: 'tls', host: 'a.test', interval: '5s' }]), {
    ...tm, random: () => 0.5, now: () => T, run: async c => { ran.push(c.id); return { state: 'ok', latencyMs: 3, code: 200 } },
  })
  const seen = []
  m.onResult((c, r) => seen.push([c.id, r.state, r.oks]))
  m.start()
  assert.deepEqual(tm.pending().sort((a, b) => a - b), [2500, 5000])
  await tm.advance(2500)
  assert.deepEqual(ran, ['s#1'])
  await tm.advance(2500)
  assert.deepEqual(ran, ['s#1', 's#0'])
  assert.deepEqual(m.result('s#0'), { state: 'ok', latencyMs: 3, code: 200, checkedAt: new Date(T).toISOString(), fails: 0, oks: 1 })
  await tm.advance(5000) // s#1: 2.5 s + 5 s
  await tm.advance(55_000) // s#0: 5 s + 60 s
  // s#0: 5 s and 65 s; s#1: 2.5 s then every 5 s up to 62.5 s
  assert.equal(ran.filter(x => x === 's#0').length, 2)
  assert.equal(ran.filter(x => x === 's#1').length, 13)
  assert.deepEqual(seen.slice(0, 2), [['s#1', 'ok', 1], ['s#0', 'ok', 1]])
  assert.equal(m.completed, 2)
  m.stop()
})

test('monitor counters: consecutive failures (fails), consecutive successes (oks), reset; probe error → unknown, counters kept', async () => {
  const tm = fakeTimers()
  const plan = ['crit', 'crit', 'ok', 'boum', 'crit']
  const m = createMonitor(cfgWith([{ type: 'tcp', target: '192.0.2.10:22' }]), {
    ...tm, random: () => 0, now: () => T,
    run: async () => {
      const s = plan.shift()
      if (s === 'boum') throw new Error('sonde cassée')
      return { state: s, code: s === 'ok' ? 'tcp' : 0 }
    },
  })
  const out = []
  m.onResult((c, r) => out.push([r.state, r.fails, r.oks, r.error ?? null]))
  m.onResult(() => { throw new Error('abonné fautif') }) // stops neither the others nor the schedule
  const errors = []
  const orig = console.error
  console.error = e => errors.push(String(e?.message ?? e))
  try {
    m.start()
    await tm.advance(0)
    for (let i = 0; i < 4; i++) await tm.advance(60_000)
  } finally {
    console.error = orig
  }
  assert.deepEqual(out, [['crit', 1, 0, null], ['crit', 2, 0, null], ['ok', 0, 1, null], ['unknown', 0, 1, 'sonde cassée'], ['crit', 1, 0, null]])
  assert.equal(errors.filter(e => e === 'abonné fautif').length, 5)
  m.stop()
})

test('monitor runAll: one out-of-cycle run of all probes except tls, without adding to the schedule', async () => {
  const tm = fakeTimers()
  const ran = []
  const m = createMonitor(cfgWith([{ type: 'http', url: 'http://192.0.2.10/' }, { type: 'tls', host: 'a.test' }, { type: 'dns', server: '192.0.2.53', name: 'x.test' }]), {
    ...tm, run: async c => { ran.push(c.type); return { state: 'ok' } },
  })
  await m.runAll()
  assert.deepEqual(ran.sort(), ['dns', 'http'])
  assert.equal(tm.count(), 0)
  assert.equal(m.completed, 2)
})

test('monitor cap: at most 8 probes in flight, the next ones wait their turn', async () => {
  const checks = Array.from({ length: 12 }, (_, i) => ({ type: 'tcp', target: `192.0.2.10:${1000 + i}` }))
  let live = 0
  let peak = 0
  const gates = []
  const m = createMonitor(cfgWith(checks), {
    run: () => new Promise(r => {
      live++
      peak = Math.max(peak, live)
      gates.push(() => { live--; r({ state: 'ok' }) })
    }),
  })
  const all = m.runAll()
  await flush()
  assert.equal(live, 8)
  while (gates.length) {
    gates.shift()()
    await flush()
  }
  await all
  assert.equal(peak, 8)
  assert.equal(m.completed, 12)
})

test('monitor stop: no more runs, timers cancelled, even for a run in progress', async () => {
  const tm = fakeTimers()
  let release
  let runs = 0
  const m = createMonitor(cfgWith([{ type: 'http', url: 'http://192.0.2.10/' }, { type: 'tcp', target: '192.0.2.10:22' }]), {
    ...tm, random: () => 0,
    run: c => { runs++; return c.type === 'tcp' ? new Promise(r => { release = () => r({ state: 'ok' }) }) : Promise.resolve({ state: 'ok' }) },
  })
  m.start()
  await tm.advance(0)
  assert.equal(runs, 2)
  assert.equal(tm.count(), 1, 'http rescheduled, tcp in progress')
  m.stop()
  assert.equal(tm.count(), 0)
  release()
  await flush()
  assert.equal(tm.count(), 0, 'the running pass does not reschedule itself')
  await tm.advance(3600_000)
  assert.equal(runs, 2)
})

test('worst: crit > warn > unknown > ok; empty list → ok', () => {
  assert.equal(worst([]), 'ok')
  assert.equal(worst(['ok', 'unknown']), 'unknown')
  assert.equal(worst(['unknown', 'warn', 'ok']), 'warn')
  assert.equal(worst(['warn', 'crit', 'unknown']), 'crit')
})

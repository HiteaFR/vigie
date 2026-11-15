// Network module: MAC flooding. 500 random MACs + 1 persistent intruder → 1 net_new_flood
// + 1 net_new, at most 3 Telegram sends; a single incident per episode; list capped at
// 500; at most 5 persistent per hour; DHCP leases; performance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetwork } from '../lib/network/index.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'
import { createAudit } from '../lib/auth.js'
import { mergeSightings, emptyFlood, tieOf, floodTieSalt } from '../lib/network/merge.js'
import { prodConfig, prodLikeStore, prodSources, fakeTelegram, MIN, quiet } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const hex = n => n.toString(16).padStart(2, '0')
const rnd = (cycle, i) => `0a:${hex(cycle)}:${hex(i >> 8)}:${hex(i & 255)}:00:01`

test('flood: 500 random MACs per reading + 1 persistent intruder → 1 flood alert, 1 new device, ≤ 3 messages', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T })
  store.kv.set('network.alertsSince', String(T - 3600_000))
  let cycle = 0
  const src = prodSources(cfg, {
    // each reading: 500 new disposable MACs (never seen again), plus the intruder, always there
    extraPihole: () => [...Array.from({ length: 500 }, (_, i) => ({ mac: rnd(cycle, i), ip: `192.0.2.${170 + (i % 20)}`, name: null })),
      { mac: '00:00:5e:00:53:aa', ip: '192.0.2.199', name: 'Intrus' }],
  })
  const telegram = fakeTelegram()
  const tz = createClock('Europe/Paris')
  const notifier = createNotifier({ cfg, store, clock: tz, telegram, formatter: createFormatter({ dashboardUrl: 'http://dash.test', clock: tz }), buttons: true, log: quiet })
  // tie-break salt fixed: deterministic test (the worst salt has its own test, below)
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => clock.t, log: quiet, floodSalt: 'sel-de-test' })
  const engine = createEngine({ cfg, store, rules: createRules(cfg, { checks: [], result: () => null }, null, null, network), notifier, clock: tz, startedAt: T - 3600_000 })
  for (; cycle < 25; cycle++) {
    clock.t += MIN
    src.setClock(clock.t)
    await network.runAll()
    engine.evaluate({}, clock.t)
    await notifier.flush(clock.t + 60_000)
  }
  const v = network.view()
  // the first reading creates 20 MACs (cap), then the episode refuses everything except the persistent intruder
  assert.ok(v.sources.merge && /refusées/.test(v.sources.merge.error))
  const intrus = v.devices.find(d => d.mac === '00:00:5e:00:53:aa')
  // failure diagnostics: sources, intruder entry in the refused list, salt
  assert.ok(intrus, `intruder missing: ${JSON.stringify({ sources: v.sources, flood: network.floodState('00:00:5e:00:53:aa') })}`)
  assert.equal(intrus.state, 'new')
  const incidents = store.db.prepare("SELECT key FROM incidents WHERE rule LIKE 'net_%'").all().map(r => r.key)
  assert.equal(incidents.filter(k => k === 'net_new_flood:lan').length, 1) // a single incident for the episode
  assert.ok(incidents.includes(`net_new:${intrus.id}`))
  assert.ok(telegram.sent.length <= 3, `${telegram.sent.length} messages`)
  assert.ok(telegram.sent.every(m => m.text.length < 4096))
  assert.ok(telegram.sent.some(m => /Afflux d'appareils/.test(m.text)))
})

test('refused list capped at 500; persistent = present in 3 readings over 10 min; 5 per hour; a lease alone is not enough', () => {
  const cfg = prodConfig({ maxNewPerCycle: 2 })
  const state = { devices: new Map(), macs: new Map(), seen: new Map(), attrs: new Map(), addresses: new Map(), rules: [], flood: emptyFlood('sel-de-test') }
  const ph = (mac, i, t) => ({ mac, ip: `192.0.2.${100 + (i % 50)}`, source: 'pihole', ts: t, presence: true })
  // 600 MACs at once, beyond the cap: none created, the list keeps 500
  let m = mergeSightings(state, Array.from({ length: 600 }, (_, i) => ph(rnd(1, i), i, T)), { cfg, now: T })
  assert.equal(m.created, 0)
  assert.equal(m.flood.refused.size, 500)
  assert.ok(m.flood.episode)
  // 10 MACs from the list seen again, present at every reading: persistent at the 3rd reading (10 min), 5 per hour
  let flood = m.flood
  const kept = [...flood.refused.keys()].slice(0, 10)
  for (const dt of [5, 10]) {
    m = mergeSightings({ ...state, flood }, kept.map((mac, i) => ph(mac, i, T + dt * MIN)), { cfg, now: T + dt * MIN })
    flood = m.flood
  }
  assert.equal(m.created, 5)
  assert.equal(flood.persisted.length, 5)
  // an active DHCP lease, without any presence: never persistent (pool exhaustion)
  let f2 = { ...emptyFlood('sel'), episode: { since: T, lastOver: T } }
  const lease = t => ({ mac: '00:00:5e:00:53:bb', ip: '192.0.2.101', source: 'dhcp', ts: t, presence: false, leaseExpires: t + 3600_000 })
  for (let dt = 0; dt <= 30; dt += 5) {
    const r = mergeSightings({ ...state, flood: f2 }, [lease(T + dt * MIN)], { cfg, now: T + dt * MIN })
    assert.equal(r.created, 0)
    f2 = r.flood
  }
})

test('DHCP exhaustion (100 leases without presence) + 1 real intruder: intruder inventoried within ≤ 3 readings after 10 min, ≤ 3 messages in 24 h', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T })
  store.kv.set('network.alertsSince', String(T - 3600_000))
  let cycle = 0
  const src = prodSources(cfg, { extraPihole: () => (cycle >= 5 ? [{ mac: '00:00:5e:00:53:ab', ip: '192.0.2.160', name: 'Intrus' }] : []) })
  // the DHCP pool is exhausted by 100 disposable MACs: leases, no ARP presence
  const pihole = src.pihole.get
  src.pihole.get = async p => (p === '/api/dhcp/leases'
    ? { leases: Array.from({ length: 100 }, (_, i) => ({ expires: Math.floor((clock.t + 3600_000) / 1000), hwaddr: `0a:ee:00:00:${hex(i >> 8)}:${hex(i & 255)}`, ip: `192.0.2.${150 + (i % 40)}`, name: '*', clientid: '*' })) }
    : pihole(p))
  const telegram = fakeTelegram()
  const tz = createClock('Europe/Paris')
  const notifier = createNotifier({ cfg, store, clock: tz, telegram, formatter: createFormatter({ dashboardUrl: 'http://dash.test', clock: tz }), buttons: true, log: quiet })
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => clock.t, log: quiet })
  const engine = createEngine({ cfg, store, rules: createRules(cfg, { checks: [], result: () => null }, null, null, network), notifier, clock: tz, startedAt: T - 3600_000 })
  let intrusAt = null
  let alertAt = null
  for (; cycle < 288; cycle++) { // 24 h, one reading every 5 min
    clock.t += 5 * MIN
    src.setClock(clock.t)
    await network.runAll()
    engine.evaluate({}, clock.t)
    await notifier.flush(clock.t + 60_000)
    if (intrusAt == null && network.view().devices.some(d => d.mac === '00:00:5e:00:53:ab')) intrusAt = cycle
    if (alertAt == null && telegram.sent.some(m => /Nouvel appareil : Intrus/.test(m.text))) alertAt = cycle
  }
  // arrived at reading 5: alerted in less than 15 min (3 readings of 5 min)
  assert.ok(alertAt != null && (alertAt - 5) * 5 < 15, `alert at poll ${alertAt}`)
  // the intruder arrives at reading 5; present at readings 5, 6 and 7 → 10 min → inventoried at reading 7
  assert.ok(intrusAt != null && intrusAt <= 7, `intruder at poll ${intrusAt}`)
  assert.equal(network.view().counts.new, 1) // no disposable MAC inventoried
  assert.ok(telegram.sent.length <= 3, `${telegram.sent.length} messages`)
  assert.ok(telegram.sent.some(m => /Nouvel appareil : Intrus/.test(m.text)))
  assert.ok(telegram.sent.some(m => /Afflux d'appareils/.test(m.text)))
})

// SLOPE of the cost, measured in the same process, instead of an absolute 200 ms (unstable
// under load) or a time ratio (not sensitive enough). The reading is measured at 1,000
// records and 500 observations, then at 8,000 and 4,000 (bracketing 2,000 and 1,000):
// alternating measurements after a warm-up round, medians of 9 runs, log-log exponent
// log(t8000 / t1000) / log(8). Measured: 1.00 to 1.06 at rest, 0.98 to 1.10 with 6 suites in
// parallel; a moderate O(MAC × records) loop 1.39 to 1.48 at rest, 1.27 to 1.39 under load;
// a lost index (O(records × MAC) per record) ≈ 2. Threshold 1.18, halfway under load (a ratio
// of 8: a better estimated exponent, and the quadratic part more visible).
function floodBench(n, m) {
  const cfg = prodConfig({ maxNewPerCycle: 1000 })
  const devices = new Map()
  const macs = new Map()
  const attrs = new Map()
  for (let i = 1; i <= n; i++) {
    const mac = `0a:00:${hex(i >> 8)}:${hex(i & 255)}:00:02`
    devices.set(i, { id: i, state: 'known', review: 0, origin: 'scan', created_at: T - 86400_000, primary_mac: mac, last_ip: `192.0.2.${i % 250}`, disp_name: `appareil-${i % 300}` })
    macs.set(mac, { mac, device_id: i, grade: 'weak', random: 1, first_seen: T - 86400_000, last_seen: T - 86400_000, last_ip: `192.0.2.${i % 250}`, attach: null })
    attrs.set(i, [{ device_id: i, attr: 'name', source: 'dhcp', value: `appareil-${i % 300}`, rank: 6, seen_at: T - 86400_000 }])
  }
  const sightings = Array.from({ length: m }, (_, i) => ({ mac: i < m / 2 ? `0a:00:${hex(i >> 8)}:${hex(i & 255)}:00:02` : rnd(9, i), ip: `192.0.2.${i % 250}`, source: 'dhcp', ts: T, presence: false, name: `appareil-${i % 300}` }))
  const t0 = performance.now()
  const out = mergeSightings({ devices, macs, seen: new Map(), attrs, addresses: new Map(), rules: [], flood: emptyFlood() }, sightings, { cfg, now: T })
  return { ms: performance.now() - t0, out }
}
const PERF_SLOPE_MAX = 1.18
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

test('performance: reading from 1,000 to 8,000 records (500 to 4,000 observations), linear cost (log-log slope ≤ 1.18, medians of 9 runs)', t => {
  floodBench(1000, 500)
  const full = floodBench(8000, 4000)
  assert.equal(full.out.stats.sightings, 4000, 'full poll') // the measured work is really done
  const small = []
  const big = []
  for (let i = 0; i < 9; i++) {
    small.push(floodBench(1000, 500).ms)
    big.push(floodBench(8000, 4000).ms)
  }
  const slope = Math.log(median(big) / median(small)) / Math.log(8)
  t.diagnostic(`medians: ${median(small).toFixed(1)} ms (1,000 records) and ${median(big).toFixed(1)} ms (8,000); slope ${slope.toFixed(2)}`)
  assert.ok(slope <= PERF_SLOPE_MAX, `slope ${slope.toFixed(2)} > ${PERF_SLOPE_MAX}: more than linear cost`)
})

// network-flood flakiness (a CI run): with a single salt for the whole process, an intruder
// with the highest hash, tied with the disposable MACs at every reading, was evicted every
// time and never inventoried. The tie-break is re-salted at every reading (floodTieSalt).
const INTRUS = '00:00:5e:00:53:aa'
const randoms = cycle => Array.from({ length: 500 }, (_, i) => rnd(cycle, i))
// salt drawn at random, taken from the analysis of that CI run: with the old tie-break (salt
// alone, the same at every reading), the intruder has a hash of 0.999998 and drops out at
// every reading; it was never inventoried (checked: making floodTieSalt constant fails this test)
const BAD_SALT = 'd9629b525af19e97'

test('flood, salt that made the intruder lose at every reading: the intruder is inventoried (tie-break re-salted at every reading)', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T })
  store.kv.set('network.alertsSince', String(T - 3600_000))
  let cycle = 0
  const src = prodSources(cfg, { extraPihole: () => [...randoms(cycle).map((mac, i) => ({ mac, ip: `192.0.2.${170 + (i % 20)}`, name: null })), { mac: INTRUS, ip: '192.0.2.199', name: 'Intrus' }] })
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => clock.t, log: quiet, floodSalt: BAD_SALT })
  for (; cycle < 25; cycle++) {
    clock.t += MIN
    src.setClock(clock.t)
    await network.runAll()
  }
  const v = network.view()
  const intrus = v.devices.find(d => d.mac === INTRUS)
  assert.ok(intrus, `intruder inventoried; diagnosis: ${JSON.stringify({ sources: v.sources, flood: network.floodState(INTRUS) })}`)
  assert.equal(intrus.state, 'new')
})

test('re-salted tie-break: the same salt gives different orders from one reading to the next; without a given salt, a random salt; floodState diagnostics (salt, list, entry)', async () => {
  const macs = randoms(1)
  const order = t => [...macs].sort((a, b) => tieOf(floodTieSalt('s', t), a) - tieOf(floodTieSalt('s', t), b)).slice(0, 5)
  assert.notDeepEqual(order(T), order(T + MIN))
  assert.notEqual(emptyFlood().salt, emptyFlood().salt)
  assert.equal(emptyFlood('fixe').salt, 'fixe')
  const cfg = prodConfig()
  const { store } = prodLikeStore({ T })
  const network = createNetwork({ cfg, store, ...prodSources(cfg), audit: createAudit(store), now: () => T, log: quiet, floodSalt: 'diag' })
  assert.deepEqual(network.floodState('00:00:5E:00:53:AA'), { salt: 'diag', episode: null, refused: 0, entry: null })
})

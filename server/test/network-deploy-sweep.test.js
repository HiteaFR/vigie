// REQUIREMENT: no wave of "offline" nor net_down at deployment or at the first sweep.
// Database in the production state (42 records, 5 of them to review; no archived record
// any more, see network-purge-legacy; alert_down = 0; no session), real engine, notifier and
// fake Telegram, simulated ARP probe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { r3Bench, arpProbe, FIXTURE_HOSTS, MIN } from './network-fixture.js'

const T = Date.parse('2026-10-21T08:00:00Z') // daytime: a warning would go out right away
const net = engine => engine.active().filter(a => a.rule.startsWith('net_') || a.key.startsWith('source_error:network/'))
const signal = (b, key) => b.network.signals(b.clock.t).find(s => s.key === key)

test('initial state matches production', () => {
  const b = r3Bench({ T })
  const row = b.store.db.prepare(`SELECT COUNT(*) n, SUM(state = 'known') known, SUM(state = 'archived') archived, SUM(review) review,
    SUM(alert_down) ad, SUM(online IS NOT NULL) onl, SUM(profile IS NOT NULL) prof, SUM(expected_ip IS NOT NULL) eip FROM net_devices`).get()
  assert.deepEqual({ ...row }, { n: 42, known: 42, archived: 0, review: 5, ad: 0, onl: 0, prof: 0, eip: 0 }) // no archived record any more
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_sessions').get().n, 0)
  assert.equal(b.store.kv.get('network.presenceSince'), null)
})

test('deployment WITHOUT an arp file (net-scan not installed): nothing changes', async () => {
  const b = r3Bench({ T })
  await b.run(30, null)
  assert.equal(b.network.view().presence, 'passive')
  assert.equal(b.store.kv.get('network.presenceSince'), null)
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_devices WHERE online IS NOT NULL').get().n, 0)
  assert.equal(signal(b, 'source_error:network/arp').cond, null)
  assert.ok(b.network.signals(b.clock.t).filter(s => s.rule === 'net_down').every(s => s.cond === false))
  assert.equal(b.network.summary().sourcesOk, true) // a probe not yet installed is not a failure
  assert.deepEqual([b.outbox(), b.telegram.sent.length, net(b.engine).length], [0, 0, 0])
})

test('first file: active presence right away; absent devices of the 3 profiles at 0 once their delay is over; no message; restarts', async () => {
  const probe = arpProbe()
  const b = r3Bench({ T, probe })
  const live = FIXTURE_HOSTS
  const fixedGone = FIXTURE_HOSTS[19] // device from the config: fixed profile (5 min)
  const normalGone = live.find(h => /poste-11/.test(b.devByMac(h.mac).disp_name)) // normal (10 min)
  const sleepyGone = live.find(h => /Telephone-1/.test(b.devByMac(h.mac).disp_name)) // set to sleepy (45 min)
  b.store.db.prepare("UPDATE net_devices SET profile = 'sleepy' WHERE id = ?").run(b.devByMac(sleepyGone.mac).id)
  const present = live.filter(h => ![fixedGone, normalGone, sleepyGone].includes(h))
  const online = h => b.devByMac(h.mac).online
  await b.step(2 * MIN, present)
  const since = Number(b.store.kv.get('network.presenceSince'))
  assert.equal(since, b.clock.t)
  assert.equal(b.network.view().presence, 'arp') // no "observing" mode
  assert.equal(b.network.summary().presence, 'arp')
  assert.equal(online(present[0]), 1)
  // fixed: unknown at 4 min, offline at 8 min (5 min and 3 sweeps)
  await b.run(4, present)
  assert.deepEqual([online(fixedGone), online(normalGone), online(sleepyGone)], [null, null, null])
  await b.run(4, present)
  assert.deepEqual([online(fixedGone), online(normalGone), online(sleepyGone)], [0, null, null])
  // restart during the bootstrap (first 3 sweeps done, but not the delays)
  const b2 = r3Bench({ T: b.clock.t, store: b.store, probe })
  await b2.run(4, present) // 12 min: normal at 0
  assert.deepEqual([b2.devByMac(fixedGone.mac).online, b2.devByMac(normalGone.mac).online, b2.devByMac(sleepyGone.mac).online], [0, 0, null])
  await b2.run(30, present) // 42 min: sleepy still unknown
  assert.equal(b2.devByMac(sleepyGone.mac).online, null)
  await b2.run(6, present) // 48 min: sleepy at 0
  assert.equal(b2.devByMac(sleepyGone.mac).online, 0)
  // null → 0 opened or closed no session; no per-device digest line
  for (const h of [fixedGone, normalGone, sleepyGone]) assert.deepEqual(b2.sessions(b2.devByMac(h.mac).id), [])
  assert.equal(b2.store.db.prepare('SELECT COUNT(*) n FROM net_sessions WHERE end IS NOT NULL').get().n, 0)
  const digest = b2.digest(false)
  for (const h of [fixedGone, normalGone, sleepyGone]) assert.ok(!digest.includes(b2.devByMac(h.mac).disp_name), 'no line per device')
  // restart afterwards: nothing flips, presenceSince unchanged
  const b3 = r3Bench({ T: b2.clock.t, store: b.store, probe })
  await b3.run(20, present)
  assert.equal(Number(b3.store.kv.get('network.presenceSince')), since)
  for (const x of [b, b2, b3]) assert.deepEqual([x.outbox(), x.telegram.sent.length, net(x.engine).length], [0, 0, 0])
})

test('alert_down = 1: present → nothing; never seen → no alert; seen then absent → one alert, then recovery notified', async () => {
  const probe = arpProbe()
  const b = r3Bench({ T, probe })
  const [stays, never, leaves] = [FIXTURE_HOSTS[16], FIXTURE_HOSTS[17], FIXTURE_HOSTS[18]] // devices from the config (fixed profile, 5 min)
  const id = h => b.devByMac(h.mac).id
  b.store.db.exec(`UPDATE net_devices SET alert_down = 1 WHERE id IN (${[id(stays), id(never), id(leaves)].join(',')})`)
  const all = FIXTURE_HOSTS.filter(h => h !== never)
  await b.run(20, all) // "never" goes to 0 without an alert (fixed: 5 min since the 1st sweep)
  assert.equal(b.dev(id(never)).online, 0)
  assert.deepEqual([b.telegram.sent.length, b.firing('net_down').length], [0, 0])
  // "leaves" stops answering: alert after its delay (fixed 5 min and 3 sweeps)
  const gone = all.filter(h => h !== leaves)
  await b.run(4, gone)
  assert.equal(b.firing('net_down').length, 0)
  await b.run(6, gone)
  assert.deepEqual(b.firing('net_down').map(a => a.key), [`net_down:${id(leaves)}`])
  assert.equal(b.telegram.sent.length, 1)
  assert.match(b.telegram.sent[0].text, /hors ligne/)
  assert.doesNotMatch(b.telegram.sent[0].text, /192\.0\.2\./) // IPs masked
  // return: recovery notified
  await b.run(4, all)
  assert.equal(b.firing('net_down').length, 0)
  assert.equal(b.telegram.sent.length, 2)
  // the session was closed on the last reply, not at the detection time
  const closed = b.sessions(id(leaves)).find(s => s.end != null)
  assert.ok(closed && b.dev(id(leaves)).online === 1)
})

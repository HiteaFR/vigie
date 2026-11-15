// Network module: passive freshness (at the boundaries) and reliable presence: hysteresis
// per profile, required missed sweeps, silent probe, delay for a never-seen device,
// sessions dated on the last reply, aggregate (taken from code set aside earlier, rewired
// on last_present and on the previous sweep).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshnessOf, presenceOf, graceMs, sessionOps, rollupOps, cellOf, absentSince } from '../lib/network/presence.js'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const MIN = 60_000
const P = { fixedMin: 5, normalMin: 10, sleepyMin: 45, minMissedScans: 3 }
const DAY = 86400_000
const SINCE = NOW - 24 * 3600_000
// ago: last reply N min ago; previous sweep 2 min ago
const at = (ago, o = {}) => presenceOf({ lastPresent: ago == null ? null : NOW - ago * MIN, now: NOW, cfg: P, refRunsSince: 20, prevScanTs: NOW - 2 * MIN, presenceSince: SINCE, ...o })

test('freshnessOf: active under 15 min, then lease, then stale at 30 d', () => {
  const f = o => freshnessOf({ now: NOW, activeMin: 15, ...o }) // activeMin comes from the config (default 15)
  assert.equal(f({ lastSeen: NOW }), 'active')
  assert.equal(f({ lastSeen: NOW - 15 * MIN + 1 }), 'active')
  assert.equal(f({ lastSeen: NOW - 15 * MIN }), 'idle')
  assert.equal(f({ lastSeen: NOW - 2 * DAY }), 'idle')
  // active lease without a recent observation: "seen by DHCP"
  assert.equal(f({ lastSeen: NOW - 2 * DAY, lastDhcp: NOW + 1 }), 'dhcp')
  assert.equal(f({ lastSeen: null, lastDhcp: NOW + 3600_000 }), 'dhcp')
  assert.equal(f({ lastSeen: NOW - MIN, lastDhcp: NOW + 3600_000 }), 'active')
  // expired lease: no effect
  assert.equal(f({ lastSeen: NOW - 2 * DAY, lastDhcp: NOW }), 'idle')
  assert.equal(f({ lastSeen: NOW - 30 * DAY + 1 }), 'idle')
  assert.equal(f({ lastSeen: NOW - 30 * DAY }), 'stale')
  assert.equal(f({ lastSeen: null }), 'stale')
  // adjustable thresholds (network.activeMin)
  assert.equal(f({ lastSeen: NOW - 20 * MIN, activeMin: 30 }), 'active')
})

test('graceMs: 5/10/45 min; start of absence = max(last reply, presenceSince)', () => {
  assert.deepEqual(['fixed', 'normal', 'sleepy', 'inconnu'].map(p => graceMs(p, P) / MIN), [5, 10, 45, 10])
  assert.equal(absentSince(null, NOW), NOW)
  assert.equal(absentSince(NOW - MIN, NOW - 2 * MIN), NOW - MIN)
  assert.equal(absentSince(NOW - 60 * MIN, NOW - 2 * MIN), NOW - 2 * MIN)
})

test('goes up on a reply later than the previous sweep, goes down after the delay AND 3 sweeps', () => {
  assert.deepEqual(at(1, { prev: 0 }), { online: 1, idle: false, changed: true })
  // reply earlier than the previous sweep, within the delay: state kept, "inactive"
  assert.deepEqual(at(7, { prev: 1, profile: 'normal' }), { online: 1, idle: true, changed: false })
  assert.deepEqual(at(7, { prev: 1, profile: 'fixed' }), { online: 0, idle: false, changed: true })
  assert.equal(at(44, { prev: 1, profile: 'sleepy' }).online, 1)
  assert.equal(at(46, { prev: 1, profile: 'sleepy' }).online, 0)
  // long absence, but fewer than 3 successful sweeps since: no going down
  assert.equal(at(30, { prev: 1, refRunsSince: 2 }).online, 1)
  assert.equal(at(30, { prev: 1, refRunsSince: 3 }).online, 0)
  // never seen, delay elapsed since presenceSince: offline
  assert.deepEqual(at(null, { prev: null }), { online: 0, idle: false, changed: true })
})

test('probe stopped for 20 min (refStale): nobody moves', () => {
  assert.deepEqual(at(25, { prev: 1, refStale: true }), { online: 1, idle: true, changed: false })
  assert.deepEqual(at(25, { prev: null, refStale: true }), { online: null, idle: false, changed: false })
  assert.deepEqual(at(0.5, { prev: 0, refStale: true }), { online: 0, idle: false, changed: false })
  // timer stopped for 20 min then resumed: no sweep in between → no going down on return
  assert.equal(at(22, { prev: 1, refRunsSince: 1 }).online, 1)
})

test('never seen by the probe: profile delay counted from presenceSince, for each profile', () => {
  for (const [profile, min] of [['fixed', 5], ['normal', 10], ['sleepy', 45]]) {
    // first sweep exactly "min" minutes ago: still unknown; one more minute: offline
    const runs = Math.ceil(min / 2) // 2-min sweeps since presenceSince
    const before = presenceOf({ lastPresent: null, presenceSince: NOW - min * MIN, profile, refRunsSince: runs, prev: null, now: NOW, cfg: P, prevScanTs: NOW - 2 * MIN })
    const after = presenceOf({ lastPresent: null, presenceSince: NOW - (min + 1) * MIN, profile, refRunsSince: runs, prev: null, now: NOW, cfg: P, prevScanTs: NOW - 2 * MIN })
    assert.deepEqual([before.online, after.online], [null, 0], profile)
  }
  // delay elapsed but fewer than 3 sweeps since presenceSince: still unknown
  assert.equal(presenceOf({ lastPresent: null, presenceSince: NOW - 30 * MIN, profile: 'normal', refRunsSince: 2, prev: null, now: NOW, cfg: P }).online, null)
  // seen before the first sweep (neighbors from before the probe): the delay also starts at presenceSince
  assert.equal(presenceOf({ lastPresent: NOW - 600 * MIN, presenceSince: NOW - 5 * MIN, profile: 'normal', refRunsSince: 3, prev: null, now: NOW, cfg: P, prevScanTs: NOW - 2 * MIN }).online, null)
  assert.equal(at(1, { prev: null }).online, 1)
})

test('sessions: opening, closing dated on lastPresent, reopening, null → 0 without a session', () => {
  const lastPresent = NOW - 15 * MIN
  assert.deepEqual(sessionOps({ device: 1, session: null, lastPresent: NOW, online: 1, ip: '192.0.2.5', now: NOW }),
    [{ op: 'openSession', device: 1, start: NOW, ip: '192.0.2.5' }])
  const open = { id: 9, start: NOW - 60 * MIN, end: null }
  assert.deepEqual(sessionOps({ device: 1, session: open, lastPresent: NOW, online: 1, now: NOW }), [])
  assert.deepEqual(sessionOps({ device: 1, session: open, lastPresent, online: 0, now: NOW }), [{ op: 'closeSession', id: 9, device: 1, end: lastPresent }])
  const closed = { id: 9, start: NOW - 60 * MIN, end: NOW - 4 * MIN }
  assert.deepEqual(sessionOps({ device: 1, session: closed, lastPresent: NOW, online: 1, now: NOW, graceMs: 10 * MIN }), [{ op: 'reopenSession', id: 9, device: 1 }])
  assert.deepEqual(sessionOps({ device: 1, session: { ...closed, end: NOW - 30 * MIN }, lastPresent: NOW, online: 1, now: NOW, graceMs: 10 * MIN }),
    [{ op: 'openSession', device: 1, start: NOW, ip: null }])
  assert.deepEqual(sessionOps({ device: 1, session: null, lastPresent: null, online: 0, now: NOW }), [])
  assert.deepEqual(sessionOps({ device: 1, session: open, lastPresent, online: null, now: NOW }), [])
})

test('hourly aggregate (known states only) and band cells', () => {
  assert.deepEqual(rollupOps([{ id: 1, online: 1 }, { id: 2, online: 0 }, { id: 3, online: null }], NOW + 25 * MIN), [
    { op: 'rollup', device: 1, hour: NOW, seen: 1 },
    { op: 'rollup', device: 2, hour: NOW, seen: 0 },
  ])
  assert.deepEqual([cellOf(0, 0), cellOf(30, 30), cellOf(30, 12), cellOf(30, 0)], ['-', 'o', 'w', 'c'])
})

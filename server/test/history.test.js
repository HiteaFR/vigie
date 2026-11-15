// Probe history (lib/history.js), temporary database and fake monitor:
// grouped write (raw and hourly aggregate), 24 h and N-day bands, one-minute cache, series,
// purge (8 d and 400 d) and date of the oldest aggregate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHistory } from '../lib/history.js'
import { tmpStore } from './tmpdir.js'

const HOUR = 3600_000
const DAY = 86400_000
const HALF = 30 * 60_000
// now: 10:05 UTC, 30 min slot aligned on 10:00
const NOW = Date.parse('2026-10-28T10:05:00Z')

function bench(t) {
  const store = tmpStore('dash-history-', t)
  let emit
  const h = createHistory(store, { onResult: fn => { emit = fn } })
  const put = (id, ts, state, latencyMs = null, extra = {}) => emit({ id }, { checkedAt: new Date(ts).toISOString(), state, latencyMs, ...extra })
  const count = (table = 'check_results') => store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n
  return { h, put, count, store }
}

test('history flush: nothing written before flush; raw and hourly aggregate in the same pass; latency counted without failures', t => {
  const b = bench(t)
  b.h.flush() // empty queue: no effect
  b.put('a#0', NOW - 10 * 60_000, 'ok', 100, { code: 200 })
  b.put('a#0', NOW - 9 * 60_000, 'warn', 300)
  b.put('a#0', NOW - 8 * 60_000, 'crit', 5000, { code: 0, error: 'timeout' })
  b.put('a#0', NOW - 7 * 60_000, 'unknown', null, { error: 'sonde cassée' })
  assert.equal(b.count(), 0)
  b.h.flush()
  assert.equal(b.count(), 4)
  const raw = b.store.db.prepare('SELECT state, latency_ms, code, error FROM check_results ORDER BY ts').all()
  assert.deepEqual(raw.map(r => [r.state, r.latency_ms, r.code, r.error]), [['ok', 100, '200', null], ['warn', 300, null, null], ['crit', 5000, '0', 'timeout'], ['unknown', null, null, 'sonde cassée']])
  const roll = b.store.db.prepare('SELECT * FROM check_rollup_1h').all()
  assert.equal(roll.length, 1)
  assert.deepEqual([roll[0].hour, roll[0].n, roll[0].n_fail, roll[0].n_warn, roll[0].lat_sum, roll[0].lat_n, roll[0].lat_max], [Date.parse('2026-10-28T09:00:00Z'), 4, 1, 1, 400, 2, 300])
  b.h.flush()
  assert.equal(b.count(), 4, 'a second flush writes nothing more')
})

test('history bands 24 h: 48 slots of 30 min, "-" empty, "o" good, "w" degraded or partial failure, "c" all failed; uptime and samples', t => {
  const b = bench(t)
  const cur = Math.floor(NOW / HALF) * HALF
  b.put('a#0', cur + 60_000, 'ok', 10) // slot 47: o
  b.put('a#0', cur - HALF + 60_000, 'crit') // slot 46: c
  b.put('a#0', cur - 2 * HALF + 60_000, 'ok', 10)
  b.put('a#0', cur - 2 * HALF + 120_000, 'crit') // slot 45: w
  b.put('a#0', cur - 3 * HALF + 60_000, 'warn', 10) // slot 44: w
  b.put('a#0', cur - 48 * HALF, 'crit') // before the window: ignored
  b.put('b#0', cur - 47 * HALF + 1, 'ok', 5) // slot 0
  b.h.flush()
  const v = b.h.bands('24h', NOW)
  assert.deepEqual([v.range, v.size, v.count, v.start], ['24h', HALF, 48, cur - 47 * HALF])
  assert.equal(v.checks['a#0'].band, '-'.repeat(44) + 'wwco')
  assert.deepEqual([v.checks['a#0'].uptime, v.checks['a#0'].samples], [60, 5])
  assert.equal(v.checks['b#0'].band, 'o' + '-'.repeat(47))
  assert.deepEqual([v.checks['b#0'].uptime, v.checks['b#0'].samples], [100, 1])
})

test('history bands: one-minute cache per range, then recomputation', t => {
  const b = bench(t)
  b.put('a#0', NOW - 60_000, 'ok', 1)
  b.h.flush()
  const first = b.h.bands('24h', NOW)
  b.put('a#0', NOW - 30_000, 'crit')
  b.h.flush()
  assert.equal(b.h.bands('24h', NOW + 59_999), first, 'same object, cached')
  const again = b.h.bands('24h', NOW + 60_000)
  assert.notEqual(again, first)
  assert.equal(again.checks['a#0'].samples, 2)
  // another range does not use this cache
  assert.equal(b.h.bands('7d', NOW + 60_000).range, '7d')
})

test('history bands N days: one-day slots (UTC) read from the hourly aggregate; 7, 30 (default) and 90 d', t => {
  const b = bench(t)
  const today = Math.floor(NOW / DAY) * DAY
  b.put('a#0', today + HOUR, 'ok', 10)
  b.put('a#0', today - DAY + HOUR, 'crit')
  b.put('a#0', today - 2 * DAY + HOUR, 'warn', 10)
  b.put('a#0', today - 10 * DAY, 'ok', 10) // outside 7 d, within 30 d
  b.h.flush()
  const w = b.h.bands('7d', NOW)
  assert.deepEqual([w.count, w.size, w.start], [7, DAY, today - 6 * DAY])
  assert.equal(w.checks['a#0'].band, '----wco')
  assert.equal(b.h.bands('30d', NOW).checks['a#0'].band, '-'.repeat(19) + 'o---' + '----wco') // 10 d ago: slot 19
  assert.equal(b.h.bands('autre', NOW).count, 30)
  assert.equal(b.h.bands('90d', NOW).count, 90)
})

test('history series 24 h: 10 min slots (online share, mean and max latency without failures), last 5 failures from newest to oldest', t => {
  const b = bench(t)
  const base = Math.floor((NOW - 2 * HOUR) / 600_000) * 600_000
  b.put('a#0', base + 1000, 'ok', 100)
  b.put('a#0', base + 2000, 'ok', 300)
  b.put('a#0', base + 3000, 'crit', null, { code: 0, error: 'e1' })
  b.put('a#0', base + 3000, 'crit', null, { code: 0, error: 'hors fenêtre' }) // same slot
  for (let i = 2; i <= 6; i++) b.put('a#0', base + i * 600_000, 'crit', null, { code: 503, error: `e${i}` })
  b.put('a#0', NOW - 25 * HOUR, 'ok', 1) // more than 24 h: excluded
  b.h.flush()
  const s = b.h.series('a#0', '24h', NOW)
  assert.deepEqual(s.points[0], { t: base, up: 0.5, lat: 200, latMax: 300 })
  assert.deepEqual(s.points.slice(1).map(p => [p.t - base, p.up, p.lat]), [1, 2, 3, 4, 5].map(i => [(i + 1) * 600_000, 0, null]))
  assert.deepEqual(s.failures.map(f => f.error), ['e6', 'e5', 'e4', 'e3', 'e2'])
  assert.deepEqual(s.failures[0], { t: base + 6 * 600_000, code: '503', error: 'e6' })
  const week = b.h.series('a#0', '7d', NOW)
  assert.deepEqual(week.failures, [])
  assert.ok(week.points.every(p => Number.isFinite(p.t) && p.up >= 0 && p.up <= 1))
  assert.equal(week.points.length, 3)
})

test('history purge: raw beyond 8 d, aggregate beyond 400 d; since() = oldest aggregated hour', t => {
  const b = bench(t)
  assert.equal(b.h.since(), null)
  b.put('a#0', NOW - 9 * DAY, 'ok', 1)
  b.put('a#0', NOW - 7 * DAY, 'ok', 1)
  b.put('a#0', NOW - 401 * DAY, 'ok', 1)
  b.put('a#0', NOW - 399 * DAY, 'ok', 1)
  b.h.flush()
  assert.equal(b.h.since(), Math.floor((NOW - 401 * DAY) / HOUR) * HOUR)
  b.h.purge(NOW)
  assert.equal(b.count(), 1)
  assert.equal(b.count('check_rollup_1h'), 3)
  assert.equal(b.h.since(), Math.floor((NOW - 399 * DAY) / HOUR) * HOUR)
})

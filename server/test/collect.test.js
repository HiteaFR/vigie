// Alert collectors (lib/alerts/collect.js), DUMMY sources and manual timer:
// snapshot per source, data kept on error, each source at its own pace, immediate re-read
// (runAll) without rescheduling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from '../lib/alerts/collect.js'

const T = Date.parse('2026-10-28T10:00:00Z')
// core sources, then those of the gitea plugin (runners, gitea: module sources, extra)
const NAMES = ['cluster', 'backups', 'nodes', 'disks', 'runners', 'gitea']
function bench(impl = {}) {
  const calls = []
  let now = T
  const timers = []
  const src = name => async () => {
    calls.push(name)
    if (impl[name]) return impl[name]()
    return { source: name }
  }
  const sources = { cluster: src('cluster'), backups: src('backups'), nodes: src('nodes'), disks: src('disks') }
  const extra = [{ name: 'runners', periodSec: 60, fn: src('runners') }, { name: 'gitea', periodSec: 120, fn: src('gitea') }]
  const c = createCollector(sources, { setTimer: (fn, ms) => timers.push({ fn, ms }), random: () => 0.25, now: () => now, extra })
  return { c, calls, timers, tick: ms => { now += ms } }
}

test('collect: empty snapshot at first; start schedules each source between 1 and 5 s (here 2 s), then at its period', async () => {
  const b = bench()
  assert.deepEqual(b.c.snap, Object.fromEntries(NAMES.map(n => [n, null])))
  b.c.start()
  assert.deepEqual(b.timers.map(t => t.ms), Array(6).fill(2000))
  assert.equal(b.calls.length, 0)
  for (const t of b.timers.splice(0)) await t.fn()
  assert.deepEqual(b.calls, NAMES)
  assert.deepEqual(b.c.snap.gitea, { data: { source: 'gitea' }, at: T, error: null })
  // periods: cluster 60, backups 600, nodes 60, disks 1800, then runners 60 and gitea 120 (s)
  assert.deepEqual(b.timers.map(t => t.ms), [60, 600, 60, 1800, 60, 120].map(s => s * 1000))
})

test('collect: a failing source keeps its last data and sets the error; rescheduled anyway; recovered afterwards', async () => {
  let down = false
  const b = bench({ cluster: () => { if (down) throw new Error('PVE injoignable'); return { nodes: 3 } } })
  await b.c.runAll()
  assert.deepEqual(b.c.snap.cluster, { data: { nodes: 3 }, at: T, error: null })
  down = true
  b.tick(60_000)
  await b.c.runAll()
  assert.deepEqual(b.c.snap.cluster, { data: { nodes: 3 }, at: T + 60_000, error: 'PVE injoignable' })
  // first read failing: data null
  const fresh = bench({ disks: () => { throw new Error('SMART illisible') } })
  fresh.c.start()
  for (const t of fresh.timers.splice(0)) await t.fn()
  assert.deepEqual(fresh.c.snap.disks, { data: null, at: T, error: 'SMART illisible' })
  assert.equal(fresh.timers.length, 6, 'failed source rescheduled')
  down = false
  b.tick(1000)
  await b.c.runAll()
  assert.equal(b.c.snap.cluster.error, null)
})

test('collect runAll: all sources right away, no schedule added; allSettled result', async () => {
  const b = bench()
  const r = await b.c.runAll()
  assert.equal(r.length, 6)
  assert.ok(r.every(x => x.status === 'fulfilled'))
  assert.deepEqual(b.calls.sort(), [...NAMES].sort())
  assert.equal(b.timers.length, 0)
})

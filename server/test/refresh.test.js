// "Refresh" button (lib/refresh.js), FAKE dependencies and injected clock: a single
// run at a time, no more than one per minute, order of the steps, collected errors,
// optional network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRefresher } from '../lib/refresh.js'

const T = Date.parse('2026-10-28T10:00:00Z')
function bench({ fail = {}, network = true } = {}) {
  let now = T
  const order = []
  const gates = []
  const step = name => () => {
    order.push(name)
    if (fail[name]) return Promise.reject(new Error(`${name} en panne`))
    return new Promise(r => gates.push(r))
  }
  const errors = []
  const snap = { cluster: 'factice' }
  const deps = {
    agents: { refreshAll: step('agents') },
    monitor: { runAll: step('monitor') },
    widgets: { runAll: step('widgets') },
    collector: { runAll: step('collector'), snap },
    sources: { invalidate: () => order.push('invalidate') },
    updates: { refresh: () => { order.push('updates'); return fail.updates ? Promise.reject(new Error('versions illisibles')) : Promise.resolve() } },
    engine: { evaluate: s => order.push(s === snap ? 'evaluate(snap)' : 'evaluate(?)') },
    ...(network ? { network: { runAll: step('network') } } : {}),
    now: () => now,
    log: { error: m => errors.push(m) },
  }
  const r = createRefresher(deps)
  const open = async () => {
    while (gates.length) gates.shift()()
    await new Promise(res => setImmediate(res))
  }
  return { r, order, errors, open, tick: ms => { now += ms } }
}

test('refresh: one run, steps in parallel after invalidation, then versions and evaluation; "last" state', async () => {
  const b = bench()
  const run = b.r.run('admin (127.0.0.1)')
  assert.deepEqual([run.started, run.running], [true, true])
  assert.equal(b.r.status().running, true)
  assert.deepEqual(b.order, ['invalidate', 'agents', 'monitor', 'widgets', 'collector', 'network'])
  b.tick(1500)
  await b.open()
  const last = await run.done
  assert.deepEqual(b.order.slice(-2), ['updates', 'evaluate(snap)'])
  assert.deepEqual(last, { by: 'admin (127.0.0.1)', startedAt: T, finishedAt: T + 1500, errors: [] })
  assert.deepEqual(b.r.status(), { running: false, last })
})

test('refresh: a call during a run returns the same run (no second one); then a one-minute delay (cooldownSec rounded up)', async () => {
  const b = bench()
  const first = b.r.run('a')
  const second = b.r.run('b')
  assert.deepEqual([second.started, second.running, second.done], [false, true, first.done])
  await b.open()
  await first.done
  assert.equal(b.order.filter(x => x === 'invalidate').length, 1)
  b.tick(20_500)
  assert.deepEqual(b.r.run('c'), { started: false, running: false, cooldownSec: 40 })
  b.tick(39_499)
  assert.equal(b.r.run('c').cooldownSec, 1)
  b.tick(1)
  const again = b.r.run('c')
  assert.equal(again.started, true)
  await b.open()
  assert.equal((await again.done).by, 'c')
})

test('refresh: failed steps listed (the run goes to the end); failed versions only logged; without the network module', async () => {
  const b = bench({ fail: { agents: true, widgets: true, updates: true }, network: false })
  const run = b.r.run('bot')
  await b.open()
  const last = await run.done
  assert.deepEqual(last.errors, ['agents en panne', 'widgets en panne'])
  assert.deepEqual(b.errors, ['refresh: versions: versions illisibles'])
  assert.ok(!b.order.includes('network'))
  assert.equal(b.order.at(-1), 'evaluate(snap)')
})

// Protected shutdown (lib/shutdown.js). Steps in order, each one protected
// (exception, rejection, non-promise value), bounded together; finalizers always run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shutdown } from '../lib/shutdown.js'

const logger = () => {
  const lines = []
  return { lines, error: m => lines.push(String(m)) }
}

test('shutdown: steps in order (synchronous or not), then finalizers in order', { timeout: 30_000 }, async () => {
  const order = []
  const log = logger()
  await shutdown({
    steps: [['a', () => order.push('a')], ['b', async () => { await null; order.push('b') }], ['c', () => undefined]],
    finalize: [() => order.push('flush'), () => order.push('close')],
    log,
  })
  assert.deepEqual(order, ['a', 'b', 'flush', 'close'])
  assert.deepEqual(log.lines, [])
})

test('shutdown: a step that throws, rejects or returns undefined instead of a promise prevents neither the following ones nor the close; errors logged', { timeout: 30_000 }, async () => {
  const order = []
  const log = logger()
  await shutdown({
    steps: [
      ['bot', () => { throw new Error('bot cassé') }],
      ['réseau', () => Promise.reject(new Error('relevé interrompu'))],
      ['inerte', () => undefined.then(() => {})],
      ['sessions Pi-hole', () => order.push('pihole')],
    ],
    finalize: [() => order.push('flush'), () => { throw new Error('base déjà fermée') }, () => order.push('après')],
    log,
  })
  assert.deepEqual(order, ['pihole', 'flush', 'après'])
  assert.equal(log.lines.length, 3)
  assert.match(log.lines[0], /^shutdown: bot: bot cassé$/)
  assert.match(log.lines[1], /^shutdown: réseau: relevé interrompu$/)
  assert.match(log.lines[2], /^shutdown: inerte: Cannot read properties of undefined/)
})

test('shutdown: steps bounded together (injected delay); the close happens anyway; timer canceled otherwise', { timeout: 30_000 }, async () => {
  const order = []
  const log = logger()
  const timers = []
  const cleared = []
  const run = shutdown({
    steps: [['réseau', () => new Promise(() => {})], ['jamais', () => order.push('jamais')]],
    finalize: [() => order.push('close')],
    log, timeoutMs: 2000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: id => cleared.push(id),
  })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(order, [])
  assert.deepEqual(timers.map(t => t.ms), [2000])
  timers[0].fn()
  await run
  assert.deepEqual(order, ['close'])
  assert.deepEqual(log.lines, ['shutdown: steps not finished in 2000 ms'])
  // fast steps: the timer is canceled, nothing is logged
  const fast = { t: [], c: [] }
  await shutdown({ steps: [['a', () => {}]], log, setTimer: (fn, ms) => { fast.t.push(ms); return 7 }, clearTimer: id => fast.c.push(id) })
  assert.deepEqual([fast.t, fast.c], [[2000], [7]])
})

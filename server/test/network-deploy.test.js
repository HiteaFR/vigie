// ABSOLUTE REQUIREMENT: deployment sends NO notification for existing records. Temporary
// database in the production state (auditor's counts), real engine, real rules, real
// notifier and fake Telegram; 10 evaluations over 30 min.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetwork } from '../lib/network/index.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest } from '../lib/notify/digest.js'
import { createClock } from '../lib/clock.js'
import { createAudit } from '../lib/auth.js'
import { prodConfig, prodLikeStore, prodSources, fakeTelegram, MIN, quiet } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z') // daytime: a warning would go out right away
const monitor = { checks: [], result: () => null }

// a dashboard start: network module, then engine (order of index.js)
function boot(store, cfg, clock) {
  const src = prodSources(cfg)
  const telegram = fakeTelegram()
  const tz = createClock('Europe/Paris')
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock: tz })
  const notifier = createNotifier({ cfg, store, clock: tz, telegram, formatter, buttons: true, log: quiet })
  const calls = []
  const enqueue = notifier.enqueue
  notifier.enqueue = (kind, st, t, extra) => {
    calls.push(`${kind}:${st.key}`)
    return enqueue(kind, st, t, extra)
  }
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => clock.t, log: quiet })
  const alertsSinceAtBoot = store.kv.get('network.alertsSince')
  const engine = createEngine({ cfg, store, rules: createRules(cfg, monitor, null, null, network), notifier, clock: tz, startedAt: clock.t })
  const digest = mark => buildDigest({ cfg, engine, snap: {}, monitor, formatter, clock: tz, network, mark, now: clock.t })
  return { src, telegram, notifier, network, engine, calls, alertsSinceAtBoot, digest }
}

async function run30min(b, clock) {
  for (let i = 0; i < 10; i++) {
    clock.t += 3 * MIN
    b.src.setClock(clock.t)
    await b.network.runAll()
    b.engine.evaluate({}, clock.t)
    await b.notifier.flush(clock.t + 60_000)
  }
}

const outbox = store => store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n
const firingNet = engine => engine.active().filter(a => a.rule.startsWith('net_') || a.key.startsWith('source_error:network/'))

test('deployment on the production state: no notification', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T })
  assert.equal(store.kv.get('network.alertsSince'), null)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n, 42)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_macs').get().n, 43)
  const b = boot(store, cfg, clock)
  // lock 1: alertsSince set by createNetwork, before the engine is created
  assert.equal(b.alertsSinceAtBoot, String(T))
  await run30min(b, clock)
  assert.equal(outbox(store), 0)
  assert.deepEqual(b.calls, [])
  assert.equal(b.telegram.sent.length, 0)
  assert.deepEqual(firingNet(b.engine), [])
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM incidents WHERE rule LIKE 'net_%'").get().n, 0)
  assert.doesNotMatch(b.digest(true), /apparus avant/)
  // the 42 records are still there, none new (same MACs seen again)
  assert.equal(b.network.view().counts.total, 42)
  assert.equal(b.network.view().counts.new, 0)

  // restart: new module and new engine on the same database → still nothing
  const b2 = boot(store, cfg, clock)
  assert.equal(b2.alertsSinceAtBoot, String(T)) // never moved
  await run30min(b2, clock)
  assert.equal(outbox(store), 0)
  assert.deepEqual(b2.calls, [])
  assert.equal(b2.telegram.sent.length, 0)
})

test('deployment with 3 "new" devices born under the previous version: no message, a single digest line', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T, k: 3 })
  const b = boot(store, cfg, clock)
  await run30min(b, clock)
  assert.equal(outbox(store), 0)
  assert.deepEqual(b.calls, [])
  assert.equal(b.network.view().counts.new, 3) // still to validate in the UI
  const first = b.digest(true)
  assert.match(first, /apparus avant l'activation des alertes : Invite-R1-1, Invite-R1-2, Invite-R1-3/)
  // only once: nothing more at the next digest, even after a restart
  assert.doesNotMatch(b.digest(true), /apparus avant/)
  const b2 = boot(store, cfg, clock)
  await run30min(b2, clock)
  assert.doesNotMatch(b2.digest(true), /apparus avant/)
  assert.equal(outbox(store), 0)
})

test('after deployment, a real new device notifies (the lock does not block everything)', async () => {
  const cfg = prodConfig()
  const clock = { t: T }
  const { store } = prodLikeStore({ T })
  const b = boot(store, cfg, clock)
  await run30min(b, clock)
  // a guest phone appears after alertsSince, seen in two readings
  const src = b.src
  const pihole = src.pihole.get
  src.pihole.get = async p => {
    const r = await pihole(p)
    if (p.startsWith('/api/network')) r.devices.push({ id: 99, hwaddr: '06:00:00:00:54:01', interface: 'eth0', firstSeen: Math.floor(clock.t / 1000), lastQuery: 0, numQueries: 1, macVendor: '', ips: [{ ip: '192.0.2.160', name: 'Galaxy-Invite', lastSeen: Math.floor(clock.t / 1000), nameUpdated: 0 }] })
    return r
  }
  await run30min(b, clock)
  assert.deepEqual(b.calls.filter(c => c.startsWith('open:net_new')).length, 1)
  assert.equal(b.telegram.sent.length, 1)
  assert.match(b.telegram.sent[0].text, /Nouvel appareil : Galaxy-Invite/)
  assert.doesNotMatch(b.telegram.sent[0].text, /192\.0\.2\.160/) // IP masked (scrub)
  assert.match(JSON.stringify(b.telegram.sent[0].opts.replyMarkup), /"n:\d+"/)
})

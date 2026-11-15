// Network module: a hostile device name (chosen by any device on the LAN) goes through the
// Telegram formatter, the digest, /reseau and /appareil: escaped text, no injected tag, no
// control character, IPv4 masked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetwork } from '../lib/network/index.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createRules } from '../lib/alerts/rules.js'
import { createSilences } from '../lib/alerts/silences.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest } from '../lib/notify/digest.js'
import { createBot } from '../lib/notify/bot.js'
import { createClock } from '../lib/clock.js'
import { createAudit } from '../lib/auth.js'
import { prodConfig, prodLikeStore, fakeTelegram } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const HOSTILE = '<b>x</b>&<a href="javascript:alert(1)">\u0007</code>\u001b[2J192.0.2.66'

test('hostile name: escaped everywhere, without control characters or IP', async () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  store.kv.set('network.alertsSince', String(T - 3600_000))
  ns.applyOps([
    { op: 'insertDevice', ref: 'new:1', fields: { state: 'new', review: 0, origin: 'scan', created_at: T - 600_000, updated_at: T, disp_name: HOSTILE, vendor: HOSTILE, primary_mac: '00:00:5e:00:53:66', last_ip: '192.0.2.66' } },
    { op: 'upsertMac', mac: '00:00:5e:00:53:66', device: 'new:1', grade: 'strong', random: 0, first_seen: T - 600_000, last_seen: T, last_ip: '192.0.2.66' },
    { op: 'upsertSeen', mac: '00:00:5e:00:53:66', source: 'pihole', last_seen: T, last_ip: '192.0.2.66' },
  ])
  const audit = createAudit(store)
  const network = createNetwork({ cfg, store, audit, now: () => T, log: { warn() {}, error() {} } })
  const clock = createClock('Europe/Paris')
  const formatter = createFormatter({ dashboardUrl: 'http://dash.test', clock })
  const check = (text, where) => {
    assert.doesNotMatch(text, /<a href="javascript|<b>x|<\/code>/, where)
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f]/, where)
    assert.doesNotMatch(text, /192\.0\.2\.66/, where)
    assert.match(text, /&lt;b&gt;x&lt;\/b&gt;&amp;&lt;a href=/, where)
  }
  // net_new opening message
  const sig = network.signals(T).find(s => s.key.startsWith('net_new:') && s.cond)
  check(formatter.render('open', { ...sig, since: T, state: 'firing' }, T), 'telegram')
  // digest (the Network line names the new device)
  const engine = createEngine({ cfg, store, rules: createRules(cfg, { checks: [], result: () => null }, null, null, network), notifier: { enqueue: () => 'skip' }, clock, startedAt: T })
  check(buildDigest({ cfg, engine, snap: {}, monitor: { checks: [] }, formatter, clock, network, now: T }), 'digest')
  // bot: /reseau and /appareil
  const telegram = fakeTelegram()
  const bot = createBot({ telegram, store, cfg, engine, silences: createSilences({ store }), refresher: null, audit, clock,
    texts: { status: () => '', digest: () => '' }, allowedIds: '42', network, now: () => T, log: { warn() {}, error() {} } })
  for (const cmd of ['/reseau', '/appareil javascript']) {
    await bot.handle({ message: { text: cmd, from: { id: 42 }, chat: { id: 1 } } })
    check(telegram.sent.at(-1).text, cmd)
  }
})

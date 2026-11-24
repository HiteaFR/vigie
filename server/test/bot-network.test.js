// Telegram bot, network module: n/i/c/d buttons with a reason via force_reply then
// write and "telegram" audit; unauthorized account ignored; replay → "already handled" reply;
// forged data ignored; /reseau, /appareil (hostile input), /connu.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBot } from '../lib/notify/bot.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createSilences } from '../lib/alerts/silences.js'
import { createClock } from '../lib/clock.js'
import { createAudit } from '../lib/auth.js'
import { createNetwork } from '../lib/network/index.js'
import { prodConfig, prodLikeStore, fakeTelegram } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const USER = { id: 42, username: 'alice' }
const CHAT = { id: 1 }

function bench() {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T, k: 1 })
  const audit = createAudit(store)
  const network = createNetwork({ cfg, store, audit, now: () => T, log: { warn() {}, error() {} } })
  const telegram = fakeTelegram()
  const cleared = []
  telegram.clearButtons = async id => { cleared.push(id) }
  const answered = []
  telegram.answerCallback = async (id, text = '') => { answered.push(text) }
  const clock = createClock('Europe/Paris')
  const engine = createEngine({ cfg, store, rules: { evaluate: () => [], impacted: () => ({}) }, notifier: { enqueue: () => 'skip' }, clock, startedAt: T })
  const bot = createBot({ telegram, store, cfg, engine, silences: createSilences({ store }), refresher: null, audit, clock,
    texts: { status: () => 'ok', digest: () => 'digest' }, allowedIds: '42', network, now: () => T, log: { warn() {}, error() {} } })
  const cb = (data, from = USER, chat = CHAT) => bot.handle({ callback_query: { id: 'q', data, from, message: { message_id: 500, chat } } })
  const say = (text, reply) => bot.handle({ message: { text, from: USER, chat: CHAT, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } })
  const audits = () => store.db.prepare('SELECT action, source, ok, detail, actor FROM audit ORDER BY id').all().map(r => ({ ...r }))
  const newDevice = [...ns.load().devices.values()].find(d => d.state === 'new')
  return { store, ns, telegram, cleared, answered, cb, say, audits, newDevice, network }
}

test('Known button (✅): reason requested, write, telegram audit, buttons removed; replay → already handled', async () => {
  const b = bench()
  await b.cb(`n:${b.newDevice.id}`)
  const prompt = b.telegram.sent.at(-1)
  assert.match(prompt.text, /Valider l'appareil « Invite-R1-1 » : quel motif/)
  assert.equal(prompt.opts.replyMarkup.force_reply, true)
  await b.say('ok', prompt.message_id ?? b.telegram.sent.length) // reason too short
  assert.match(b.telegram.sent.at(-1).text, /Motif trop court/)
  await b.cb(`n:${b.newDevice.id}`)
  await b.say('téléphone de la voisine', b.telegram.sent.length)
  assert.match(b.telegram.sent.at(-1).text, /validé \(connu\) : téléphone de la voisine/)
  assert.equal(b.ns.device(b.newDevice.id).state, 'known')
  assert.deepEqual(b.cleared, [500])
  const a = b.audits().at(-1)
  assert.deepEqual([a.action, a.source, a.ok, a.actor], ['network: known', 'telegram', 1, 'tg:alice'])
  // button replay: "already handled" reply, one failed audit row, no write
  const before = b.audits().length
  await b.cb(`n:${b.newDevice.id}`)
  assert.equal(b.answered.at(-1), 'Déjà traité')
  assert.equal(b.audits().length, before + 1)
  assert.equal(b.audits().at(-1).ok, 0)
})

test('unauthorized account ignored and logged; forged data ignored', async () => {
  const b = bench()
  const sent = b.telegram.sent.length
  await b.cb(`n:${b.newDevice.id}`, { id: 7, username: 'intrus' })
  assert.equal(b.telegram.sent.length, sent)
  assert.equal(b.audits().at(-1).action, 'refused')
  for (const data of ['n:abc', 'c:zz0000005301', 'n:1;DROP', 'x'.repeat(65), 'd:0a00000053', `i:${'9'.repeat(11)}`]) {
    await b.cb(data)
  }
  assert.equal(b.telegram.sent.length, sent) // no reason request
  assert.equal(b.ns.device(b.newDevice.id).state, 'new')
  // pending MAC: "same device" button then reason → confirmed
  const target = [...b.ns.load().devices.values()].find(d => d.disp_name === 'poste-1')
  b.ns.applyOps([{ op: 'upsertMac', mac: '0a:00:00:00:5c:01', device: target.id, grade: 'weak', random: 1, first_seen: T, last_seen: T, attach: 'name' }])
  await b.network.writes.edit({ id: target.id, notes: 'rechargement' }, { by: 'test', source: 'ui' })
  await b.cb('c:0a0000005c01')
  await b.say('même tablette, nouvelle MAC', b.telegram.sent.length)
  assert.ok(b.ns.load().macs.get('0a:00:00:00:5c:01').confirmed_at)
})

test('/reseau, /appareil (hostile input), /connu', async () => {
  const b = bench()
  await b.say('/reseau')
  assert.match(b.telegram.sent.at(-1).text, /Réseau<\/b>\n43 appareils · \d+ actifs\n1 nouveau · 22 à revoir/)
  assert.match(b.telegram.sent.at(-1).text, new RegExp(`#${b.newDevice.id} Invite-R1-1`))
  for (const q of ['.*(', '[', '\\', '<b>']) {
    await b.say(`/appareil ${q}`)
    assert.match(b.telegram.sent.at(-1).text, /Aucun appareil|appareils/)
  }
  await b.say(`/appareil #${b.newDevice.id}`)
  assert.match(b.telegram.sent.at(-1).text, /Invite-R1-1/) // search by id
  await b.say('/appareil poste-12')
  assert.match(b.telegram.sent.at(-1).text, /<b>#\d+ poste-12<\/b>/)
  assert.doesNotMatch(b.telegram.sent.at(-1).text, /192\.0\.2\./) // IP masked by t()
  await b.say(`/connu ${b.newDevice.id} ok`)
  assert.match(b.telegram.sent.at(-1).text, /Motif obligatoire/)
  await b.say(`/connu ${b.newDevice.id} invitée du week-end`)
  assert.match(b.telegram.sent.at(-1).text, /validé/)
  await b.say(`/connu ${b.newDevice.id} invitée du week-end`)
  assert.equal(b.telegram.sent.at(-1).text, 'Déjà traité.')
})

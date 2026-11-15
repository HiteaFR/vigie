// Authenticated writes, silences, ack, Telegram bot. Done criteria:
// no write without a session, an unauthorised account is ignored and logged,
// a silence expires on its own, the reason is always mandatory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { hashPassword, verifyPassword, parseCidrs, ipAllowed, createAuth, createAudit } from '../lib/auth.js'
import { createSilences, silenceMatches } from '../lib/alerts/silences.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createBot, parseDuration } from '../lib/notify/bot.js'
import { createDecisions } from '../lib/updates/decisions.js'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createClock } from '../lib/clock.js'
import { tmpStore } from './tmpdir.js'

const lot7Store = () => tmpStore('dash-lot7-')

test('scrypt password and allowed networks', async () => {
  const h = await hashPassword('correct horse battery')
  assert.match(h, /^scrypt\$32768\$8\$1\$/)
  assert.equal(await verifyPassword('correct horse battery', h), true)
  assert.equal(await verifyPassword('correct horse batterie', h), false)
  assert.equal(await verifyPassword('x', 'n\'importe quoi'), false)
  const c = parseCidrs('10.0.0.0/24,100.64.0.0/10,127.0.0.1/32')
  assert.equal(ipAllowed('10.0.0.42', c), true)
  assert.equal(ipAllowed('::ffff:100.101.2.3', c), true)
  assert.equal(ipAllowed('::1', c), true)
  assert.equal(ipAllowed('10.0.1.1', c), false)
  assert.equal(ipAllowed('8.8.8.8', c), false)
  assert.throws(() => parseCidrs('10.0.0.0/33'), /invalid/)
})

async function server(env) {
  const store = lot7Store()
  const audit = createAudit(store)
  const auth = createAuth({ store, audit, env })
  const app = express()
  app.use(express.json())
  app.post('/api/login', async (req, res) => {
    const r = await auth.login(req, res, req.body?.password)
    res.status(r.ok ? 200 : r.status).json(r)
  })
  app.post('/api/write', (req, res, next) => auth.require(req, res, next), (req, res) => res.json({ ok: true, actor: req.actor }))
  const srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const post = (p, body, headers = {}) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body),
  })
  return { srv, base, post, audit }
}

test('write: refused without session, wrong origin, outside network; accepted with session', async () => {
  const env = { ADMIN_PASSWORD_HASH: await hashPassword('mot de passe solide') }
  const { srv, base, post, audit } = await server(env)
  try {
    assert.equal((await post('/api/write', {})).status, 401, 'without a session')
    const login = await post('/api/login', { password: 'mot de passe solide' })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly; SameSite=Strict/)
    const sid = cookie.split(';')[0]
    assert.equal((await post('/api/write', {}, { cookie: sid })).status, 200)
    assert.equal((await post('/api/write', {}, { cookie: sid, origin: 'http://evil.example' })).status, 403, 'other origin')
    const noOrigin = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: '{}' })
    assert.equal(noOrigin.status, 403, 'without Origin or Referer')
    const form = await fetch(`${base}/api/write`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: sid }, body: 'a=1' })
    assert.equal(form.status, 415, 'cross-site form')
    assert.ok(audit.list().some(a => !a.ok && a.detail === 'origine refusée'), 'refusal logged')
  } finally {
    srv.close()
  }
  // network not in the list: even with the right password
  const other = await server({ ...env, ADMIN_ALLOWED_CIDRS: '10.0.0.0/8' })
  try {
    assert.equal((await other.post('/api/login', { password: 'mot de passe solide' })).status, 403)
  } finally {
    other.srv.close()
  }
})

test('login: 5 failures per address then lockout, even with the right password', async () => {
  const { srv, post } = await server({ ADMIN_PASSWORD_HASH: await hashPassword('mot de passe solide') })
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { password: 'faux' })).status, 401)
    assert.equal((await post('/api/login', { password: 'mot de passe solide' })).status, 429)
  } finally {
    srv.close()
  }
})

test('silences: mandatory reason, target, automatic expiry', () => {
  let t = Date.parse('2026-10-20T10:00:00Z')
  const s = createSilences({ store: lot7Store(), now: () => t })
  assert.throws(() => s.create({ matcher: { host: 'docker-b' }, reason: '', by: 'x', source: 'ui', endsAt: t + 3600_000 }), /motif/)
  assert.throws(() => s.create({ matcher: { host: 'a', rule: 'b' }, reason: 'deux cibles', by: 'x', source: 'ui' }), /un seul critère/)
  assert.throws(() => s.create({ matcher: { host: 'a' }, reason: 'passé', by: 'x', source: 'ui', endsAt: t - 1 }), /échéance/)
  const created = s.create({ matcher: { host: 'docker-b' }, reason: 'migration', by: 'tg:alice', source: 'telegram', endsAt: t + 2 * 3600_000 })
  const sig = { key: 'guest_disk:docker-b:/', rule: 'guest_disk', entity: 'docker-b', hostId: 'docker-b' }
  assert.equal(s.match(sig)?.id, created.id)
  assert.equal(s.match({ ...sig, hostId: 'docker-c', entity: 'docker-c' }), null)
  t += 3 * 3600_000
  assert.equal(s.match(sig), null, 'expired without action')
  assert.equal(s.active().length, 0)
  assert.equal(silenceMatches({ key: 'container_*' }, { key: 'container_restarting:x/y' }), true)
  assert.equal(silenceMatches({ service: 'gitea' }, { entity: 'gitea#2' }), true)
})

function engineSetup() {
  const parsed = parseConfig({
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
    hosts: [{ id: 'web', name: 'web', kind: 'appliance', env: 'prod' }],
    alerts: { startupGraceSec: 0, repeat: { critical: '1h', warning: '1h' } },
  })
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const store = lot7Store()
  let t = Date.parse('2026-10-20T10:00:00Z')
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const silences = createSilences({ store, now: () => t })
  let cond = true
  const rules = { evaluate: () => [{ key: 'service_down:web', rule: 'service_down', entity: 'web', hostId: 'web', title: 'Web', env: 'prod', cond, severity: 'critical', parents: [] }], impacted: () => ({}) }
  const engine = createEngine({ cfg: parsed.config, store, rules, notifier, clock: createClock('Europe/Paris'), silences, startedAt: t - 3600_000 })
  return {
    engine, silences, sent,
    tick: (ms = 0) => { t += ms; engine.evaluate({}, t) },
    set: c => { cond = c },
    now: () => t,
  }
}

test('ack: mandatory reason, stops the reminders, goes away with the alert', () => {
  const e = engineSetup()
  e.tick()
  assert.deepEqual(e.sent, ['open:service_down:web'])
  assert.throws(() => e.engine.ack('service_down:web', { by: 'admin', reason: '' }), /motif/)
  e.engine.ack('service_down:web', { by: 'admin', reason: 'je m\'en occupe', t: e.now() })
  e.tick(2 * 3600_000)
  assert.deepEqual(e.sent, ['open:service_down:web'], 'no reminder after an ack')
  e.set(false)
  e.tick(60_000)
  assert.deepEqual(e.sent.at(-1), 'resolve:service_down:web', 'recovery notified despite the ack')
  assert.equal(e.engine.get('service_down:web'), null)
})

test('silence set before the outage: nothing is notified, then the outage is on expiry', () => {
  const e = engineSetup()
  e.silences.create({ matcher: { key: 'service_down:web' }, reason: 'maintenance imprévue', by: 'admin', source: 'ui', endsAt: e.now() + 3600_000 })
  e.tick()
  assert.deepEqual(e.sent, [])
  assert.match(e.engine.get('service_down:web').suppressed, /silence : maintenance imprévue/)
  e.tick(2 * 3600_000)
  assert.deepEqual(e.sent, ['open:service_down:web'], 'notified when the silence expires')
})

function botSetup() {
  const e = engineSetup()
  const store = lot7Store()
  const audit = createAudit(store)
  const out = []
  let msgId = 100
  const telegram = {
    chatId: '42',
    send: async (text, opts = {}) => { out.push({ text, opts }); return { message_id: ++msgId } },
    answerCallback: async () => {},
  }
  const cfg = parseConfig({
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
    hosts: [{ id: 'docker-b', name: 'docker-b', kind: 'appliance', env: 'dev' }],
  }).config
  const bot = createBot({
    telegram, store, cfg, engine: e.engine, silences: e.silences, audit, clock: createClock('Europe/Paris'),
    refresher: { run: () => ({ started: true, done: Promise.resolve({ startedAt: 0, finishedAt: 1000 }) }) },
    texts: { status: () => 'ok', digest: () => 'digest' }, allowedIds: '7', now: e.now, log: { warn() {}, error() {} },
  })
  const msg = (text, { from = 7, chat = 42, replyTo = null } = {}) => bot.handle({
    update_id: 1, message: { text, from: { id: from, username: 'u' }, chat: { id: chat }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) },
  })
  return { e, bot, out, audit, msg, telegram }
}

test('bot: unauthorised account or chat ignored without reply, and logged', async () => {
  const { out, audit, msg, e } = botSetup()
  await msg('/mute docker-b 2h pirate', { from: 666 })
  await msg('/status', { chat: 999 })
  assert.equal(out.length, 0, 'no answer')
  assert.equal(e.silences.active().length, 0, 'no effect')
  const refused = audit.list().filter(a => a.action === 'refused')
  assert.equal(refused.length, 2)
  assert.equal(refused[0].ok, false)
})

test('bot: /mute with reason and duration, expiry, /ack by button with reason requested', async () => {
  const { out, msg, e, bot } = botSetup()
  await msg('/mute docker-b 2h')
  assert.match(out.at(-1).text, /Motif obligatoire/)
  assert.equal(e.silences.active().length, 0)
  await msg('/mute docker-b 2h migration du disque')
  assert.match(out.at(-1).text, /Silence n° \d+ sur hôte docker-b/)
  assert.equal(e.silences.active().length, 1)
  e.tick(3 * 3600_000)
  assert.equal(e.silences.active().length, 0, '/mute expires by itself')
  assert.equal(parseDuration('31j'), null)
  assert.equal(parseDuration('90m'), 90 * 60_000)

  // ongoing alert → "Ack" button → reason requested → reply
  e.tick()
  const a = e.engine.get('service_down:web')
  await bot.handle({ update_id: 2, callback_query: { id: 'cb', data: `a:${a.incidentId}`, from: { id: 7 }, message: { chat: { id: 42 } } } })
  const prompt = out.at(-1)
  assert.equal(prompt.opts.replyMarkup.force_reply, true)
  await msg('ok', { replyTo: 101 + out.length - 1 })
  assert.match(out.at(-1).text, /Motif trop court/)
  await bot.handle({ update_id: 3, callback_query: { id: 'cb2', data: `a:${a.incidentId}`, from: { id: 7 }, message: { chat: { id: 42 } } } })
  await msg('disque plein, nettoyage en cours', { replyTo: 100 + out.length })
  assert.match(out.at(-1).text, /acquittée : disque plein/)
  assert.equal(e.engine.get('service_down:web').ack.by, 'tg:u')
})

test('update decisions from the UI: mandatory reason, removal', () => {
  const d = createDecisions({ store: lot7Store() })
  assert.throws(() => d.create({ compId: 'os:pihole', mode: 'all', reason: '', by: 'x' }), /motif/)
  assert.throws(() => d.create({ compId: 'os:pihole', mode: 'until', until: '2001-01-01', reason: 'trop tard', by: 'x' }), /futur/)
  const x = d.create({ compId: 'svc:gitea', mode: 'version', version: 'v28.3.0', reason: 'attendre la .1', by: 'admin' })
  assert.deepEqual(d.active().map(r => [r.id, r.version, r.reason]), [['svc:gitea', 'v28.3.0', 'attendre la .1']])
  assert.ok(d.remove(x.decisionId, 'admin'))
  assert.equal(d.active().length, 0)
})

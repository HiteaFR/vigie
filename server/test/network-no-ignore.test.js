// No more Ignore, Archive or Restore; no more network.ignore nor ignore rule; only the
// exclusions by NATURE remain; an old i: button answers "Action retirée" without writing;
// net_new only has "Connu" left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.js'
import { gradeMac } from '../lib/net/mac.js'
import { buttonsFor } from '../lib/notify/notifier.js'
import { createBot } from '../lib/notify/bot.js'
import { createAudit } from '../lib/auth.js'
import { createNetwork } from '../lib/network/index.js'
import { prodLikeStore, prodConfig, netServer, fakeTelegram } from './network-fixture.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const here = path.dirname(fileURLToPath(import.meta.url))

test('ignore, archive and restore routes → 404; ignore rule → 400; counts.ignoredMacs absent', async () => {
  const { store } = prodLikeStore({ T })
  const s = await netServer({ store, T })
  try {
    const sid = await s.login()
    for (const p of ['ignore', 'archive', 'restore']) assert.equal((await s.post(`/api/network/devices/${p}`, { id: 21, reason: 'test test' }, { cookie: sid })).status, 404, p)
    const rule = await s.post('/api/network/mac-rules', { prefix: 'fe:00:00', action: 'ignore', reason: 'test test' }, { cookie: sid })
    assert.equal(rule.status, 400)
    const v = await (await fetch(`${s.base}/api/network`)).json()
    assert.equal('ignoredMacs' in v.counts, false)
    assert.equal('ignored' in v.counts, false)
  } finally {
    s.close()
  }
})

test('config: network.ignore refused by the schema; config.example.json has none', () => {
  const base = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'o' } }
  const r = parseConfig({ ...base, network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: {}, ignore: ['02:42:ac:12:*'] } })
  assert.ok(r.errors && r.errors.some(e => /ignore/.test(e)))
  const repo = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'config.example.json'), 'utf8'))
  assert.equal('ignore' in (repo.network ?? {}), false)
})

test('store: a state other than new/known is refused; exclusions by nature still filtered out', () => {
  const { ns } = prodLikeStore({ T })
  for (const state of ['archived', 'ignored', 'deleted']) {
    assert.throws(() => ns.applyOps([{ op: 'updateDevice', device: 21, fields: { state } }]), /device state refused/, state)
    assert.throws(() => ns.applyOps([{ op: 'insertDevice', ref: 'new:1', fields: { state, created_at: T, updated_at: T } }]), /device state refused/, state)
  }
  for (const mac of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:fb', '33:33:00:00:00:01', '00:00:5e:00:01:0a', '00:00:5e:00:02:0a', '00:00:0c:07:ac:01', '00:00:0c:9f:f0:01']) {
    assert.equal(gradeMac(mac), 'excluded', mac)
  }
})

test('net_new only has "Connu" left; an old i: callback → "Action retirée", without writing, audit ok:false', async () => {
  assert.deepEqual(buttonsFor({ key: 'net_new:12' }, 'x').map(b => b.callback_data), ['n:12'])
  const cfg = prodConfig()
  const { store } = prodLikeStore({ T })
  const audit = createAudit(store)
  const network = createNetwork({ cfg, store, audit, now: () => T, log: { warn() {}, error() {} } })
  const telegram = { ...fakeTelegram(), answered: [] }
  telegram.answerCallback = async (id, text) => { telegram.answered.push(text) }
  const bot = createBot({ cfg, store, telegram, engine: { active: () => [], byIncident: () => null }, network, audit,
    allowedIds: '42', chatId: '1', now: () => T, log: { warn() {}, error() {}, log() {} } })
  const before = store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n
  await bot.handle({ update_id: 1, callback_query: { id: 'cb1', data: 'i:21', from: { id: 42 }, message: { chat: { id: 1 }, message_id: 5 } } })
  assert.deepEqual(telegram.answered, ['Action retirée'])
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_events').get().n, before)
  assert.equal(store.db.prepare("SELECT state FROM net_devices WHERE id = 21").get().state, 'known')
  const a = store.db.prepare("SELECT * FROM audit WHERE action = 'network: ignore'").get()
  assert.deepEqual([a.ok, a.source, a.detail], [0, 'telegram', 'action retired'])
})

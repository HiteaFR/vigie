// Notifier: Telegram buttons chosen by the key prefix. net_new → Known
// (no more Ignore); net_mac_added → Same device / Detach; the rest unchanged (Silence, Ack);
// nothing for info; callback_data ≤ 64 bytes; message < 4,096 characters with 12 new devices.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { createNotifier, buttonsFor } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'
import { fakeTelegram } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-21T10:00:00Z') // during the day: warning sent right away
const { config: cfg } = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], gitea: { owner: 'o' } })

function bench() {
  const store = tmpStore('dash-btn-')
  const clock = createClock('Europe/Paris')
  const telegram = fakeTelegram()
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter: createFormatter({ dashboardUrl: 'http://dash.test', clock }), buttons: true, log: { log() {}, error() {} } })
  let inc = 0
  const open = (key, severity = 'warning', title = key) => notifier.enqueue('open', { key, rule: key.split(':')[0], title, severity, env: 'prod', incidentId: ++inc, since: T, link: '/reseau' }, T)
  return { notifier, telegram, open }
}
const keyboard = m => m.opts.replyMarkup?.inline_keyboard ?? []

test('buttons by key, old ones unchanged, nothing for info', async () => {
  const b = bench()
  b.open('net_new:12', 'warning', 'Nouvel appareil : Galaxy')
  b.open('net_mac_added:0a:00:00:00:53:01')
  b.open('service_down:gitea')
  b.open('net_new:13', 'info')
  await b.notifier.flush(T + 20_000)
  const rows = keyboard(b.telegram.sent[0]).map(r => r.map(x => x.callback_data))
  assert.deepEqual(rows, [['n:12'], ['c:0a0000005301', 'd:0a0000005301'], ['s:3', 'a:3']])
  for (const r of keyboard(b.telegram.sent[0]).flat()) assert.ok(Buffer.byteLength(r.callback_data) <= 64)
  // button label: plain text (Telegram), no escaped HTML entity
  const c = bench()
  c.open('net_new:20', 'warning', 'Nouvel appareil : A&B <x>')
  await c.notifier.flush(T + 20_000)
  assert.equal(keyboard(c.telegram.sent[0])[0][0].text, '✅ Connu · Nouvel appareil : A&B…')
  // unexpected key: default set, never any data taken from the key
  assert.deepEqual(buttonsFor({ key: 'net_new:12; rm', incident_id: 7 }, 'x').map(x => x.callback_data), ['s:7', 'a:7'])
})

test('12 new devices in the same burst: one message < 4,096 characters, at most 8 rows of buttons', async () => {
  const b = bench()
  for (let i = 1; i <= 12; i++) b.open(`net_new:${i}`, 'warning', `Nouvel appareil : ${'Téléphone-invité-'.repeat(3)}${i}`)
  await b.notifier.flush(T + 20_000)
  assert.equal(b.telegram.sent.length, 1)
  assert.ok(b.telegram.sent[0].text.length < 4096)
  assert.equal(keyboard(b.telegram.sent[0]).length, 8)
})

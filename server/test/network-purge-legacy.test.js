// Purge of ignored and archived records at deployment, on the production state:
// synchronous before the engine, only once, per state; lastDeviceId set beforehand; 6 audit
// lines, 6 tombstones, no notification, one digest line; robustness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNetwork } from '../lib/network/index.js'
import { createNetStore } from '../lib/network/store.js'
import { createAudit } from '../lib/auth.js'
import { openDb } from '../lib/db.js'
import { r3Bench, r4ProdStore, freezePihole, prodConfig, prodLikeStore, TAB_MACS, FIXTURE_HOSTS, MIN, quiet } from './network-fixture.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-21T15:30:00Z')

test('deployment on the production state: 6 records purged per state, 0 messages, one digest line, idempotent', async () => {
  const { store, archived, router } = r4ProdStore({ T })
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM net_devices WHERE state = 'archived'").get().n, 6)
  const b = r3Bench({ T, store })
  // set BEFORE the purge (the highest record, 42, is not necessarily archived here)
  assert.equal(b.store.kv.get('network.lastDeviceId'), '42')
  const purge = JSON.parse(b.store.kv.get('network.legacyPurge'))
  assert.deepEqual([purge.n, purge.ids.sort((x, y) => x - y)], [6, [...archived].sort((x, y) => x - y)])
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_devices').get().n, 36)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_devices WHERE state NOT IN ('new', 'known')").get().n, 0)
  const audit = b.store.db.prepare("SELECT * FROM audit WHERE action = 'network: legacy states purge' ORDER BY id").all()
  assert.equal(audit.length, 6)
  assert.ok(audit.every(a => a.actor === 'migration:legacy-states' && a.source === 'script' && /archived, deleted/.test(a.detail)))
  assert.equal(b.store.db.prepare('SELECT COUNT(*) n FROM net_tombstones').get().n, 6)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_links WHERE child = ? AND removed_at IS NULL").get(`dev:${router}`).n, 1) // router link intact
  // 30 min of evaluations, the TABs still in Pi-hole's table (lastSeen frozen): 0 messages, 0 re-creations
  freezePihole(b, Object.fromEntries(TAB_MACS.map((m, i) => [m, i === 4 ? Date.parse('2026-10-11T21:05:00Z') : Date.parse('2026-09-27T16:41:00Z')])))
  const live = FIXTURE_HOSTS.filter(h => !TAB_MACS.includes(h.mac) && h.mac !== '00:00:5e:00:53:8b')
  await b.run(30, live)
  assert.deepEqual([b.outbox(), b.telegram.sent.length], [0, 0])
  assert.equal(b.engine.active().filter(a => a.rule.startsWith('net_')).length, 0)
  for (const mac of TAB_MACS) assert.equal(b.devByMac(mac), undefined, mac)
  assert.match(b.digest(true), /6 fiches archivées supprimées \(purge R4\)/)
  assert.doesNotMatch(b.digest(true), /purge R4/) // only once
  // second start: nothing (purgeR4 key)
  const b2 = r3Bench({ T: b.clock.t, store: b.store })
  assert.equal(b2.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'network: legacy states purge'").get().n, 6)
  await b2.run(10, live)
  assert.deepEqual([b2.outbox(), b2.telegram.sent.length], [0, 0])
})

test('archived record linked to a host: set back to known, not deleted; database with no record to purge: key only', () => {
  const { store, ns } = prodLikeStore({ T })
  const guest = [...ns.load().devices.values()].find(d => d.host_id)
  store.db.prepare("UPDATE net_devices SET state = 'archived' WHERE id = ?").run(guest.id)
  createNetwork({ cfg: prodConfig(), store, audit: createAudit(store), now: () => T, log: quiet })
  assert.equal(ns.device(guest.id).state, 'known')
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'network: legacy states purge'").get().n, 1)
  assert.equal(JSON.parse(store.kv.get('network.legacyPurge')).n, 0)
  // dev database with no record to purge: the key is set, nothing else
  const empty = tmpStore('dash-r4-')
  createNetStore(empty)
  const net = createNetwork({ cfg: prodConfig(), store: empty, audit: createAudit(empty), now: () => T, log: quiet })
  assert.deepEqual([JSON.parse(empty.kv.get('network.legacyPurge')).n, empty.db.prepare('SELECT COUNT(*) n FROM audit').get().n], [0, 0])
  assert.ok(!net.digestLines({ now: T }).some(l => /purge R4/.test(l)))
})

test('an error during the purge: dashboard started, 0 deletions, key absent, purge succeeds at the next start', () => {
  const { store } = r4ProdStore({ T })
  const logs = []
  let boom = true
  // audit that throws at the first line: the transaction is rolled back
  const audit = { log: e => { if (boom && e.action === 'network: legacy states purge') throw new Error('disque plein') } }
  const net = createNetwork({ cfg: prodConfig(), store, audit, now: () => T, log: { warn() {}, error: m => logs.push(m) } })
  assert.equal(net.enabled, true)
  assert.equal(store.kv.get('network.legacyPurge'), null)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM net_devices WHERE state = 'archived'").get().n, 6)
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM net_tombstones').get().n, 0)
  assert.ok(logs.some(m => /legacy states purge: disque plein/.test(m)))
  boom = false
  createNetwork({ cfg: prodConfig(), store, audit: createAudit(store), now: () => T + MIN, log: quiet })
  assert.equal(JSON.parse(store.kv.get('network.legacyPurge')).n, 6)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM net_devices WHERE state = 'archived'").get().n, 0)
})

test('purge recorded by an earlier version (kv network.purgeR4, network.purgeR4Digested): not run again, digest line once, then marked under the new name', () => {
  const { store, ns } = prodLikeStore({ T })
  const guest = [...ns.load().devices.values()].find(d => d.host_id)
  store.db.prepare("UPDATE net_devices SET state = 'archived' WHERE id = ?").run(guest.id)
  store.kv.set('network.purgeR4', JSON.stringify({ at: '2026-10-21T15:00:00.000Z', n: 6, ids: [] }))
  const net = createNetwork({ cfg: prodConfig(), store, audit: createAudit(store), now: () => T, log: quiet })
  // already run: the archived record stays as it is, no audit line, no new key
  assert.equal(ns.device(guest.id).state, 'archived')
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audit').get().n, 0)
  assert.equal(store.kv.get('network.legacyPurge') ?? null, null)
  // the digest line of the former purge comes once, then is marked under the new name only
  assert.equal(net.digestLines({ now: T, mark: true }).filter(l => /purge R4/.test(l)).length, 1)
  assert.ok(store.kv.get('network.legacyPurgeDigested'))
  assert.equal(store.kv.get('network.purgeR4Digested') ?? null, null)
  assert.equal(net.digestLines({ now: T }).filter(l => /purge R4/.test(l)).length, 0)
  // marked by the former version: no line at all
  const { store: s2 } = prodLikeStore({ T })
  s2.kv.set('network.purgeR4', JSON.stringify({ n: 6 }))
  s2.kv.set('network.purgeR4Digested', '2026-10-22T06:00:00.000Z')
  const n2 = createNetwork({ cfg: prodConfig(), store: s2, audit: createAudit(s2), now: () => T, log: quiet })
  assert.equal(n2.digestLines({ now: T, mark: true }).filter(l => /purge R4/.test(l)).length, 0)
  // deletions of the last 24 h: the purge's own deletions are left out, under the former actor too
  const del = s2.db.prepare("INSERT INTO net_events (ts, device_id, type, detail, actor) VALUES (?, NULL, 'deleted', ?, ?)")
  del.run(T - 3600_000, 'dev:1 — purge R4 : archivée', 'migration:r4')
  del.run(T - 3600_000, 'dev:2 — legacy states purge: archived', 'migration:legacy-states')
  del.run(T - 3600_000, 'dev:3 — doublon', 'admin')
  assert.deepEqual(n2.digestLines({ now: T }).filter(l => /supprimée/.test(l)).map(l => l.trim()), ['1 fiche supprimée (24 h)'])
})

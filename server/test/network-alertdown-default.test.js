// Auditor requirement: no default value, no migration and no creation path sets
// alert_down = 1; only an explicit edit turns it on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { createNetStore } from '../lib/network/store.js'
import { createNetworkWrites } from '../lib/network/writes.js'
import { createAudit } from '../lib/auth.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { prodLikeStore, prodConfig } from './network-fixture.js'
import { tmpDir } from './tmpdir.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const who = { by: 'admin (test)', source: 'ui' }
const alertDown = store => store.db.prepare('SELECT SUM(alert_down) s, COUNT(*) n FROM net_devices').get()

test('migration on an older database (linked records, fixed profiles): alert_down = 0 everywhere', () => {
  const dir = tmpDir('dash-r2-')
  const { store } = prodLikeStore({ T, dir })
  // database as the previous version left it: no last_present; fixed profiles on linked records
  store.db.exec('ALTER TABLE net_devices DROP COLUMN last_present')
  store.db.exec("UPDATE net_devices SET profile = 'fixed' WHERE host_id IS NOT NULL")
  // restart on the new version: the additive migration adds the column without touching alert_down
  const again = openDb(dir)
  createNetStore(again)
  const cols = again.db.prepare('PRAGMA table_info(net_devices)').all()
  assert.ok(cols.some(c => c.name === 'last_present'))
  assert.equal(cols.find(c => c.name === 'alert_down').dflt_value, '0')
  assert.deepEqual({ ...alertDown(again) }, { s: 0, n: 42 })
})

test('creation through every path (scan, pve, config, arp, detach, merge): alert_down = 0', () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T })
  const m = mergeSightings({ ...ns.load(), flood: emptyFlood() }, [
    { mac: '00:00:5e:00:53:e5', ip: '192.0.2.181', source: 'pihole', ts: T, presence: true, name: 'Scan' },
    { mac: '00:00:5e:00:53:e6', ip: '192.0.2.182', source: 'arp', ts: T, presence: true },
    { mac: '00:00:5e:00:53:e7', ip: '192.0.2.183', source: 'self', ts: T, presence: true },
    { mac: '02:00:00:00:5a:99', ip: '192.0.2.184', source: 'pve', ts: T, presence: false, hostId: 'g1' },
  ], { cfg, now: T })
  ns.applyOps(m.ops)
  // detach, then merge
  const two = [...ns.load().devices.values()].find(d => d.disp_name === 'speedtest')
  W.detachMac({ mac: '62:00:00:00:53:e2', reason: 'vérification' }, who)
  const det = [...ns.load().devices.values()].find(d => d.origin === 'detach')
  W.merge({ into: two.id, from: [det.id], reason: 'même appareil' }, who)
  assert.equal(alertDown(store).s, 0)
  assert.ok(alertDown(store).n >= 45)
  // only an explicit edit turns it on (audited)
  W.edit({ id: two.id, alertDown: true }, who)
  assert.equal(alertDown(store).s, 1)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action = 'network: edit' AND detail LIKE '%alertDown%'").get().n, 1)
})

// Network module: persistence (lib/network/store.js). All-or-nothing writes, complete
// schema from the start, purge according to the retention rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'
import { createNetStore } from '../lib/network/store.js'
import { tmpStore } from './tmpdir.js'

const DAY = 86400_000
const NOW = Date.parse('2026-10-20T12:00:00Z')
const fresh = () => {
  const store = tmpStore('dash-nst-')
  return { store, ns: createNetStore(store), count: t => store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n }
}
const device = (ref, fields = {}) => ({ op: 'insertDevice', ref, fields: { state: 'known', created_at: NOW, updated_at: NOW, ...fields } })
const mac = (mac, device, seen = NOW) => ({ op: 'upsertMac', mac, device, grade: 'strong', random: 0, first_seen: seen, last_seen: seen, last_ip: '192.0.2.1' })

test('complete schema from the start, idempotent', () => {
  const { store, ns } = fresh()
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'net_%' ORDER BY name").all().map(r => r.name)
  assert.deepEqual(tables, ['net_addresses', 'net_attrs', 'net_devices', 'net_events', 'net_links', 'net_mac_rules', 'net_macs',
    'net_ports', 'net_presence_1h', 'net_runs', 'net_seen', 'net_sessions', 'net_tombstones'])
  assert.ok(store.db.prepare('PRAGMA table_info(net_devices)').all().some(c => c.name === 'last_dhcp'))
  createNetStore(store) // second call: nothing breaks
  assert.equal(ns.load().devices.size, 0)
})

test('applyOps: references resolved, all or nothing', () => {
  const { ns, count } = fresh()
  const refs = ns.applyOps([device('new:1'), mac('00:00:5e:00:53:01', 'new:1'),
    { op: 'upsertAttr', device: 'new:1', attr: 'name', source: 'pihole', value: 'nas', rank: 4, seen_at: NOW },
    { op: 'insertEvent', device: 'new:1', type: 'new', ts: NOW },
    { op: 'insertLink', device: 'new:1', parent: 'internet', kind: 'uplink', by: 'import', ts: NOW }])
  const id = refs.get('new:1')
  assert.equal(ns.load().macs.get('00:00:5e:00:53:01').device_id, id)
  // an invalid op in the middle: no write of the batch remains
  assert.throws(() => ns.applyOps([device('new:1'), mac('00:00:5e:00:53:02', 'new:1'), { op: 'inconnue' }]), /unknown op: inconnue/)
  assert.throws(() => ns.applyOps([mac('00:00:5e:00:53:03', 'new:9')]), /unknown reference/)
  assert.deepEqual([count('net_devices'), count('net_macs')], [1, 1])
  // columns outside the allow list ignored (no column name comes from outside)
  ns.applyOps([{ op: 'updateDevice', device: id, fields: { name: 'x', 'id = 0; --': 1 } }])
  assert.equal(ns.device(id).name, 'x')
  // link: only one active per child
  ns.applyOps([{ op: 'insertLink', device: id, parent: 'dev:99', kind: 'uplink', by: 'import', ts: NOW }])
  assert.equal(count('net_links'), 1)
})

test('purge: retention rules (tombstones older than 400 d, no more archived records)', () => {
  const { store, ns, count } = fresh()
  const old = NOW - 401 * DAY
  const refs = ns.applyOps([
    device('new:1', { last_seen: old }), mac('00:00:5e:00:53:a1', 'new:1', old), // silent for 401 d: never deleted
    { op: 'upsertSeen', mac: '00:00:5e:00:53:a1', source: 'pihole', last_seen: old },
    { op: 'insertLink', device: 'new:1', parent: 'internet', kind: 'uplink', by: 'import', ts: old },
    device('new:2', { last_seen: NOW }), mac('00:00:5e:00:53:b1', 'new:2', NOW), mac('00:00:5e:00:53:b2', 'new:2', old),
    device('new:3', { last_seen: old }), mac('00:00:5e:00:53:c1', 'new:3', old), // last MAC of its record: kept
    // two silent MACs with the same date: only one is purged, the record keeps one
    device('new:4', { last_seen: old }), mac('00:00:5e:00:53:d1', 'new:4', old), mac('00:00:5e:00:53:d2', 'new:4', old),
    { op: 'upsertAddress', mac: '00:00:5e:00:53:b1', ip: '192.0.2.5', ts: old, source: 'pihole' },
    { op: 'upsertAttr', device: 'new:2', attr: 'name', source: 'dhcp', value: 'vieux', rank: 6, seen_at: old },
    { op: 'insertEvent', device: 'new:2', type: 'new', ts: old },
    { op: 'run', ts: NOW - 8 * DAY, source: 'pihole', ok: true }, { op: 'run', ts: NOW - DAY, source: 'pihole', ok: true },
  ])
  store.db.prepare('INSERT INTO net_presence_1h VALUES (?, ?, 1, 1)').run(NOW - 91 * DAY, refs.get('new:2'))
  store.db.prepare("INSERT INTO net_tombstones VALUES ('00:00:5e:00:53:e1', ?, 9, 'vieux', 'test'), ('00:00:5e:00:53:e2', ?, 10, 'récent', 'test')").run(old, NOW - DAY)
  ns.purge(NOW)
  const s = ns.load()
  assert.equal(s.devices.has(refs.get('new:1')), true) // no more purge by state: a record stays
  assert.deepEqual([...s.macs.keys()].sort(), ['00:00:5e:00:53:a1', '00:00:5e:00:53:b1', '00:00:5e:00:53:c1', '00:00:5e:00:53:d2'])
  assert.deepEqual([count('net_seen'), count('net_addresses'), count('net_attrs'), count('net_events'), count('net_runs'), count('net_presence_1h')],
    [0, 0, 0, 0, 1, 0])
  assert.deepEqual([...s.tombstones.keys()], ['00:00:5e:00:53:e2'])
})

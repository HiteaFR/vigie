// Config. Defaults in the schema only (values unchanged, frozen here), with no
// hidden fallback in merge.js, presence.js or index.js of the network module; proxmox[].env
// validated as a variable prefix; v1 refused with a clear message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseConfig, V1_GONE, NOT_V2 } from '../lib/config.js'

const base = (over = {}) => ({
  version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }], services: [], hosts: [],
  proxmox: [{ id: 'prod', label: 'P', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }],
  ...over,
})
const src = f => fs.readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')

test('network module defaults in the schema, values unchanged (frozen): presence 5 / 10 / 45 min and 3 scans, ingestDays 30, activeMin 15, maxNewPerCycle 20, sources, probe, mDNS', () => {
  const { config, errors } = parseConfig(base({ network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: { pihole: { url: 'http://192.0.2.158', secretEnv: 'PH' }, arp: { file: '/run/net-scan/arp.json' } } } }))
  assert.ok(config, errors?.join('\n'))
  const n = config.network
  assert.deepEqual(n.presence, { fixedMin: 5, normalMin: 10, sleepyMin: 45, minMissedScans: 3 })
  assert.deepEqual([n.ingestDays, n.activeMin, n.maxNewPerCycle, n.ipIdentity], [30, 15, 20, []])
  assert.deepEqual([n.sources.pihole.intervalSec, n.sources.arp.intervalSec, n.sources.pve], [60, 120, true])
  assert.deepEqual([n.probe, n.mdns, n.alerts], [{ enabled: false, exclude: [] }, { enabled: false }, { newSeverity: 'warning' }])
  // a given value keeps priority; the others take the default
  assert.deepEqual(parseConfig(base({ network: { subnets: [{ cidr: '192.0.2.0/24', name: 'LAN' }], sources: {}, presence: { sleepyMin: 60 } } })).config.network.presence, { fixedMin: 5, normalMin: 10, sleepyMin: 60, minMissedScans: 3 })
})

test('no hidden or duplicated default in merge.js, presence.js and index.js of the network module', () => {
  const merge = src('network/merge.js')
  assert.doesNotMatch(merge, /maxNewPerCycle \?\?|ingestDays \?\?|ipIdentity \?\?|subnets \?\?/)
  const presence = src('network/presence.js')
  assert.doesNotMatch(presence, /(fixedMin|normalMin|sleepyMin|minMissedScans) \?\?/)
  assert.doesNotMatch(presence, /activeMin = \d|presence = \{\}|cfg = \{\}/)
  const index = src('network/index.js')
  assert.doesNotMatch(index, /intervalSec \?\? \d|ipIdentity \?\?|presence \?\? \{\}|newSeverity \?\?/)
  // paces without a configured source: named constants, same values as the schema defaults
  assert.match(index, /^const RUN_PERIOD_SEC = 60$/m)
  assert.match(index, /^const ARP_PERIOD_SEC = 120$/m)
})

test('proxmox[].env: variable prefix (uppercase, digits, _); config.example.json valid (PVE)', () => {
  assert.ok(parseConfig(base()).config)
  for (const env of ['PVE', 'PVE_PROD', 'PVE2']) assert.ok(parseConfig(base({ proxmox: [{ id: 'p', label: 'P', host: 'http://192.0.2.1:8006', env }] })).config, env)
  for (const env of ['pve', 'PVE-PROD', '1PVE', 'PVE PROD', '', 'PVE_PROD_TOKEN_ID=x']) {
    assert.ok(parseConfig(base({ proxmox: [{ id: 'p', label: 'P', host: 'http://192.0.2.1:8006', env }] })).errors, env)
  }
  const repo = JSON.parse(fs.readFileSync(new URL('./fixtures/config.reference.json', import.meta.url), 'utf8'))
  assert.equal(repo.version, 2)
  assert.deepEqual(repo.proxmox.map(p => p.env), ['PVE'])
  assert.ok(parseConfig(repo).config)
})

test('v1 refused with a clear message (no version, version 1, links[] and health[]); no conversion anymore', () => {
  assert.equal(V1_GONE, 'config v1 no longer supported: move to version 2 (see docs/configuration.md)')
  const v1 = { title: 't', links: [{ group: 'G', items: [{ name: 'Appli', url: 'http://192.0.2.1/' }] }], health: [{ name: 'Appli', url: 'http://192.0.2.1/', host: 'a.test' }] }
  for (const raw of [v1, { ...v1, version: 1 }, { title: 't' }]) assert.deepEqual(parseConfig(raw).errors, [V1_GONE], JSON.stringify(raw))
  assert.ok(parseConfig({ ...base(), version: 3 }).errors.some(e => e.startsWith('version:')))
  const cfg = src('config.js')
  assert.doesNotMatch(cfg, /fromV1|legacy|v1\.health|v1\.links/)
  assert.doesNotMatch(fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /loaded\.legacy/)
})

// empty or invalid is not "v1"; own message, nothing else changes
test('null config, array, scalar or empty object → "empty or invalid config", not "v1"', () => {
  assert.equal(NOT_V2, 'empty or invalid config: version 2 expected (see docs/configuration.md)')
  for (const raw of [null, undefined, {}, [], [{ version: 2 }], 'texte', 0, 2, true]) {
    assert.deepEqual(parseConfig(raw).errors, [NOT_V2], JSON.stringify(raw))
  }
  // a single field is enough to leave the "empty" case: without version, it is a v1
  assert.deepEqual(parseConfig({ version: 1 }).errors, [V1_GONE])
  assert.deepEqual(parseConfig({ links: [] }).errors, [V1_GONE])
})

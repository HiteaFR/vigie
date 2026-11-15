// Freshness of the slow report in the "auto updates" lines of the digest. A host
// whose last slow report is older than 2 cycles (2 h) no longer counts in "applied tonight" nor
// in "no fix": it is listed as "without a recent report". Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow, SLOW_SEC } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createUpdates, SLOW_REPORT_MAX_AGE_MS } from '../lib/updates/index.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const NOW = Date.parse('2026-11-05T07:00:00Z')
const CFG = parseConfig({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((id, i) => ({ id, name: id, kind: 'lxc', pve: 'prod', vmid: 201 + i, ip: `192.0.2.${11 + i}`, env: 'prod', agent: 'ssh' })),
}).config
const v7 = (applied = []) => cleanSlow({
  version: 7, ts: Math.floor(NOW / 1000), apt: { listsAt: Math.floor(NOW / 1000), upgradable: 0, security: 0, packages: [] },
  autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: Math.floor((NOW - 4 * H) / 1000), lastResult: 'success', applied: applied.map(name => ({ name, version: '1.0-2' })) },
})
const v6 = () => cleanSlow({ version: 6, ts: Math.floor(NOW / 1000), apt: { listsAt: Math.floor(NOW / 1000), upgradable: 0, security: 0, packages: [] } })
// state of a host: slow report received `ageH` hours ago; ok false = agent in error
const host = (slow, ageH, ok = true) => ({ ok, at: NOW - (ok ? 20_000 : ageH * H), error: ok ? null : 'timeout', fast: null, slow, slowAt: ageH == null ? null : NOW - ageH * H })
function lines(t, states) {
  const agents = { hosts: CFG.hosts, get: id => states[id] ?? { ok: null } }
  const upstream = { github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [], errors: () => [], stats: () => ({}) }
  const u = createUpdates({ cfg: CFG, store: tmpStore('dash-l10-', t), agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  const all = u.digestLines({ now: NOW })
  const i = all.findIndex(l => l.startsWith('🛡'))
  return i < 0 ? [] : all.slice(i)
}

test('freshness threshold: 2 slow cycles (2 h), named, without a config key', () => {
  assert.equal(SLOW_SEC, 3600)
  assert.equal(SLOW_REPORT_MAX_AGE_MS, 2 * H)
  assert.equal(CFG.alerts.slowReportMaxAgeHours, undefined)
})

test('fresh report: counted (exactly 2 h included)', t => {
  assert.deepEqual(lines(t, { alpha: host(v7(['openssl']), 0.2), bravo: host(v7(['curl']), 2) }), [
    '🛡 2 correctifs de sécurité appliqués cette nuit sur 2 hôtes',
    '  alpha : openssl',
    '  bravo : curl',
  ])
})

test('report at 2 h 01: out of the "applied", listed as without a recent report; only host → no "no fix" line', t => {
  assert.deepEqual(lines(t, { alpha: host(v7(['openssl']), 2 + 1 / 60) }), ['🛡 MAJ auto : 1 hôte sans rapport récent : alpha'])
  assert.deepEqual(lines(t, { alpha: host(v7([]), 2.02), bravo: host(v7([]), 3) }), ['🛡 MAJ auto : 2 hôtes sans rapport récent : alpha, bravo'])
})

test('agent in error: old slow report → without a recent report; still fresh → counted; never received (slowAt null) → without a recent report', t => {
  assert.deepEqual(lines(t, { alpha: host(v7(['openssl']), 3, false) }), ['🛡 MAJ auto : 1 hôte sans rapport récent : alpha'])
  assert.deepEqual(lines(t, { alpha: host(v7(['openssl']), 0.5, false) }), ['🛡 1 correctif de sécurité appliqué cette nuit sur 1 hôte', '  alpha : openssl'])
  assert.deepEqual(lines(t, { alpha: { ...host(v7(['openssl']), null), slowAt: null } }), ['🛡 MAJ auto : 1 hôte sans rapport récent : alpha'])
})

test('mix of hosts: fresh with and without a fix, 2 h 01, agent in error, old v6 (never listed)', t => {
  const out = lines(t, {
    alpha: host(v7(['openssl', 'libssl3']), 0.5),
    bravo: host(v7([]), 1),
    charlie: host(v7(['curl']), 2 + 1 / 60),
    delta: host(v7(['bash']), 5, false),
    echo: host(v6(), 10),
  })
  assert.deepEqual(out, [
    '🛡 2 correctifs de sécurité appliqués cette nuit sur 1 hôte',
    '  alpha : openssl, libssl3',
    '  2 hôtes sans rapport récent : charlie, delta',
  ])
  // fresh without a fix, plus an old one: "no fix" only counts the fresh ones
  assert.deepEqual(lines(t, { bravo: host(v7([]), 1), charlie: host(v7(['curl']), 6) }), [
    '🛡 Aucun correctif de sécurité appliqué cette nuit (1 hôte en MAJ auto)',
    '  1 hôte sans rapport récent : charlie',
  ])
  // the whole fleet on v6 or cut off: no line (unchanged)
  assert.deepEqual(lines(t, { echo: host(v6(), 10) }), [])
})

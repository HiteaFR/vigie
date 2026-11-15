// Dashboard overview and digest aggregates (lib/status.js), FAKE data:
// services (median latency, environment filter), guests (declared stopped, source
// errors), alerts (suppressed, pending, 24 h incidents), certificates, backups (overdue,
// failed, next run), CI, global state and network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summary, backupStatus } from '../lib/status.js'
import { parseConfig } from '../lib/config.js'

const NOW = Date.parse('2026-10-28T10:00:00Z')
const H = 3600_000
const cfg = (() => {
  const p = parseConfig({
    version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'pve', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }, { id: 'pve-b', label: 'Dev', host: 'http://192.0.2.156:8006', env: 'PVE_DEV' }],
    hosts: [
      { id: 'node-prod', name: 'pve', kind: 'pve-node', pve: 'pve', env: 'prod' },
      { id: 'node-dev', name: 'pve-b', kind: 'pve-node', pve: 'pve-b', env: 'dev' },
      { id: 'web', name: 'web', kind: 'lxc', pve: 'pve', vmid: 101, env: 'prod' },
      { id: 'db', name: 'db', kind: 'vm', pve: 'pve', vmid: 102, env: 'prod' },
      { id: 'lab', name: 'lab', kind: 'lxc', pve: 'pve-b', vmid: 201, env: 'dev' },
    ],
    services: [
      { id: 'site', name: 'Site', group: 'g', host: 'web', checks: [{ type: 'tls', host: 'site.test' }] },
      { id: 'labo', name: 'Labo', group: 'g', host: 'lab', checks: [{ type: 'tls', host: 'labo.test', warnDays: 40 }] },
      { id: 'api', name: 'API', group: 'g', host: 'web', checks: [{ type: 'tls', host: 'api.test' }] },
      { id: 'mail', name: 'Mail', group: 'g', host: 'web', checks: [{ type: 'tls', host: 'mail.test' }] },
    ],
    alerts: { backupMaxAgeHours: 26 },
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
})()

const services = [
  { id: 'a', env: 'prod', state: 'ok', latencyMs: 30 },
  { id: 'b', env: 'prod', state: 'crit', latencyMs: null },
  { id: 'c', env: 'prod', state: 'warn', latencyMs: 10 },
  { id: 'd', env: 'dev', state: 'unknown', latencyMs: 50 },
  { id: 'e', env: 'dev', state: 'ok', latencyMs: 20 },
  { id: 'f', env: 'prod', state: 'none', latencyMs: 99 }, // link only: ignored
]
const snap = {
  cluster: { data: [
    { id: 'pve', guests: [{ vmid: 101, status: 'running' }, { vmid: 102, status: 'stopped' }, { vmid: 103, status: 'running' }] },
    { id: 'pve-b', error: 'injoignable' },
  ] },
  backups: { data: [
    // 25 h: up to date with backupMaxAgeHours 26 (overdue with 24); 30 h: overdue
    { id: 'pve', items: [{ vmid: 101, last: (NOW - 25 * H) / 1000 }, { vmid: 102, last: (NOW - 30 * H) / 1000 }], jobs: [{ enabled: true, nextRun: (NOW + 5 * H) / 1000 }, { enabled: false, nextRun: (NOW + H) / 1000 }, { enabled: true, nextRun: (NOW + 3 * H) / 1000 }] },
    { id: 'pve-b', items: [{ vmid: 201, failed: true, last: (NOW - H) / 1000 }] },
  ] },
  runners: { data: [{ status: 'online' }, { status: 'offline' }], error: null },
  gitea: { data: [
    { name: 'dash', mainRun: { status: 'failure', number: 42, date: '2026-10-28' }, lastRun: { status: 'running' } },
    { name: 'site', mainRun: { status: 'success' }, lastRun: { status: 'waiting' } },
    { name: 'vieux', lastRun: { status: 'success' } },
  ] },
}
const alertsOf = list => ({
  active: () => list,
  incidents: since => [{ env: 'prod', at: since + 1 }, { env: 'dev', at: since + 2 }, { env: 'prod', at: since + 3 }],
})
// default of 21 days bounded on both sides: 20 days → "soon"; 21 days (strict bound) and 25 days → no;
// 35 days: soon with warnDays 40
const tlsResults = { 'site#0': { tls: { daysLeft: 20 } }, 'labo#0': { tls: { daysLeft: 35 } }, 'api#0': { tls: { daysLeft: 25 } }, 'mail#0': { tls: { daysLeft: 21 } } }
const monitor = {
  checks: [{ id: 'site#0', type: 'tls', serviceId: 'site' }, { id: 'labo#0', type: 'tls', serviceId: 'labo', warnDays: 40 }, { id: 'api#0', type: 'tls', serviceId: 'api' }, { id: 'mail#0', type: 'tls', serviceId: 'mail' }, { id: 'site#1', type: 'http', serviceId: 'site' }],
  result: id => tlsResults[id],
}
const run = (over = {}) => summary({ cfg, snap, monitor, engine: alertsOf([]), servicesView: () => services, now: NOW, ...over })

test('status services: "none" excluded, counts per state, median latency; prod / dev filter', () => {
  assert.deepEqual(run().services, { total: 5, ok: 2, warn: 1, crit: 1, unknown: 1, medianLatencyMs: 30 })
  assert.deepEqual(run({ env: 'prod' }).services, { total: 3, ok: 1, warn: 1, crit: 1, unknown: 0, medianLatencyMs: 30 })
  assert.deepEqual(run({ env: 'dev' }).services, { total: 2, ok: 1, warn: 0, crit: 0, unknown: 1, medianLatencyMs: 50 })
  assert.equal(run({ servicesView: () => [] }).services.medianLatencyMs, null)
})

test('status guests: running / total per environment, declared stopped, source in error; filter', () => {
  const all = run().guests
  assert.deepEqual(all, { running: 2, total: 3, byEnv: { prod: { running: 2, total: 3, node: 'pve' } }, stoppedDeclared: ['db'], errors: ['pve-b : injoignable'] })
  assert.deepEqual(run({ env: 'dev' }).guests.errors, ['pve-b : injoignable'])
  assert.deepEqual(run({ env: 'dev' }).guests.total, 0)
  assert.deepEqual(run({ env: 'prod' }).guests.errors, [])
  assert.deepEqual(run({ snap: {} }).guests, { running: 0, total: 0, byEnv: {}, stoppedDeclared: [], errors: [] })
})

test('status alerts: notifiable by severity, suppressed apart, pending, 24 h incidents filtered; global state', () => {
  const list = [
    { env: 'prod', state: 'firing', severity: 'critical' },
    { env: 'prod', state: 'firing', severity: 'critical', suppressed: true },
    { env: 'dev', state: 'firing', severity: 'warning' },
    { env: 'prod', state: 'firing', severity: 'info' },
    { env: 'prod', state: 'pending', severity: 'critical' },
  ]
  const s = run({ engine: alertsOf(list) })
  assert.deepEqual(s.alerts, { critical: 1, warning: 1, info: 1, pending: 1, masked: 1, incidents24h: 3 })
  assert.equal(s.state, 'crit')
  assert.deepEqual(run({ engine: alertsOf(list), env: 'dev' }).alerts, { critical: 0, warning: 1, info: 0, pending: 0, masked: 0, incidents24h: 1 })
  assert.equal(run({ engine: alertsOf(list), env: 'dev' }).state, 'warn')
  // without alert: "unknown" if a source is missing (dev cluster, backups), otherwise ok
  assert.deepEqual([run().state, run().sourcesDown], ['unknown', ['pve-b : injoignable']])
  assert.equal(run({ env: 'prod' }).state, 'ok')
})

test('status certificates: nearest expiry, "soon" according to the check warnDays (21 by default), filter; probe without result ignored', () => {
  assert.deepEqual(run().certs, { total: 4, minDays: 20, minName: 'Site', soon: 2 })
  assert.deepEqual(run({ env: 'prod' }).certs, { total: 3, minDays: 20, minName: 'Site', soon: 1 }) // 21 days and 25 days: not "soon"
  assert.deepEqual(run({ env: 'dev' }).certs, { total: 1, minDays: 35, minName: 'Labo', soon: 1 })
  assert.deepEqual(run({ monitor: { ...monitor, result: () => undefined } }).certs, { total: 0, minDays: null, minName: null, soon: 0 })
})

test('status backups: up to date, overdue (> backupMaxAgeHours), failed; last and next run (active job); source in error', () => {
  const b = backupStatus(cfg, snap, NOW)
  assert.deepEqual(b[0], { id: 'pve', node: 'pve', env: 'prod', total: 2, ok: 1, late: ['db'], failed: [], last: NOW - 25 * H, next: NOW + 3 * H })
  assert.deepEqual(b[1], { id: 'pve-b', node: 'pve-b', env: 'dev', total: 1, ok: 0, late: [], failed: ['lab'], last: NOW - H, next: null })
  const err = backupStatus(cfg, { backups: { data: [{ id: 'pve', error: 'HTTP 500' }] } }, NOW)
  assert.deepEqual(err, [{ id: 'pve', node: 'pve', env: 'prod', error: 'HTTP 500', total: 2, ok: 0, late: [], failed: [] }])
  assert.deepEqual(backupStatus(cfg, {}, NOW), [])
  // guest never backed up → overdue
  assert.deepEqual(backupStatus(cfg, { backups: { data: [{ id: 'pve', items: [] }] } }, NOW)[0].late, ['web', 'db'])
  // filter and failing sources in the summary
  assert.deepEqual(run({ env: 'dev' }).backups.map(x => x.id), ['pve-b'])
  assert.deepEqual(run({ snap: { ...snap, cluster: { data: [] }, backups: { data: [{ id: 'pve', error: 'HTTP 500' }] } } }).sourcesDown, ['sauvegardes pve'])
})

test('status CI: online runners, failing main branches, runs in progress; source error; not filtered', async () => {
  // ci block of the gitea plugin (summary), via the host
  const { createHost } = await import('../lib/plugins/host.js')
  const { default: gitea } = await import('../plugins/gitea/index.js')
  const host = createHost({ cfg, env: { GITEA_URL: 'http://gitea.example.net' }, log: { log() {}, warn() {}, error() {} }, plugins: [gitea] })
  const run = (over = {}) => summary({ cfg, snap, monitor, engine: alertsOf([]), servicesView: () => services, now: NOW, host, ...over })
  const ci = run({ env: 'dev' }).ci
  assert.deepEqual(ci, { configured: true, runnersOnline: 1, runnersTotal: 2, failing: [{ name: 'dash', number: 42, date: '2026-10-28' }], running: 2, error: null })
  assert.deepEqual(run({ snap: { runners: { data: null, error: 'Gitea 502' } } }).ci, { configured: true, runnersOnline: null, runnersTotal: null, failing: [], running: 0, error: 'Gitea 502' })
  // Gitea not configured (collector): configured false, neither error nor counters
  const off = { configured: false, data: null, at: null, error: null }
  assert.deepEqual(run({ snap: { gitea: off, runners: off } }).ci, { configured: false, runnersOnline: null, runnersTotal: null, failing: [], running: 0, error: null })
})

test('status network and meta: network.summary(now) or null; generatedAt and env', () => {
  const s = run({ network: { summary: t => ({ devices: 7, at: t }) } })
  assert.deepEqual(s.network, { devices: 7, at: NOW })
  assert.equal(run().network, null)
  assert.deepEqual([s.generatedAt, s.env], [new Date(NOW).toISOString(), 'all'])
})

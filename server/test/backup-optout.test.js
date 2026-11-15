// Per-guest opt-out of the backup alerts (hosts[].alerts.backups false): a guest deliberately left
// out of the backup jobs raises neither not_backed_up nor backup_late; backup_failed still applies;
// the cockpit and digest figures (backupStatus) leave it out the same way; other guests unchanged;
// schema bounded; check-config warning on a host that is not a VM or LXC.
// Real config parser, real rules, real summary; fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { backupStatus } from '../lib/status.js'

const NOW = Date.parse('2026-11-12T09:00:00Z')
const raw = (alerts, extra = {}) => ({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'lab', label: 'l', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem', backups: { mode: 'tasks', node: 'n1' } }],
  hosts: [
    { id: 'n1', name: 'n1', kind: 'pve-node', pve: 'lab', ip: '192.0.2.40', env: 'prod' },
    { id: 'emu', name: 'emu', kind: 'vm', pve: 'lab', vmid: 241, ip: '192.0.2.41', env: 'dev', ...(alerts !== undefined ? { alerts } : {}), ...extra },
    { id: 'db', name: 'db', kind: 'lxc', pve: 'lab', vmid: 242, ip: '192.0.2.42', env: 'prod' },
  ],
})
const cfgOf = (alerts, extra) => {
  const r = parseConfig(raw(alerts, extra))
  assert.ok(r.config, r.errors?.join('\n'))
  return r.config
}
// emu: excluded from the job, never backed up (or a failed task when `failed`); db: covered, recent
const snap = ({ failed } = {}) => ({
  backups: {
    at: NOW, error: null,
    data: [{
      id: 'lab', mode: 'tasks',
      items: [
        ...(failed ? [{ vmid: 241, last: NOW / 1000 - 3600, failed: true }] : []),
        { vmid: 242, last: NOW / 1000 - 3600, failed: false },
      ],
      coverage: [{ vmid: 241, covered: false, excluded: true }, { vmid: 242, covered: true, excluded: false }],
    }],
  },
})
const BACKUP_RULES = new Set(['backup_late', 'backup_failed', 'not_backed_up'])
const sigs = (cfg, s = snap()) => createRules(cfg, { checks: [], result: () => null }, { hosts: [], get: () => ({ ok: null }) }, null)
  .evaluate(s, NOW)
  .filter(x => BACKUP_RULES.has(x.rule))
  .map(x => [x.key, x.cond])
  .sort()

test('alerts.backups false: no not_backed_up nor backup_late for the guest, the other guest unchanged', () => {
  assert.deepEqual(sigs(cfgOf({ backups: false })), [
    ['backup_failed:db', false],
    ['backup_late:db', false],
    ['not_backed_up:db', false],
  ])
})

test('without the option (absent, alerts without backups, or true): both alerts raised as before', () => {
  const expected = [
    ['backup_failed:db', false],
    ['backup_late:db', false],
    ['backup_late:emu', true],
    ['not_backed_up:db', false],
    ['not_backed_up:emu', true],
  ]
  assert.deepEqual(sigs(cfgOf(undefined)), expected)
  assert.deepEqual(sigs(cfgOf({ ports: false })), expected)
  assert.deepEqual(sigs(cfgOf({ backups: true })), expected)
})

test('alerts.backups false: a failed backup task of the guest is still reported', () => {
  const got = sigs(cfgOf({ backups: false }), snap({ failed: true }))
  assert.deepEqual(got.filter(([k]) => k.endsWith(':emu')), [['backup_failed:emu', true]])
})

test('schema: a boolean only; check-config warns on a host that is not a VM or LXC', () => {
  for (const bad of ['no', 0, null, {}]) {
    const r = parseConfig(raw({ backups: bad }))
    assert.equal(r.config, undefined, `refused: ${JSON.stringify(bad)}`)
    assert.match(r.errors.join('\n'), /backups/)
  }
  assert.deepEqual(parseConfig(raw({ backups: false })).warnings?.filter(w => /alerts\.backups/.test(w)) ?? [], [])
  const node = raw(undefined)
  node.hosts[0].alerts = { backups: false }
  assert.deepEqual(parseConfig(node).warnings.filter(w => /alerts\.backups/.test(w)), ['host n1: alerts.backups on a host that is not a VM or LXC (ignored)'])
})

test('cockpit and digest figures (backupStatus) follow the alerts: opted-out guest not counted, unless its backup failed', () => {
  const pick = b => ({ total: b.total, ok: b.ok, late: b.late, failed: b.failed })
  assert.deepEqual(pick(backupStatus(cfgOf(undefined), snap(), NOW)[0]), { total: 2, ok: 1, late: ['emu'], failed: [] })
  assert.deepEqual(pick(backupStatus(cfgOf({ backups: false }), snap(), NOW)[0]), { total: 1, ok: 1, late: [], failed: [] })
  assert.deepEqual(pick(backupStatus(cfgOf({ backups: false }), snap({ failed: true }), NOW)[0]), { total: 2, ok: 1, late: [], failed: ['emu'] })
  // unreadable source: the opted-out guest is not counted either
  const err = backupStatus(cfgOf({ backups: false }), { backups: { data: [{ id: 'lab', error: 'HTTP 500' }] } }, NOW)[0]
  assert.equal(err.total, 1)
})

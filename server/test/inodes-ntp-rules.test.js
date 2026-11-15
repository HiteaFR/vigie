// Inodes (guest_inodes, key separate from guest_disk, same thresholds) and NTP clock
// (time_unsynced, warning, forSec 30 min) from agent v8. Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast, cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { clientBundle } from './client-render.js'

const NOW = Date.parse('2026-11-05T07:00:00Z')
const RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'p1', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', env: 'prod', agent: 'ssh' },
    { id: 'd1', name: 'docker-lab', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', env: 'dev', agent: 'ssh' },
  ],
}
const CFG = parseConfig(RAW).config
const fs = (mount, ipct, extra = {}) => ({ mount, type: 'ext4', size: 100, used: 10, avail: 90, inodes: ipct == null ? null : { total: 1000, used: Math.round(ipct * 10) }, ...extra })
const fast = (version, fsList) => cleanFast({ version, ts: Math.floor(NOW / 1000), fs: fsList, reboot: { required: false } })
// time is in the slow report (v8 form confirmed by infra)
const slowT = (version, ntp) => cleanSlow({ version, ts: Math.floor(NOW / 1000), time: { ntpSynced: ntp } })
const sigs = (states, cfg = CFG) => {
  const all = createRules(cfg, { checks: [], result: () => null }, { hosts: cfg.hosts, get: id => states[id] ?? { ok: null } }, null).evaluate({}, NOW)
  return k => all.find(x => x.key === k)
}
const live = (f, s = null) => ({ ok: true, at: NOW, fast: f, slow: s })

test('guest_inodes: thresholds of alerts.disk (85 / 95), 2-point hysteresis, critical in prod, warning in dev; guest_disk unchanged', () => {
  const by = sigs({ p1: live(fast(8, [fs('/', 96), fs('/var', 86), fs('/srv', 84), fs('/tmp', 82)])), d1: live(fast(8, [fs('/', 97)])) })
  assert.deepEqual([by('guest_inodes:p1:/').cond, by('guest_inodes:p1:/').severity, by('guest_inodes:p1:/').detail], [true, 'critical', '96 % des inodes utilisés'])
  assert.deepEqual([by('guest_inodes:p1:/var').cond, by('guest_inodes:p1:/var').severity], [true, 'warning'])
  assert.equal(by('guest_inodes:p1:/srv').cond, null) // between 83 and 85: hysteresis
  assert.equal(by('guest_inodes:p1:/tmp').cond, false)
  assert.equal(by('guest_inodes:d1:/').severity, 'warning') // dev capped
  assert.deepEqual(by('guest_inodes:p1:/').parents, ['agent_unreachable:p1', 'guest_stopped:p1', 'pve_unreachable:prod'])
  // one alert per measurement: the disk of the same FS keeps its own key, unchanged
  assert.deepEqual([by('guest_disk:p1:/').cond, by('guest_disk:p1:/').detail], [false, '10 % utilisés'])
  // configurable thresholds (the same as the disk)
  const cfg = parseConfig({ ...RAW, alerts: { disk: { warnPct: 50, critPct: 60 } } }).config
  assert.equal(sigs({ p1: live(fast(8, [fs('/', 55)])) }, cfg)('guest_inodes:p1:/').cond, true)
})

test('guest_inodes: null inodes or zero total (btrfs, tmpfs) → no information; v7 → no signal', () => {
  const by = sigs({ p1: live(fast(8, [fs('/', null), { ...fs('/b', 0), inodes: { total: 0, used: 0 } }])), d1: live(fast(7, [fs('/', 99)])) })
  assert.equal(by('guest_inodes:p1:/').cond, null)
  assert.equal(by('guest_inodes:p1:/b').cond, null)
  assert.equal(by('guest_inodes:d1:/'), undefined)
})

test('time_unsynced: warning in prod as in dev, forSec 30 min; null does not alert; v7 → no signal; agent down → nothing', () => {
  const by = sigs({ p1: live(fast(8, []), slowT(8, false)), d1: live(fast(8, []), slowT(8, false)) })
  for (const id of ['p1', 'd1']) {
    const s = by(`time_unsynced:${id}`)
    assert.deepEqual([s.cond, s.severity, s.forSec, s.detail], [true, 'warning', 1800, 'horloge non synchronisée par NTP'], id)
  }
  assert.deepEqual(by('time_unsynced:p1').parents, ['agent_unreachable:p1', 'guest_stopped:p1', 'pve_unreachable:prod'])
  assert.equal(sigs({ p1: live(fast(8, []), slowT(8, true)) })('time_unsynced:p1').cond, false)
  assert.equal(sigs({ p1: live(fast(8, []), slowT(8, null)) })('time_unsynced:p1').cond, null)
  assert.equal(sigs({ p1: live(fast(8, []), slowT(7, false)) })('time_unsynced:p1'), undefined)
  assert.equal(sigs({ p1: live(fast(8, []), null) })('time_unsynced:p1'), undefined)
  const down = sigs({ p1: { ok: false, at: NOW - 3600_000, error: 'timeout', fast: fast(8, [fs('/', 99)]), slow: slowT(8, false) } })
  assert.equal(down('time_unsynced:p1'), undefined)
  assert.equal(down('guest_inodes:p1:/'), undefined)
})

const client = t => clientBundle(t, 'l12-ino', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import HostDrawer from './src/HostDrawer.jsx'",
  'export function drawer(seed) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/", ssrSearch: "h=p1" }, h(AdminProvider, null, h(HostDrawer)))))',
  '}',
])

test('drawer: inodes per FS (known only), clock synchronized, not synchronized or unknown', async t => {
  const c = await client(t)
  if (!c) return
  const mk = (version, list, ntp) => {
    const f = cleanFast({ version, ts: Math.floor(Date.now() / 1000), uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: list, systemd: { failed: [], watched: [] }, reboot: { required: false } })
    return c.drawer({ agents: { hosts: [{ id: 'p1', name: 'pihole', kind: 'lxc', agent: 'ssh', ok: true, at: Date.now(), fast: f, slow: slowT(version, ntp) }] } })
  }
  const d = mk(8, [fs('/', 96), fs('/var', 40), fs('/b', null)], false)
  assert.match(d, /inodes : <span class="mr-2 text-crit">\/ 96 %<\/span><span class="mr-2 ">\/var 40 %<\/span><\/p>/)
  assert.match(d, /horloge <span class="text-warn">non synchronisée<\/span>/)
  assert.match(mk(8, [fs('/', 10)], true), / · horloge synchronisée/)
  const v7 = mk(7, [fs('/', 96)], true)
  assert.match(v7, / · horloge inconnue/)
  assert.doesNotMatch(v7, /inodes :/)
})

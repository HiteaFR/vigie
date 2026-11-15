// Services to restart (needrestart, v8 agent): restart_required rule (info),
// digest line, host drawer. Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow, cleanFast } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createUpdates } from '../lib/updates/index.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest } from '../lib/notify/digest.js'
import { tmpStore } from './tmpdir.js'
import { clientBundle } from './client-render.js'

const H = 3600_000
const NOW = Date.parse('2026-11-05T07:00:00Z')
const CFG = parseConfig({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: ['alpha', 'bravo', 'charlie'].map((id, i) => ({ id, name: id, kind: 'lxc', pve: 'prod', vmid: 201 + i, ip: `192.0.2.${11 + i}`, env: i === 1 ? 'dev' : 'prod', agent: 'ssh' })),
}).config
const units = n => Array.from({ length: n }, (_, i) => `svc${i}.service`)
const slow = (version, u = [], processes = 0) => cleanSlow({ version, ts: Math.floor(NOW / 1000), restart: { units: u, processes } })
const live = (s, ageH = 0.2) => ({ ok: true, at: NOW, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow: s, slowAt: NOW - ageH * H })
const sigs = states => {
  const all = createRules(CFG, { checks: [], result: () => null }, { hosts: CFG.hosts, get: id => states[id] ?? { ok: null } }, null).evaluate({}, NOW)
  return k => all.find(x => x.key === k)
}

test('restart_required: info, 5 units at most then "+N", parents agent then host; nothing to restart → false', () => {
  const by = sigs({ alpha: live(slow(8, units(7))), bravo: live(slow(8, ['nginx.service'])), charlie: live(slow(8, [])) })
  const a = by('restart_required:alpha')
  assert.deepEqual([a.cond, a.severity, a.detail], [true, 'info', 'svc0.service, svc1.service, svc2.service, svc3.service, svc4.service (+2)'])
  assert.deepEqual(a.parents, ['agent_unreachable:alpha', 'guest_stopped:alpha', 'pve_unreachable:prod'])
  assert.deepEqual([by('restart_required:bravo').cond, by('restart_required:bravo').detail], [true, 'nginx.service'])
  assert.deepEqual([by('restart_required:charlie').cond, by('restart_required:charlie').detail], [false, null])
})

test('restart_required: v7, v6, missing block or unreachable agent → no information (cond null)', () => {
  const by = sigs({ alpha: live(slow(7, units(3))), bravo: live(cleanSlow({ version: 8, ts: 1 })), charlie: { ok: false, at: NOW - H, error: 'timeout', fast: null, slow: slow(8, units(3)), slowAt: NOW } })
  for (const id of ['alpha', 'bravo']) assert.equal(by(`restart_required:${id}`).cond, null, id)
  assert.equal(by('restart_required:charlie').cond, null) // unreachable agent: no information, no avalanche
})

function updatesWith(t, states) {
  const upstream = { github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [], errors: () => [], stats: () => ({}) }
  return createUpdates({ cfg: CFG, store: tmpStore('dash-l12-', t), agents: { hosts: CFG.hosts, get: id => states[id] ?? { ok: null } }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
}

test('digest: one "services to restart" line, host by host; report older than 2 h or v7: not counted; none: nothing', t => {
  const u = updatesWith(t, { alpha: live(slow(8, ['nginx.service', 'php8.4-fpm.service', 'cron.service', 'ssh.service'])), bravo: live(slow(8, ['unbound.service'])), charlie: live(slow(8, ['x.service']), 3) })
  assert.deepEqual(u.digestLines({ now: NOW }).filter(l => l.startsWith('🔁')), ['🔁 Services à redémarrer sur 2 hôtes : alpha (nginx, php8.4-fpm, cron +1) · bravo (unbound)'])
  const none = updatesWith(t, { alpha: live(slow(8, [])), bravo: live(slow(7, ['x.service'])) })
  assert.deepEqual(none.digestLines({ now: NOW }).filter(l => l.startsWith('🔁')), [])
})

test('full digest: restart_required on its own line, not in the active alerts list', async t => {
  const store = tmpStore('dash-l12-digest-', t)
  const states = { alpha: live(slow(8, ['nginx.service'])) }
  const agents = { hosts: CFG.hosts, get: id => states[id] ?? { ok: null } }
  const u = updatesWith(t, states)
  const clock = createClock('Europe/Paris')
  const engine = createEngine({ cfg: CFG, store, rules: createRules(CFG, { checks: [], result: () => null }, agents, u), notifier: { enqueue: () => 'digest' }, clock, startedAt: NOW - 5 * H })
  engine.evaluate({}, NOW)
  engine.evaluate({}, NOW + 1000)
  assert.ok(engine.active().some(a => a.key === 'restart_required:alpha' && a.state === 'firing'))
  const d = buildDigest({ cfg: CFG, engine, snap: {}, monitor: { checks: [] }, formatter: createFormatter({ dashboardUrl: null, clock }), clock, updates: u, now: NOW })
  assert.match(d, /🔁 Services à redémarrer sur 1 hôte : alpha \(nginx\)/)
  assert.doesNotMatch(d, /Services à redémarrer · alpha/)
  assert.match(d, /✅ Aucune alerte active/)
})

const client = t => clientBundle(t, 'l12-restart', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import HostDrawer from './src/HostDrawer.jsx'",
  'export function drawer(seed) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/", ssrSearch: "h=alpha" }, h(AdminProvider, null, h(HostDrawer)))))',
  '}',
])

test('host drawer: services to restart listed (8 at most); v7: nothing', async t => {
  const c = await client(t)
  if (!c) return
  const fast = cleanFast({ version: 8, ts: Math.floor(Date.now() / 1000), uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false } })
  const host = s => ({ agents: { hosts: [{ id: 'alpha', name: 'alpha', kind: 'lxc', agent: 'ssh', ok: true, at: Date.now(), fast, slow: s, slowAt: Date.now() }] } })
  assert.match(c.drawer(host(slow(8, units(10)))), /Services à redémarrer : <span class="font-mono">svc0\.service, svc1\.service, svc2\.service, svc3\.service, svc4\.service, svc5\.service, svc6\.service, svc7\.service \(\+2\)<\/span>/)
  assert.doesNotMatch(c.drawer(host(slow(8, []))), /Services à redémarrer/)
  assert.doesNotMatch(c.drawer(host(slow(7, units(3)))), /Services à redémarrer/)
})

test('second barrier: an UNCLEANED v7 report carrying restart gives no alert, no digest line and no drawer list', async t => {
  const raw = { version: 7, ts: Math.floor(NOW / 1000), restart: { units: ['nginx.service'], processes: 1 } }
  assert.equal(sigs({ alpha: live(raw) })('restart_required:alpha').cond, null)
  assert.deepEqual(updatesWith(t, { alpha: live(raw) }).digestLines({ now: NOW }).filter(l => l.startsWith('🔁')), [])
  const c = await client(t)
  if (!c) return
  const fast = cleanFast({ version: 8, ts: Math.floor(Date.now() / 1000), uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false } })
  const html = c.drawer({ agents: { hosts: [{ id: 'alpha', name: 'alpha', kind: 'lxc', agent: 'ssh', ok: true, at: Date.now(), fast, slow: raw, slowAt: Date.now() }] } })
  assert.doesNotMatch(html, /Services à redémarrer/)
})

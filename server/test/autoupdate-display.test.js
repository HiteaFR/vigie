// "auto updates" state per host (active, disabled, failed, unknown in v6), computed
// by the server with the rule criteria, and shown on the Updates page and in the host
// drawer. Dummy data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow, cleanFast, createAgents } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { autoUpdateStatus } from '../lib/updates/autostatus.js'
import { clientBundle } from './client-render.js'

const H = 3600_000
const NOW = Date.parse('2026-11-05T07:00:00Z')
const ts = Math.floor(NOW / 1000)
const PVE = [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }]
const au = o => ({ installed: true, enabled: true, securityOnly: true, lastRunAt: ts - 4 * 3600, lastResult: 'success', applied: [{ name: 'openssl', version: '3.0.17-1~deb12u3' }], ...o })
const v7 = o => cleanSlow({ version: 7, ts, apt: { listsAt: ts, upgradable: 0, security: 0, packages: [] }, autoUpdate: au(o) })
const CASES = {
  actives: [v7(), 'active', null],
  jamais: [v7({ lastRunAt: null, lastResult: null }), 'active', 'aucun passage enregistré pour l\'instant'],
  absent: [v7({ installed: false }), 'off', 'unattended-upgrades absent'],
  coupees: [v7({ enabled: false }), 'off', null],
  horsSecu: [v7({ securityOnly: false }), 'off', 'pas limitées à la sécurité'],
  echec: [v7({ lastResult: 'failed' }), 'failed', null],
  vieux: [v7({ lastRunAt: ts - 49 * 3600 }), 'failed', 'aucun passage depuis plus de 2 j'],
  v6: [cleanSlow({ version: 6, ts, autoUpdate: au() }), 'unknown', 'agent sans suivi des MAJ auto (v6)'],
  sansBloc: [cleanSlow({ version: 7, ts }), 'unknown', 'apt absent ou état non remonté'],
  rien: [null, 'unknown', 'pas encore de rapport de l\'agent'],
}

test('auto update state: active, disabled, failed, unknown (v6); detail without repetition', () => {
  for (const [k, [slow, state, detail]] of Object.entries(CASES)) {
    const s = autoUpdateStatus(slow, { now: NOW, maxAgeHours: 48 })
    assert.deepEqual([s.state, s.detail], [state, detail], k)
    if (slow?.autoUpdate) assert.deepEqual([s.lastRunAt, s.lastResult, s.applied], [slow.autoUpdate.lastRunAt, slow.autoUpdate.lastResult, slow.autoUpdate.applied], k)
  }
  assert.equal(autoUpdateStatus(v7({ lastRunAt: ts - 30 * 3600 }), { now: NOW, maxAgeHours: 24 }).state, 'failed')
})

test('auto update state = rules: off ⇔ autoupdate_off; failed ⇔ autoupdate_failed (never run: active on screen, alert after the delay)', () => {
  const cfg = parseConfig({
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' }, proxmox: PVE,
    hosts: [{ id: 'h', name: 'h', kind: 'lxc', pve: 'prod', vmid: 201, ip: '192.0.2.5', env: 'prod', agent: 'ssh' }],
  }).config
  for (const [k, [slow, state]] of Object.entries(CASES)) {
    if (!slow) continue
    const st = { ok: true, at: NOW, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow, slowAt: NOW }
    // auto updates seen active for 49 h (agent memory): "never run" raises without waiting
    const sigs = createRules(cfg, { checks: [], result: () => null }, { hosts: cfg.hosts, get: () => st }, null, null, null, { autoActiveSince: () => NOW - 49 * 3600_000 }).evaluate({}, NOW)
    const off = sigs.find(s => s.key === 'autoupdate_off:h')
    const failed = sigs.find(s => s.key === 'autoupdate_failed:h')
    assert.equal(off.cond === true, state === 'off', `${k}: off`)
    if (k === 'jamais') assert.deepEqual([failed.cond, failed.forSec], [true, undefined])
    else assert.equal(failed.cond === true, state === 'failed', `${k}: failed`)
    if (state === 'unknown') assert.deepEqual([off.cond, failed.cond], [null, null], k)
  }
})

test('/api/agents: autoUpdate for hosts with an agent only (unknown before the first report)', () => {
  const cfg = parseConfig({
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' }, proxmox: PVE,
    hosts: [{ id: 'a', name: 'a', kind: 'lxc', pve: 'prod', vmid: 201, ip: '192.0.2.5', env: 'prod', agent: 'ssh' }, { id: 'b', name: 'b', kind: 'vm', pve: 'prod', vmid: 202, ip: '192.0.2.6', env: 'prod' }],
  }).config
  const view = createAgents(cfg, { DASHREPORT_SSH_KEY: '/nonexistent/key' }).view()
  assert.deepEqual(view.find(h => h.id === 'a').autoUpdate, { state: 'unknown', detail: 'pas encore de rapport de l\'agent' })
  assert.equal(view.find(h => h.id === 'b').autoUpdate, undefined)
})

// --- real rendering (Updates page, host drawer) ---------------------------------------------
const client = t => clientBundle(t, 'l9-display', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import Updates from './src/views/Updates.jsx'",
  "import HostDrawer from './src/HostDrawer.jsx'",
  "import { AutoUpdateInfo } from './src/components/AutoUpdate.jsx'",
  'export function render(el, { seed = {}, path = "/", search = "" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path, ssrSearch: search }, h(AdminProvider, null, el))))',
  '}',
  'export const updates = o => render(h(Updates), o)',
  'export const drawer = o => render(h(HostDrawer), o)',
  'export const info = s => renderToStaticMarkup(h(AutoUpdateInfo, { s }))',
])
const st = k => autoUpdateStatus(CASES[k][0], { now: NOW, maxAgeHours: 48 })
const aptComp = (host, s, upgradable = 1) => ({
  id: `apt:${host}`, name: 'Paquets apt', kind: 'apt', host, where: `CT · ${host}`, env: 'prod', current: `${upgradable} en attente`, latest: null,
  gap: upgradable ? 'patch' : 'same', security: !!upgradable, apt: { upgradable, security: upgradable, held: 0, ageDays: 0, autoUpdate: s },
})
const SEED = {
  updates: { checkedAt: new Date(NOW).toISOString(), counts: {}, sources: [], stats: null, components: [
    aptComp('alpha', st('actives')), aptComp('bravo', st('coupees')), aptComp('charlie', st('echec'), 0), aptComp('delta', st('v6')),
  ] },
  agents: { hosts: ['alpha', 'bravo', 'charlie', 'delta'].map(id => ({ id, name: id, kind: 'lxc', agent: 'ssh' })) },
  session: { admin: false },
}

test('Updates page: badge per apt row, summary per host (up to date included), problems first', async t => {
  const c = await client(t)
  if (!c) return
  const html = c.updates({ seed: SEED })
  const row = id => html.split('<li ').find(x => x.includes(`CT · ${id}`)) ?? ''
  assert.match(row('alpha'), /text-ok[^"]*"[^>]*title="MAJ auto actives"><svg[\s\S]*?<\/svg>MAJ auto actives<\/span>/)
  assert.match(row('bravo'), /text-warn[^"]*"[^>]*><svg[\s\S]*?<\/svg>MAJ auto désactivées<\/span>/)
  assert.match(row('delta'), /title="agent sans suivi des MAJ auto \(v6\)"><svg[\s\S]*?<\/svg>MAJ auto : inconnu<\/span>/)
  // charlie is up to date (hidden from the list) but present in the summary, first (failed)
  assert.doesNotMatch(html, /CT · charlie/)
  const sum = html.slice(html.indexOf('MAJ de sécurité automatiques :'))
  const order = ['en échec', 'désactivées', 'actives', 'inconnu'].map(w => sum.indexOf(`>${w}</span>`))
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order))
  assert.match(sum, />en échec<\/span><span><button type="button"[^>]*>charlie<\/button>/)
  // no tracked host (all in v6): no summary
  const v6only = c.updates({ seed: { ...SEED, updates: { ...SEED.updates, components: [aptComp('delta', st('v6'))] } } })
  assert.doesNotMatch(v6only, /MAJ de sécurité automatiques/)
})

test('detail: last run, result, applied packages (8 at most); host drawer', async t => {
  t.mock.method(Date, 'now', () => NOW) // this rendering depends on the clock: without this, the test breaks once NOW is past
  const c = await client(t)
  if (!c) return
  const many = autoUpdateStatus(v7({ applied: Array.from({ length: 11 }, (_, i) => ({ name: `p${i}`, version: '1' })) }), { now: NOW })
  assert.match(c.info(many), /MAJ auto actives<\/span>\.<\/p><p>Dernier passage <time[^>]*>[^<]*<\/time>, réussi : p0, p1, p2, p3, p4, p5, p6, p7 \(\+3\)\./)
  assert.match(c.info(st('echec')), /MAJ auto en échec<\/span>\.<\/p><p>Dernier passage <time[^>]*>[^<]*<\/time>, en échec : openssl\./)
  assert.match(c.info(st('vieux')), /MAJ auto en échec<\/span> : aucun passage depuis plus de 2 j\./)
  assert.match(c.info(st('jamais')), /MAJ auto actives<\/span> : aucun passage enregistré pour l&#x27;instant\.<\/p><\/div>$/)
  assert.match(c.info(st('v6')), /MAJ auto : inconnu<\/span> : agent sans suivi des MAJ auto \(v6\)\./)
  assert.equal(c.info(null), '')
  // host drawer: in the apt packages section
  const fast = cleanFast({ version: 7, ts, uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false } })
  const host = { id: 'alpha', name: 'alpha', kind: 'lxc', agent: 'ssh', ok: true, at: NOW, fast,
    slow: CASES.actives[0], slowAt: NOW, autoUpdate: st('actives') }
  const d = c.drawer({ seed: { agents: { hosts: [host] } }, search: 'h=alpha' })
  assert.match(d, /Paquets apt[\s\S]*MAJ auto actives<\/span>\.<\/p><p>Dernier passage/)
})

test('/api/updates: the "Paquets apt" row of each host carries its auto update state', async t => {
  const { createUpdates } = await import('../lib/updates/index.js')
  const { tmpStore } = await import('./tmpdir.js')
  const cfg = parseConfig({
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' }, proxmox: PVE,
    hosts: ['a', 'b', 'c'].map((id, i) => ({ id, name: id, kind: 'lxc', pve: 'prod', vmid: 201 + i, ip: `192.0.2.${5 + i}`, env: 'prod', agent: 'ssh' })),
    alerts: { autoUpdateMaxAgeHours: 24 },
  }).config
  // the state is computed at the real time of the refresh: runs dated from now
  const real = Math.floor(Date.now() / 1000)
  const slows = { a: v7({ lastRunAt: real - 4 * 3600 }), b: v7({ lastRunAt: real - 30 * 3600 }), c: CASES.v6[0] }
  const agents = { hosts: cfg.hosts, get: id => ({ ok: true, at: Date.now(), fast: { osId: 'debian', docker: null }, slow: { ...slows[id], apt: { listsAt: ts, upgradable: 0, security: 0, packages: [] } } }) }
  const upstream = { github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [], errors: () => [], stats: () => ({}) }
  const u = createUpdates({ cfg, store: tmpStore('dash-l9-upd-', t), agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  await u.refresh()
  const st = id => u.view().components.find(c => c.id === `apt:${id}`).apt.autoUpdate
  assert.equal(st('a').state, 'active')
  assert.deepEqual([st('b').state, st('b').detail], ['failed', 'aucun passage depuis plus de 24 h'], 'threshold from the config')
  assert.equal(st('c').state, 'unknown')
})

// Digest of automatic security updates. Dummy "overnight" data: v7 agents
// with and without applied fixes, a v6 host, and pending fixes blocked or not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createUpdates } from '../lib/updates/index.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock, fmtDuration } from '../lib/clock.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest } from '../lib/notify/digest.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const NOW = Date.parse('2026-11-05T07:00:00Z') // 08:00 in Paris: digest time
const RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'p1', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', env: 'prod', agent: 'ssh' },
    { id: 'd1', name: 'docker-lab', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.231', env: 'dev', agent: 'ssh' },
    { id: 'g1', name: 'gitea', kind: 'lxc', pve: 'prod', vmid: 106, ip: '192.0.2.143', env: 'prod', agent: 'ssh' },
  ],
}
const CFG = parseConfig(RAW).config
const pkg = (name, suite = 'bookworm-security') => ({ name, suite, version: '1.0-1+deb12u1', from: '1.0-1', held: false })
const v7 = ({ ranH = 4, applied = [], packages = [], au = {} } = {}) => cleanSlow({
  version: 7, ts: Math.floor(NOW / 1000),
  apt: { listsAt: Math.floor(NOW / 1000), upgradable: packages.length, security: packages.length, packages },
  autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: ranH == null ? null : Math.floor((NOW - ranH * H) / 1000), lastResult: 'success', applied, ...au },
})
const v6 = (packages = []) => cleanSlow({ version: 6, ts: Math.floor(NOW / 1000), apt: { listsAt: Math.floor(NOW / 1000), upgradable: packages.length, security: packages.length, packages } })
const ap = (...names) => names.map(name => ({ name, version: '1.0-2' }))

function bench(t, slows) {
  const store = tmpStore('dash-l9-digest-', t)
  const states = Object.fromEntries(Object.entries(slows).map(([id, slow]) => [id, { ok: true, at: NOW, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null, osId: 'debian' }, slow, slowAt: NOW }]))
  const agents = { hosts: CFG.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }
  const upstream = { github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [], errors: () => [], stats: () => ({}) }
  const updates = createUpdates({ cfg: CFG, store, agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  return { store, agents, states, updates }
}
// auto update lines: the last ones of digestLines, starting from the one that begins with 🛡
const lines = (u, now = NOW) => { const all = u.digestLines({ now }); const i = all.findIndex(l => l.startsWith('🛡')); return i < 0 ? [] : all.slice(i) }

test('digest: fixes applied last night, one line per host, 5 packages at most', t => {
  const { updates } = bench(t, {
    p1: v7({ applied: ap('openssl', 'libssl3', 'curl', 'libcurl4', 'bash', 'tzdata', 'zlib1g') }),
    d1: v7({ ranH: 6, applied: ap('nginx') }),
    g1: v7({ ranH: 30, applied: ap('git') }), // run older than 24 h: not "last night"
  })
  assert.deepEqual(lines(updates), [
    '🛡 8 correctifs de sécurité appliqués cette nuit sur 2 hôtes',
    '  pihole : openssl, libssl3, curl, libcurl4, bash (+2)',
    '  docker-lab : nginx',
  ])
})

test('digest: night without fixes → one line saying so; no host on auto updates (v6, turned off) → no line', t => {
  assert.deepEqual(lines(bench(t, { p1: v7(), d1: v7({ applied: [] }), g1: v6() }).updates), ['🛡 Aucun correctif de sécurité appliqué cette nuit (2 hôtes en MAJ auto)'])
  assert.deepEqual(lines(bench(t, { p1: v6([pkg('openssl')]), d1: v6(), g1: v7({ au: { enabled: false }, applied: ap('curl') }) }).updates), [])
  // run dated in the future (host clock) or never run: not counted
  assert.deepEqual(lines(bench(t, { p1: v7({ ranH: -2, applied: ap('curl') }), d1: v7({ ranH: null, applied: ap('bash') }) }).updates), ['🛡 Aucun correctif de sécurité appliqué cette nuit (2 hôtes en MAJ auto)'])
  // exactly 24 h: counted; just beyond: not
  assert.equal(lines(bench(t, { p1: v7({ ranH: 24, applied: ap('curl') }) }).updates)[0], '🛡 1 correctif de sécurité appliqué cette nuit sur 1 hôte')
  assert.match(lines(bench(t, { p1: v7({ ranH: 24.01, applied: ap('curl') }) }).updates)[0], /Aucun/)
})

test('full digest: auto updates active → no more list of pending fixes, only the blocked ones; v6 unchanged', async t => {
  const { store, agents, states, updates } = bench(t, {
    p1: v7({ packages: [pkg('openssl'), pkg('curl')] }), // pending: openssl blocked, curl recent
    d1: v7({ packages: [pkg('bash')], applied: ap('libc6') }), // recent pending: nothing
    g1: v6([pkg('git'), pkg('perl')]), // v6: previous behaviour (info, count)
  })
  // dating: openssl seen 60 h ago (older report), curl and bash just now
  // (the other hosts have not sent any report yet at -60 h)
  const later = { d1: states.d1, g1: states.g1 }
  states.d1 = { ...states.d1, slow: null, slowAt: null }
  states.g1 = { ...states.g1, slow: null, slowAt: null }
  states.p1 = { ...states.p1, slow: v7({ packages: [pkg('openssl')] }), slowAt: NOW - 60 * H }
  states.p1.slow.ts = Math.floor((NOW - 60 * H) / 1000)
  updates.observePending(NOW - 60 * H)
  Object.assign(states, later)
  states.p1 = { ...states.p1, slow: v7({ packages: [pkg('openssl'), pkg('curl')] }), slowAt: NOW }
  updates.observePending(NOW)
  const clock = createClock('Europe/Paris')
  const sent = []
  const engine = createEngine({ cfg: CFG, store, rules: createRules(CFG, { checks: [], result: () => null }, agents, updates), notifier: { enqueue: (k, st) => { sent.push(st.key); return 'digest' } }, clock, startedAt: NOW - 5 * H })
  engine.evaluate({}, NOW)
  engine.evaluate({}, NOW + 1000)
  const d = buildDigest({ cfg: CFG, engine, snap: {}, monitor: { checks: [] }, formatter: createFormatter({ dashboardUrl: null, clock }), clock, updates, now: NOW })
  assert.ok(d.includes(`<b>Mises à jour de sécurité · pihole</b> · depuis 1 min\nbloqué depuis ${fmtDuration(60 * H)} : openssl\n`), d)
  assert.doesNotMatch(d, /curl|bash/, 'pending fixes not blocked: absent from the digest')
  assert.doesNotMatch(d, /docker-lab — /)
  assert.match(d, /Mises à jour de sécurité · gitea<\/b> · depuis 1 min\n2 de sécurité sur 2 en attente/, 'v6: as before')
  assert.match(d, /🛡 1 correctif de sécurité appliqué cette nuit sur 1 hôte\n<blockquote>docker-lab : libc6<\/blockquote>/)
  // names escaped by the digest (already validated by the allow list)
  assert.doesNotMatch(d, /<img|<script/)
})

test('auto update digest in English (en catalogue); French stays as in the tests above', async t => {
  const { setLocale } = await import('../lib/i18n.js')
  const night = bench(t, { p1: v7({ applied: ap('openssl', 'curl') }), d1: v7({ ranH: 6, applied: ap('nginx') }) }).updates
  const quiet = bench(t, { p1: v7(), d1: v7({ applied: [] }) }).updates
  const one = bench(t, { p1: v7({ ranH: 24, applied: ap('curl') }) }).updates
  setLocale('en')
  try {
    assert.deepEqual(lines(night), ['🛡 3 security fixes applied last night on 2 hosts', '  pihole : openssl, curl', '  docker-lab : nginx'])
    assert.deepEqual(lines(quiet), ['🛡 No security fix applied last night (2 hosts on auto updates)'])
    assert.equal(lines(one)[0], '🛡 1 security fix applied last night on 1 host')
  } finally {
    setLocale('fr')
  }
})

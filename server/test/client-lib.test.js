// Pure modules of client/src/lib/ that had no test (alerts, deviceTypes,
// hosts, netKeys, state, storage) and uncovered parts of agent and format. Imported directly
// (node:test, no new dependency); fake Date.now and localStorage.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULE_LABEL } from '../../client/src/lib/alerts.js'
import { hostLabel } from '../../client/src/lib/hosts.js'
import { netKeys } from '../../client/src/lib/netKeys.js'
import { STATES, stateOf, RANK } from '../../client/src/lib/state.js'
import { load, save } from '../../client/src/lib/storage.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')
import { titleOf, DEFAULT_TITLE } from '../../client/src/lib/title.js'
import { fsPct, agentSummary, since } from '../../client/src/lib/agent.js'
import { pct, bytes, uptime, duration, fmtUptime } from '../../client/src/lib/format.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NOW = Date.parse('2026-10-29T10:00:00Z')
const MIN = 60_000
const H = 3600_000
const DAY = 86400_000

test('alerts: every rule emitted by the server has a label, and each label matches a rule', () => {
  const src = f => fs.readFileSync(path.join(ROOT, 'server/lib', f), 'utf8')
  // plus the plugin rules (server/plugins/<id>/)
  // plus channel_error (notify/notifier.js)
  const files = ['alerts/rules.js', 'updates/index.js', 'network/rules.js', 'plugins/host.js', 'notify/notifier.js', '../plugins/gitea/index.js'].filter(f => fs.existsSync(path.join(ROOT, 'server/lib', f)))
  const rules = new Set(files.flatMap(f => [...src(f).matchAll(/rule: '([a-z_]+)'/g)].map(m => m[1])))
  assert.ok(rules.size >= 25, `${rules.size} rules read`)
  for (const [k, v] of Object.entries(RULE_LABEL)) {
    assert.ok(rules.has(k), `label without a rule: ${k}`)
    assert.ok(typeof v === 'string' && v.length > 2, k)
  }
  assert.deepEqual([...rules].filter(r => !RULE_LABEL[r]).sort(), [], 'rule without a label')
  assert.deepEqual([RULE_LABEL.net_new, RULE_LABEL.net_down, RULE_LABEL.net_ip_changed, RULE_LABEL.net_new_flood, RULE_LABEL.net_mac_added], ['Nouvel appareil', 'Appareil hors ligne', 'IP changée', "Afflux d'appareils", 'MAC ajoutée'])
})

test('hosts: "CT 205 · pve", "VM 200 · pve-b" (node name, otherwise cluster id), appliance by its name, nothing without host', () => {
  const hosts = [{ id: 'n1', kind: 'pve-node', pve: 'prod', name: 'pve' }, { id: 'n2', kind: 'pve-node', pve: 'dev', name: 'pve-b' }]
  assert.equal(hostLabel({ kind: 'lxc', vmid: 205, pve: 'prod' }, hosts), 'CT 205 · pve')
  assert.equal(hostLabel({ kind: 'vm', vmid: 200, pve: 'dev' }, hosts), 'VM 200 · pve-b')
  assert.equal(hostLabel({ kind: 'vm', vmid: 7, pve: 'autre' }, hosts), 'VM 7 · autre')
  assert.equal(hostLabel({ kind: 'vm', vmid: 7, pve: 'prod' }, undefined), 'VM 7 · prod')
  assert.equal(hostLabel({ kind: 'appliance', name: 'NAS' }, hosts), 'NAS')
  assert.equal(hostLabel(null, hosts), null)
})

test('netKeys: network view, plus the device record (encoded id) if given', () => {
  assert.deepEqual(netKeys(), ['network'])
  assert.deepEqual(netKeys(''), ['network'])
  assert.deepEqual(netKeys(42), ['network', '/api/network/devices/42'])
  assert.deepEqual(netKeys('a b/c'), ['network', '/api/network/devices/a%20b%2Fc'])
})

test('state: label and classes of each state, fallback to "unknown", severity order', () => {
  assert.deepEqual(Object.keys(STATES), ['ok', 'warn', 'crit', 'unknown', 'maint', 'info', 'none'])
  for (const [k, s] of Object.entries(STATES)) {
    assert.ok(s.label && s.text && s.bg && s.border, k)
    if (k !== 'none') assert.deepEqual([s.text, s.bg, s.border], [`text-${k}`, `bg-${k}-bg`, `border-l-${k}`], k)
  }
  assert.deepEqual([STATES.ok.label, STATES.crit.label, STATES.none.label], ['En ligne', 'Hors ligne', 'Lien'])
  assert.equal(stateOf('crit'), STATES.crit)
  assert.equal(stateOf('nimporte'), STATES.unknown)
  assert.equal(stateOf(undefined), STATES.unknown)
  assert.deepEqual(['ok', 'none', 'crit', 'unknown', 'warn', 'maint'].sort((a, b) => RANK[a] - RANK[b]), ['crit', 'warn', 'unknown', 'maint', 'ok', 'none'])
})

test('storage: JSON read back, fallback if missing, unreadable, or localStorage missing or blocked; save never throws', t => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const saved = globalThis.localStorage
  t.after(() => { if (had) globalThis.localStorage = saved; else delete globalThis.localStorage })
  const m = new Map()
  globalThis.localStorage = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
  assert.equal(load('vigie.env', 'all'), 'all')
  save('vigie.env', 'prod')
  assert.equal(m.get('vigie.env'), '"prod"')
  assert.equal(load('vigie.env', 'all'), 'prod')
  save('vigie.obj', { a: [1, 2] })
  assert.deepEqual(load('vigie.obj', null), { a: [1, 2] })
  m.set('vigie.cassé', '{pas du json')
  assert.equal(load('vigie.cassé', 'repli'), 'repli')
  globalThis.localStorage = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }
  assert.equal(load('vigie.env', 'all'), 'all')
  assert.doesNotThrow(() => save('vigie.env', 'dev'))
  delete globalThis.localStorage
  assert.equal(load('vigie.env', 'all'), 'all')
  assert.doesNotThrow(() => save('vigie.env', 'dev'))
})

test('storage: the one-time migration of the old browser keys is gone; the client reads and writes vigie.* keys only', () => {
  const files = ['client/index.html', 'client/src/main.jsx', 'client/src/lib/storage.js', 'client/src/hooks/useTheme.js']
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /\bicc\.|migrateKeys/, f)
  assert.match(fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8'), /localStorage\.getItem\('vigie\.theme'\) \|\| 'auto'/)
})

test('tab title: config.title as soon as it is known, "Vigie" otherwise; set in App before the wall view; index.html default', () => {
  assert.equal(DEFAULT_TITLE, 'Vigie')
  assert.equal(titleOf({ title: 'Lab Control Center' }), 'Lab Control Center')
  assert.equal(titleOf({ title: '  Mon parc  ' }), 'Mon parc')
  for (const c of [undefined, null, {}, { title: '' }, { title: '   ' }, { title: 42 }]) assert.equal(titleOf(c), 'Vigie', JSON.stringify(c))
  const app = fs.readFileSync(path.join(ROOT, 'client/src/App.jsx'), 'utf8')
  const set = app.indexOf('document.title = titleOf(config.data)')
  assert.ok(set > 0, 'document.title set from the config')
  assert.match(app, /if \(config\.data\) document\.title = titleOf\(config\.data\)/)
  assert.ok(set < app.indexOf("if (location === '/wall' || LEGACY_ROUTES[location] === '/wall')"), 'before the early return of the wall')
  assert.match(fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8'), /<title>Vigie<\/title>/)
})

const fast = (over = {}) => ({ fs: [{ used: 40, avail: 60 }], docker: { containers: [] }, systemd: { failed: [], watched: [] }, ...over })
const agentOf = (over = {}) => ({ agent: 'ssh', ok: true, at: NOW - MIN, fast: fast(), ...over })

test('agent fsPct: used share in %, 0 if empty', () => {
  assert.equal(fsPct({ used: 85, avail: 15 }), 85)
  assert.equal(fsPct({ used: 0, avail: 0 }), 0)
})

test('agent agentSummary: not instrumented, report missing, old (> 5 min) or failing; ok, warn, crit and their causes', t => {
  t.mock.method(Date, 'now', () => NOW)
  assert.deepEqual(agentSummary(null), { state: 'none', label: 'non instrumenté' })
  assert.deepEqual(agentSummary({ agent: null }), { state: 'none', label: 'non instrumenté' })
  assert.deepEqual(agentSummary(agentOf({ ok: false, error: 'ssh: timeout' })), { state: 'unknown', label: 'ssh: timeout', error: true })
  assert.deepEqual(agentSummary(agentOf({ fast: null })), { state: 'unknown', label: 'pas encore de rapport', error: true })
  assert.equal(agentSummary(agentOf({ at: NOW - 5 * MIN })).state, 'ok')
  assert.equal(agentSummary(agentOf({ at: NOW - 5 * MIN - 1 })).state, 'unknown')
  const ok = agentSummary(agentOf())
  assert.deepEqual(ok, { state: 'ok', containers: { running: 0, total: 0, unhealthy: 0, restarting: 0 }, failedUnits: [], maxFs: 40, apt: undefined, aptAgeDays: null, reboot: null, restart: null })
  assert.equal(agentSummary(agentOf({ fast: fast({ docker: undefined }) })).containers, null)
  // warn: failed unit or inactive watched unit (deduplicated), FS ≥ 85 %, apt lists > 7 d
  const units = agentSummary(agentOf({ fast: fast({ systemd: { failed: ['a.service'], watched: [{ unit: 'a.service', active: 'failed' }, { unit: 'b.service', active: 'inactive' }, { unit: 'c.service', active: 'active' }] } }) }))
  assert.deepEqual([units.state, units.failedUnits], ['warn', ['a.service', 'b.service']])
  assert.equal(agentSummary(agentOf({ fast: fast({ fs: [{ used: 85, avail: 15 }] }) })).state, 'warn')
  assert.equal(agentSummary(agentOf({ fast: fast({ fs: [{ used: 84, avail: 16 }] }) })).state, 'ok')
  const apt = agentSummary(agentOf({ slow: { apt: { listsAt: (NOW - 8 * DAY) / 1000 } } }))
  assert.deepEqual([apt.state, Math.round(apt.aptAgeDays)], ['warn', 8])
  assert.equal(agentSummary(agentOf({ slow: { apt: { listsAt: (NOW - 6 * DAY) / 1000 } } })).state, 'ok')
  // crit: container failing, restarting or unstable (≥ 3 recent restarts), FS ≥ 95 %
  const cs = [{ state: 'running', health: 'unhealthy' }, { state: 'restarting' }, { state: 'running', recentRestarts: 3 }, { state: 'running' }, { state: 'exited' }]
  const crit = agentSummary(agentOf({ fast: fast({ docker: { containers: cs } }) }))
  assert.deepEqual([crit.state, crit.containers], ['crit', { running: 3, total: 5, unhealthy: 1, restarting: 2 }])
  assert.equal(agentSummary(agentOf({ fast: fast({ fs: [{ used: 40, avail: 60 }, { used: 95, avail: 5 }] }) })).state, 'crit')
  assert.equal(agentSummary(agentOf({ fast: fast({ docker: { containers: [{ state: 'running', recentRestarts: 2 }] } }) })).state, 'ok')
  // each cause alone is enough: restarting, then unstable, without any other failing container
  assert.equal(agentSummary(agentOf({ fast: fast({ docker: { containers: [{ state: 'restarting' }] } }) })).state, 'crit')
  assert.equal(agentSummary(agentOf({ fast: fast({ docker: { containers: [{ state: 'running', recentRestarts: 3 }] } }) })).state, 'crit')
  assert.equal(agentSummary(agentOf({ fast: fast({ docker: { containers: [{ state: 'running', health: 'unhealthy' }] } }) })).state, 'crit')
  // reboot required: reason, otherwise a plain yes
  assert.equal(agentSummary(agentOf({ fast: fast({ reboot: { required: true, reason: 'linux-image' } }) })).reboot, 'linux-image')
  assert.equal(agentSummary(agentOf({ fast: fast({ reboot: { required: true } }) })).reboot, 'oui')
  assert.equal(agentSummary(agentOf({ fast: fast({ reboot: { required: false, reason: 'x' } }) })).reboot, null)
})

test('agent since: "—" if missing, unreadable or before 2000; otherwise duration without the "ago" prefix', t => {
  t.mock.method(Date, 'now', () => NOW)
  assert.equal(since(undefined), '—')
  assert.equal(since('pas une date'), '—')
  assert.equal(since('1999-12-31T23:59:59Z'), '—')
  assert.equal(since('0001-01-01T00:00:00Z'), '—')
  assert.equal(since(new Date(NOW - 10 * 1000).toISOString()), '1 min')
  assert.equal(since(new Date(NOW - 3 * DAY).toISOString()), '3 j')
})

test('format: pct (capped at 100, 0 without max), bytes (binary units), uptime, duration, fmtUptime', () => {
  assert.deepEqual([pct(1, 0), pct(1, 3), pct(2, 3), pct(5, 4)], [0, 33, 67, 100])
  assert.deepEqual([bytes(0), bytes(undefined), bytes(512), bytes(1536), bytes(10 * 1024 * 1024), bytes(5 * 1024 ** 4), bytes(3 * 1024 ** 5)], ['0', '0', '512 o', '1.5 Ko', '10 Mo', '5.0 To', '3072 To'])
  assert.deepEqual([uptime(0), uptime(59), uptime(3599), uptime(3 * 3600 + 120), uptime(2 * 86400 + 5 * 3600)], ['—', '0m', '59m', '3h 2m', '2j 5h'])
  assert.deepEqual([duration(0), duration(59 * MIN), duration(60 * MIN), duration(65 * MIN), duration(47 * H + 59 * MIN), duration(48 * H), duration(10 * DAY)], ['1 min', '59 min', '1 h', '1 h 05', '47 h 59', '2 j', '10 j'])
  assert.deepEqual([fmtUptime(null), fmtUptime(undefined), fmtUptime(100), fmtUptime(99.95), fmtUptime(99.94), fmtUptime(12.345)], ['—', '—', '100 %', '100 %', '99.9 %', '12.3 %'])
})

test('deviceTypes: types and fallback, state, freshness and presence (ARP or not), displayed name', async t => {
  if (!fs.existsSync(path.join(ROOT, 'client/node_modules/lucide-react'))) {
    t.skip('client not installed (npm ci in client/)')
    return
  }
  t.mock.method(Date, 'now', () => NOW)
  const d = await import('../../client/src/lib/deviceTypes.js')
  assert.equal(d.typeOf('nas').label, 'NAS')
  assert.equal(d.typeOf('nas').icon, d.DEVICE_TYPES.nas.icon)
  assert.deepEqual([d.typeOf('fusée').label, d.typeOf('').label, d.typeOf(undefined).label], ['fusée', 'Inconnu', 'Inconnu'])
  assert.equal(d.typeOf('fusée').icon, d.DEVICE_TYPES.other.icon)
  assert.deepEqual([d.deviceState({ state: 'new', freshness: 'active' }), d.deviceState({ state: 'known', freshness: 'active' }), d.deviceState({ state: 'known', freshness: 'stale' })], ['warn', 'ok', 'unknown'])
  const iso = ms => new Date(NOW - ms).toISOString()
  assert.equal(d.freshnessText({ freshness: 'idle', lastSeen: iso(3 * H) }), 'vu il y a 3 h')
  assert.deepEqual([d.freshnessText({ freshness: 'idle' }), d.freshnessText({ freshness: 'dhcp' }), d.freshnessText({ freshness: 'stale' }), d.freshnessText({ freshness: 'active' }), d.freshnessText({})], ['vu il y a un moment', 'vu par DHCP', 'périmé', 'actif', 'inconnu'])
  // without ARP probe: freshness; with it: online, offline (and since when), unknown
  assert.equal(d.presenceState({ state: 'known', freshness: 'active', online: 0 }, 'passive'), 'ok')
  assert.equal(d.presenceText({ freshness: 'dhcp', online: 1 }, 'passive'), 'vu par DHCP')
  assert.deepEqual([1, 0, null].map(online => d.presenceState({ state: 'known', online }, 'arp')), ['ok', 'crit', 'unknown'])
  assert.equal(d.presenceState({ state: 'new', online: 1 }, 'arp'), 'warn')
  assert.equal(d.presenceText({ online: 1 }, 'arp'), 'en ligne')
  assert.equal(d.presenceText({ online: 0, lastPresent: iso(10 * MIN) }, 'arp'), 'hors ligne, vu il y a 10 min')
  assert.equal(d.presenceText({ online: 0 }, 'arp'), 'hors ligne')
  assert.equal(d.presenceText({ online: null }, 'arp'), 'présence inconnue')
  assert.deepEqual([{ name: 'Salon', vendor: 'V', ip: 'I', mac: 'M' }, { vendor: 'V', ip: 'I', mac: 'M' }, { ip: 'I', mac: 'M' }, { mac: 'M' }].map(d.deviceName), ['Salon', 'V', 'I', 'M'])
  assert.ok(Object.values(d.SOURCE_LABEL).every(v => typeof v === 'string' && v))
})

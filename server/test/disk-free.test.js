// Absolute free-space threshold per host (hosts[].alerts.diskFreeMinGB, GB of 1024³ bytes): rule
// disk_free (warning) on the root "/" of the agent report, 1 GB hysteresis, text from the catalog
// (fr, en), bounded schema. Real SQLite database (temporary folder), real rules, real engine,
// real notifier on a fake Telegram; fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast } from '../lib/agents.js'
import { parseConfig, DISK_FREE_MAX_GB } from '../lib/config.js'
import { createRules, CORE_RULES, RULE_LABEL, DISK_FREE_HYST_GB } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createNotifier } from '../lib/notify/notifier.js'
import { createFormatter } from '../lib/notify/format.js'
import { setLocale } from '../lib/i18n.js'
import { tmpStore } from './tmpdir.js'

const GIB = 1024 ** 3
const MIN = 60_000
const DAY = 24 * 3600_000
const NOW = Date.parse('2026-11-12T09:00:00Z') // Thursday, 10:00 in Paris: outside quiet hours
const raw = (alerts, extra = {}) => ({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'lab', label: 'l', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [
    { id: 'ws', name: 'poste-dev', kind: 'vm', pve: 'lab', vmid: 241, ip: '192.0.2.41', env: 'dev', agent: 'ssh', ...(alerts !== undefined ? { alerts } : {}), ...extra },
    { id: 'srv', name: 'serveur', kind: 'vm', pve: 'lab', vmid: 242, ip: '192.0.2.42', env: 'prod', agent: 'ssh' },
  ],
})
const cfgOf = (alerts, extra) => {
  const r = parseConfig(raw(alerts, extra))
  assert.ok(r.config, r.errors?.join('\n'))
  return r.config
}
// fast v8 report: 100 GiB root with `free` bytes free, plus a small, almost full /boot/efi
const fast = (free, more = []) => cleanFast({
  version: 8, ts: Math.floor(NOW / 1000), reboot: { required: false },
  fs: [
    { mount: '/', type: 'ext4', size: 100 * GIB, used: 100 * GIB - free, avail: free, inodes: { total: 1000, used: 10 } },
    { mount: '/boot/efi', type: 'vfat', size: 512 * 1024 ** 2, used: 500 * 1024 ** 2, avail: 12 * 1024 ** 2, inodes: null },
    ...more,
  ],
})
const live = (f, at = NOW) => ({ ok: true, at, fast: f, slow: null })
const sigs = (states, cfg) => {
  const all = createRules(cfg, { checks: [], result: () => null }, { hosts: cfg.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }, null).evaluate({}, NOW)
  return all.filter(x => x.rule === 'disk_free')
}
const one = (free, alerts = { diskFreeMinGB: 12 }) => sigs({ ws: live(fast(free)), srv: live(fast(free)) }, cfgOf(alerts))

test('disk_free: threshold bounds (strictly below the threshold), 1 GB hysteresis, warning even in prod', () => {
  assert.equal(DISK_FREE_HYST_GB, 1)
  const cond = free => one(free)[0]?.cond
  assert.equal(cond(12 * GIB - 1), true, 'just below the threshold')
  assert.equal(cond(12 * GIB), null, 'exactly at the threshold: not below, within the margin')
  assert.equal(cond(12 * GIB + 1), null, 'just above: within the margin (state kept)')
  assert.equal(cond(13 * GIB - 1), null, 'just under threshold + 1 GB: margin')
  assert.equal(cond(13 * GIB), false, 'threshold + 1 GB: recovered')
  assert.equal(cond(50 * GIB), false)
  assert.equal(cond(0), true, 'full disk')
  const s = one(5 * GIB)[0]
  assert.deepEqual([s.key, s.rule, s.entity, s.hostId, s.severity, s.title, s.detail, s.link],
    ['disk_free:ws:/', 'disk_free', 'ws', 'ws', 'warning', 'Espace libre / · poste-dev', '5 Go libres (seuil : 12 Go)', '/infra?h=ws'])
  assert.deepEqual(s.parents, ['agent_unreachable:ws', 'guest_stopped:ws', 'pve_unreachable:lab'])
  // a single signal: the root only (the small, almost full /boot/efi is not concerned), and only
  // for the host that has the threshold (srv has none)
  assert.equal(one(5 * GIB).length, 1)
  // warning in prod too (no critical threshold); decimal threshold
  const prod = sigs({ srv: live(fast(GIB)) }, parseConfig({ ...raw(undefined), hosts: raw(undefined).hosts.map(h => (h.id === 'srv' ? { ...h, alerts: { diskFreeMinGB: 1.5 } } : h)) }).config)
  assert.deepEqual([prod[0].key, prod[0].cond, prod[0].severity, prod[0].detail], ['disk_free:srv:/', true, 'warning', '1 Go libres (seuil : 1,5 Go)'])
})

test('disk_free: free space rounded down (never "12 GB free" under a threshold of 12); the percentage rule keeps its key', () => {
  const s = one(Math.round(11.96 * GIB))[0]
  assert.deepEqual([s.cond, s.detail], [true, '11,9 Go libres (seuil : 12 Go)'])
  // guest_disk (85 / 95 %) stays independent: 88 % used → guest_disk raised, disk_free too
  const all = createRules(cfgOf({ diskFreeMinGB: 12 }), { checks: [], result: () => null }, { hosts: cfgOf({ diskFreeMinGB: 12 }).hosts, get: id => (id === 'ws' ? live(fast(12 * GIB - 1)) : { ok: null }) }, null).evaluate({}, NOW)
  assert.deepEqual(all.filter(x => x.key === 'guest_disk:ws:/' || x.key === 'disk_free:ws:/').map(x => [x.key, x.cond]), [['guest_disk:ws:/', true], ['disk_free:ws:/', true]])
})

test('disk_free: without the option (or alerts without diskFreeMinGB), no signal; missing root, stale report or agent down: no signal', () => {
  assert.deepEqual(sigs({ ws: live(fast(GIB)), srv: live(fast(GIB)) }, cfgOf(undefined)), [], 'without an alerts block')
  assert.deepEqual(one(GIB, { ports: false }), [])
  assert.deepEqual(one(GIB, { severity: 'info' }), [])
  const cfg = cfgOf({ diskFreeMinGB: 12 })
  const noRoot = cleanFast({ version: 8, ts: Math.floor(NOW / 1000), fs: [{ mount: '/srv', type: 'ext4', size: 100 * GIB, used: 99 * GIB, avail: GIB, inodes: null }], reboot: { required: false } })
  assert.deepEqual(sigs({ ws: live(noRoot) }, cfg), [], 'root missing from the report')
  assert.deepEqual(sigs({ ws: live(fast(GIB), NOW - 6 * MIN) }, cfg), [], 'report older than 5 min')
  assert.deepEqual(sigs({ ws: { ok: false, at: NOW - MIN, error: 'timeout', fast: fast(GIB) } }, cfg), [], 'agent unreachable')
  // unusable avail: missing, null, empty or non-numeric string (cleanFast → null, not 0), or
  // string left as is in an uncleaned state: no signal, never "0 GB free"
  const rootWith = avail => ({ mount: '/', type: 'ext4', size: 100 * GIB, used: 99 * GIB, ...(avail === undefined ? {} : { avail }) })
  for (const avail of [undefined, null, '', 'beaucoup']) {
    const f = cleanFast({ version: 8, ts: Math.floor(NOW / 1000), fs: [rootWith(avail)], reboot: { required: false } })
    assert.equal(f.fs[0].avail, null, `cleaned: ${String(avail)}`)
    assert.deepEqual(sigs({ ws: live(f) }, cfg), [], `avail ${String(avail)}`)
  }
  const brut = { version: 8, fs: [rootWith('5368709120')], docker: null, systemd: null, reboot: { required: false } }
  assert.deepEqual(sigs({ ws: live(brut) }, cfg), [], 'uncleaned string')
  // a real 0 (full disk) and a numeric string remain measurements
  const plein = cleanFast({ version: 8, ts: Math.floor(NOW / 1000), fs: [rootWith(0), { ...rootWith('1073741824'), mount: '/srv' }], reboot: { required: false } })
  assert.deepEqual(plein.fs.map(x => x.avail), [0, GIB])
  assert.equal(sigs({ ws: live(plein) }, cfg)[0].cond, true)
  // agent v7 (no inodes): avail has always been there, the rule applies
  const v7 = cleanFast({ version: 7, ts: Math.floor(NOW / 1000), fs: [{ mount: '/', type: 'ext4', size: 100 * GIB, used: 99 * GIB, avail: GIB }], reboot: { required: false } })
  assert.equal(sigs({ ws: live(v7) }, cfg)[0].cond, true)
})

test('disk_free: hysteresis through the real engine (raised under 12, kept between 12 and 13, restored at 13); one opening, one resolution', t => {
  const cfg = cfgOf({ diskFreeMinGB: 12 })
  const store = tmpStore('dash-disk-free-', t)
  const states = {}
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null } }
  const clock = createClock('Europe/Paris')
  const sent = []
  const telegram = { configured: true, send: async text => { sent.push(text) } }
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter: createFormatter({ dashboardUrl: null, clock }), log: { log() {}, error() {} } })
  const rules = createRules(cfg, { checks: [], result: () => null }, agents, null)
  const engine = createEngine({ cfg, store, rules, notifier, clock, startedAt: NOW - DAY })
  const state = () => engine.get('disk_free:ws:/')?.state ?? null
  const at = (free, t1) => {
    states.ws = live(fast(free), t1)
    states.srv = live(fast(50 * GIB), t1)
    engine.evaluate({}, t1)
  }
  at(12.5 * GIB, NOW)
  assert.notEqual(state(), 'firing', 'within the margin at start: nothing')
  at(11.5 * GIB, NOW + MIN)
  assert.equal(state(), 'firing')
  assert.equal(engine.get('disk_free:ws:/').severity, 'warning')
  for (const [i, free] of [12 * GIB, 12.5 * GIB, 13 * GIB - 1].entries()) {
    at(free, NOW + (2 + i) * MIN)
    assert.equal(state(), 'firing', `kept at ${free / GIB} GB`)
  }
  at(13 * GIB, NOW + 10 * MIN)
  assert.notEqual(state(), 'firing', 'recovered at threshold + 1 GB')
  const out = store.db.prepare("SELECT kind FROM outbox WHERE key = 'disk_free:ws:/' ORDER BY id").all().map(r => r.kind)
  assert.deepEqual(out, ['open', 'resolve'])
})

test('disk_free: French and English texts (title, detail, rule label), same keys and same states', () => {
  assert.ok(CORE_RULES.includes('disk_free'))
  const fr = one(Math.round(11.5 * GIB))[0]
  assert.deepEqual([fr.title, fr.detail, RULE_LABEL.disk_free], ['Espace libre / · poste-dev', '11,5 Go libres (seuil : 12 Go)', 'Espace disque libre'])
  setLocale('en')
  try {
    const en = one(Math.round(11.5 * GIB))[0]
    assert.deepEqual([en.key, en.cond, en.severity], [fr.key, fr.cond, fr.severity])
    assert.deepEqual([en.title, en.detail, RULE_LABEL.disk_free], ['Free space / · poste-dev', '11.5 GB free (threshold: 12 GB)', 'Free disk space'])
    const dec = one(GIB, { diskFreeMinGB: 2.5 })[0]
    assert.equal(dec.detail, '1 GB free (threshold: 2.5 GB)')
  } finally {
    setLocale('fr')
  }
})

test('disk_free, schema: bounded positive number (0 < x ≤ 100 000), hosts only; without agent: warning', () => {
  assert.equal(DISK_FREE_MAX_GB, 100_000)
  for (const ok of [12, 0.5, 100_000]) assert.ok(parseConfig(raw({ diskFreeMinGB: ok })).config, `accepted: ${ok}`)
  for (const bad of [0, -1, 100_001, '12', null, true, Number.NaN]) {
    const r = parseConfig(raw({ diskFreeMinGB: bad }))
    assert.ok(!r.config && r.errors?.length, `rejected: ${String(bad)}`)
    assert.match(r.errors.join('\n'), /diskFreeMinGB/)
  }
  assert.ok(!parseConfig(raw({ diskFreeMinGb: 12 })).config, 'wrong case rejected (strict schema)')
  const svc = raw(undefined)
  svc.services = [{ id: 's', name: 'S', group: 'g', host: 'ws', url: 'http://x', alerts: { diskFreeMinGB: 12 } }]
  assert.ok(!parseConfig(svc).config, 'hosts only')
  const noAgent = parseConfig(raw({ diskFreeMinGB: 12 }, { agent: undefined }))
  assert.ok(noAgent.config)
  assert.deepEqual(noAgent.warnings.filter(w => /diskFreeMinGB/.test(w)), ['host ws: alerts.diskFreeMinGB without agent (ignored)'])
  assert.deepEqual(parseConfig(raw({ diskFreeMinGB: 12 })).warnings?.filter(w => /diskFreeMinGB/.test(w)) ?? [], [])
})

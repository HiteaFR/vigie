// Golden coverage. The world of world.js only exercises part of the texts that
// go out to Telegram; these outputs add to it, through the real server code and without changing it:
// - notify-cycle.txt: real engine and real notifier on scripted signals: opening, reminder,
//   escalation, flapping, stabilization (recovered and still down), impact of a Proxmox
//   outage, recovery, failing channel alert;
// - digest-full.txt: digest with acknowledged and suppressed alerts, silences (with an end and endless),
//   resolved incidents, unreadable backups, versions section (new versions, end of life,
//   applied patches, hosts without a report, services to restart) and real Network section;
// - network.txt: network module signals (net_*, source_error) rendered as in Telegram, bot
//   replies to /reseau and /appareil on the real module (including "0 nouveau");
// - extras.txt: /status (two states), acknowledgments from the dashboard, buttons, plugin_error,
//   bot replies outside bot.txt.
// Written to also run on the code from before this change (equivalence proof): /status does not exist
// there as a module (it was in index.js) and then prints "(absent)".
import { parseConfig } from '../../lib/config.js'
import { createEngine } from '../../lib/alerts/engine.js'
import { createSilences } from '../../lib/alerts/silences.js'
import { createClock } from '../../lib/clock.js'
import { createFormatter } from '../../lib/notify/format.js'
import { createNotifier } from '../../lib/notify/notifier.js'
import { buildDigest } from '../../lib/notify/digest.js'
import { createBot } from '../../lib/notify/bot.js'
import { buttonsFor } from '../../lib/notify/channels.js'
import { ackMessage } from '../../lib/alerts/bulk.js'
import { networkSignals } from '../../lib/network/rules.js'
import { createUpdates } from '../../lib/updates/index.js'
import { cleanSlow } from '../../lib/agents.js'
import { openDb } from '../../lib/db.js'
import { createHost, definePlugin } from '../../lib/plugins/host.js'
import { createNetStore } from '../../lib/network/store.js'
import { r3Bench, prodLikeStore, FIXTURE_HOSTS } from '../network-fixture.js'
import { tmpDir } from '../tmpdir.js'
import { rawConfig, buildWorld, monitorStub } from './world.js'
import { createRules, RULE_LABEL } from '../../lib/alerts/rules.js'
import { createNetwork } from '../../lib/network/index.js'
import { createAudit } from '../../lib/auth.js'
import { prodConfig, prodSources } from '../network-fixture.js'

const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H
const S = ms => Math.floor(ms / 1000)
const quietLog = { log() {}, warn() {}, error() {} }

function fakeTelegram() {
  const sent = []
  return { configured: true, chatId: '42', sent, send: async (text, opts = {}) => { sent.push({ text, ...opts }); return { message_id: sent.length } } }
}
const show = sent => sent.map((m, i) => `--- message ${i + 1} (silencieux : ${!!m.silent}${m.replyMarkup ? `, boutons : ${JSON.stringify(m.replyMarkup)}` : ''})\n${m.text}\n`).join('\n')

// cycle config: close reminders, no startup delay; working day (immediate sending)
function cycleConfig() {
  const raw = rawConfig()
  raw.alerts = { ...raw.alerts, repeat: { critical: '1h', warning: '2h' }, startupGraceSec: 0 }
  return parseConfig(raw).config
}

// --- notification cycle ----------------------------------------------------------------------------
async function cycleOutput(storeDir, NOW) {
  const cfg = cycleConfig()
  const store = openDb(storeDir)
  const clock = createClock(cfg.alerts.timezone)
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: cfg.alerts.dashboardUrl, clock })
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter, buttons: true, log: quietLog })
  const T0 = NOW - 2 * H // 08:00 in Paris, a Tuesday
  const sig = (key, rule, title, cond, severity, extra = {}) => ({ key, rule, entity: key.split(':')[1], title, env: 'prod', cond, severity, detail: extra.detail ?? null, link: '/alerts', parents: [], ...extra })
  const at = (t, from, to) => t >= from && (to == null || t < to)
  // flapping: four transitions in less than 30 min (2 min step)
  const flapping = (t, from, until) => at(t, from, until) && Math.floor((t - from) / (2 * MIN)) % 2 === 0
  const rules = {
    impacted: key => ({ services: ['DNS', 'Site public'], guests: key.startsWith('pve_unreachable:') ? 3 : 0 }),
    evaluate: (snap, t) => [
      sig('service_down:cycle-a', 'service_down', 'Service A', at(t, T0, T0 + 5 * H), 'critical', { detail: 'TCP 22 : <refusé>', host: 'vps' }),
      sig('guest_disk:cycle-b', 'guest_disk', 'Disque / · cycle-b', at(t, T0 + 10 * MIN, T0 + 3 * H), t >= T0 + H ? 'critical' : 'warning', { detail: 'plein' }),
      sig('container_restarting:cycle-c', 'container_restarting', 'Conteneur c', flapping(t, T0 + 30 * MIN, T0 + 50 * MIN), 'warning'),
      sig('container_restarting:cycle-d', 'container_restarting', 'Conteneur d', flapping(t, T0 + 30 * MIN, T0 + 50 * MIN) || t >= T0 + 50 * MIN, 'warning', { detail: 'redémarre' }),
      sig('pve_unreachable:main', 'pve_unreachable', 'Proxmox pve-a', at(t, T0 + 2 * H, T0 + 2 * H + 30 * MIN), 'critical', { detail: 'API en erreur : Proxmox 500' }),
    ],
  }
  const engine = createEngine({ cfg, store, rules, notifier, clock, startedAt: T0 - H })
  for (let t = T0; t <= T0 + 6 * H; t += 2 * MIN) {
    engine.evaluate({}, t)
    await notifier.flush(t)
  }
  // main channel failing: channel_error alert (title)
  const chan = notifier.channelSignals?.() ?? []
  store.db.close()
  return `${show(telegram.sent)}\n# canaux : ${chan.map(s => `${s.key} · ${s.title} · ${s.cond}`).join(' ; ') || '—'}\n`
}

// --- full digest -----------------------------------------------------------------------------------
async function digestOutput(storeDir, NOW, network) {
  const cfg = cycleConfig()
  const store = openDb(storeDir)
  const clock = createClock(cfg.alerts.timezone)
  const formatter = createFormatter({ dashboardUrl: cfg.alerts.dashboardUrl, clock })
  const silences = createSilences({ store, now: () => NOW })
  silences.create({ matcher: { host: 'vps' }, reason: 'migration <de> banc', by: 'admin', source: 'ui', endsAt: NOW + 3 * DAY })
  silences.create({ matcher: { rule: 'apt_stale' }, reason: 'listes gelées', by: 'admin', source: 'ui', endsAt: null })
  silences.create({ matcher: { service: 'dns' }, reason: 'résolveur de test', by: 'tg:u7', source: 'telegram', endsAt: NOW + 2 * H })
  const T0 = NOW - 3 * H
  const sig = (key, rule, title, cond, severity, extra = {}) => ({ key, rule, entity: key, title, env: 'prod', cond, severity, detail: null, link: '/alerts', parents: [], ...extra })
  const rules = {
    impacted: () => ({ services: [], guests: 0 }),
    evaluate: (snap, t) => [
      sig('service_down:x', 'service_down', 'Service X', true, 'critical', { detail: 'HTTP 502' }),
      sig('guest_stopped:y', 'guest_stopped', 'CT 240 y', true, 'warning', { parents: ['service_down:x'] }),
      sig('guest_disk:z', 'guest_disk', 'Disque / · z', t < NOW - H, 'warning'),
      sig('systemd_failed:w', 'systemd_failed', 'Unités systemd · w', t < NOW - 2 * H, 'warning', { detail: 'backup.service' }),
    ],
  }
  const notifier = { enqueue: () => 'now', enqueueRaw() {} }
  const engine = createEngine({ cfg, store, rules, notifier, clock, silences, startedAt: T0 - H })
  for (let t = T0; t <= NOW; t += 5 * MIN) engine.evaluate({}, t)
  engine.ack('service_down:x', { by: 'admin (192.0.2.1)', reason: 'je regarde <ça>' })
  // versions section: new versions (including an image), end of life, automatic updates, services to restart
  const agents = {
    hosts: cfg.hosts.filter(h => h.id === 'lab' || h.id === 'vps').map(h => ({ ...h, agent: 'ssh' })),
    get: id => (id === 'lab'
      ? { ok: true, at: NOW, slowAt: NOW, fast: { osId: 'debian', osVersion: '11', docker: null }, slow: cleanSlow({ version: 8, ts: S(NOW), apt: { listsAt: S(NOW), upgradable: 0, security: 0, packages: [] }, autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: S(NOW - 4 * H), lastResult: 'success', applied: [{ name: 'openssl', version: '1' }] }, restart: { units: ['nginx.service', 'php-fpm.service', 'cron.service', 'ssh.service'] } }) }
      : { ok: true, at: NOW, slowAt: NOW - 3 * H, fast: { osId: 'alpine', docker: null }, slow: cleanSlow({ version: 7, ts: S(NOW - 3 * H), apt: { listsAt: S(NOW), upgradable: 0, security: 0, packages: [] }, autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: S(NOW - H), lastResult: 'success', applied: [] } }) }),
  }
  const upstream = {
    github: async () => [{ tag: 'v1.2.0', body: 'security fix' }, { tag: 'v1.0.0', body: '' }], githubTags: async () => [], node: async () => [], errors: () => [], stats: () => ({}),
    eol: async () => [{ cycle: '12', eol: '2028-06-10' }, { cycle: '11', eol: '2026-08-31' }], giteaCom: async () => [], pypi: async () => [], httpJson: async () => null, remoteDigest: async () => null, remoteTags: async () => [], pvePackages: async () => [],
  }
  const ucfg = parseConfig({ ...rawConfig(), services: [{ id: 'app', name: 'App', group: 'web', host: 'lab', url: 'http://192.0.2.10', version: { current: { from: 'agent', package: 'app' }, latest: { from: 'github', repo: 'o/app' } } }] }).config
  const updates = createUpdates({ cfg: ucfg, store, agents: { ...agents, get: id => ({ ...agents.get(id), slow: { ...agents.get(id).slow, versions: { app: '1.0.0' } } }) }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: quietLog })
  await updates.refresh(NOW)
  const snap = { backups: { data: [{ id: 'main', error: 'Proxmox 500' }], error: null, at: NOW } }
  const monitor = { checks: [], result: () => null }
  const digest = buildDigest({ cfg, engine, snap, monitor, formatter, clock, updates, network, silences, mark: false, now: NOW })
  // update signals (end of life, security patch) as in Telegram
  const upd = updates.signals(NOW).filter(x => x.cond).map(x => formatter.render('open', { ...x, since: NOW - H }, NOW))
  // quiet digest: neither alert nor incident
  const calmEngine = createEngine({ cfg, store: openDb(`${storeDir}-calme`), rules: { evaluate: () => [], impacted: () => ({}) }, notifier, clock, startedAt: T0 })
  const calm = buildDigest({ cfg, engine: calmEngine, snap: {}, monitor, formatter, clock, mark: false, now: NOW })
  // update variants: end of life near (date), passed without a date; automatic updates without a fresh report,
  // night without a patch
  const variant = async (cycles, slows) => {
    const ag = { hosts: agents.hosts, get: id => ({ ok: true, at: NOW, fast: { osId: 'debian', osVersion: '11', docker: null }, ...slows(id) }) }
    const up = { ...upstream, eol: async () => cycles }
    const u = createUpdates({ cfg: ucfg, store, agents: ag, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream: up, log: quietLog })
    await u.refresh(NOW)
    return [...u.signals(NOW).filter(x => x.cond && x.rule === 'eol').map(x => formatter.render('open', { ...x, since: NOW - H }, NOW)), ...u.digestLines({ now: NOW })]
  }
  const v7 = (at, applied) => ({ slowAt: at, slow: cleanSlow({ version: 7, ts: S(at), apt: { listsAt: S(at), upgradable: 0, security: 0, packages: [] }, autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: S(NOW - 4 * H), lastResult: 'success', applied }, versions: { app: '1.0.0' } }) })
  const soon = await variant([{ cycle: '11', eol: '2026-12-01' }], () => v7(NOW - 3 * H, []))
  const passed = await variant([{ cycle: '12', eol: false }, { cycle: '11', eol: true }], () => v7(NOW, []))
  store.db.close()
  return `${digest}\n\n# signaux des MAJ\n${upd.join('\n\n')}\n\n# digest calme\n${calm}\n\n# MAJ : fin de vie proche, MAJ auto sans rapport frais\n${soon.join('\n')}\n\n# MAJ : fin de vie dépassée sans date, nuit sans correctif\n${passed.join('\n')}\n`
}

// --- rules: world variants (Proxmox, backups, disks, v8 and v9 agents, probes), labels -----------------
const FAMILIES = /^(vpn_down|vpn_leak|vpn_noinfo|posture_regression|port_new|security_updates|pve_unreachable|guest_stopped|backup_failed|not_backed_up|smart_failed|disk_wear|cert_expiry|service_down|container_down|time_unsynced|apt_stale|autoupdate_off|autoupdate_failed|disk_free|oom_kill):/
async function rulesExtraOutput(storeDir, NOW) {
  const w = await buildWorld({ storeDir })
  const out = []
  const shown = (label, sigs) => out.push(`# ${label}`, ...sigs.filter(x => FAMILIES.test(x.key) && (x.cond || x.detail)).map(x => `${x.key} · ${x.cond} · ${x.title} · ${x.detail ?? '—'}`), '')
  // Proxmox API failing (token refused: API error)
  const a = structuredClone(w.snap)
  Object.assign(a.cluster.data[0], { error: 'Proxmox 401', errorKind: 'api' })
  shown('API Proxmox en erreur', w.rules.evaluate(a, NOW))
  // guest declared but missing from Proxmox; failed backup; guest excluded from the job; SMART counters;
  // wear with consumed percentage; disk without model or type
  const b = structuredClone(w.snap)
  b.cluster.data[0].guests = b.cluster.data[0].guests.filter(g => g.vmid !== 212)
  b.backups.data[0].items.find(x => x.vmid === 211).failed = { at: NOW - 3 * H }
  b.backups.data[0].coverage.find(x => x.vmid === 200).excluded = true
  Object.assign(b.disks.data[0].disks[1], { reallocated: 5, pending: 2, mediaErrors: 1, model: null, type: null })
  Object.assign(b.disks.data[0].disks[2], { wearout: 8, percentUsed: 92 })
  shown('invité absent, sauvegardes, disques', w.rules.evaluate(b, NOW))
  w.store.db.close()
  // v8 agents and probes: world config, plus one host and two declared containers
  const raw = rawConfig()
  raw.hosts.push({ id: 'vieux', name: 'vieux', kind: 'external', ip: '192.0.2.88', env: 'prod', agent: 'ssh' }, { id: 'jamais', name: 'jamais', kind: 'external', ip: '192.0.2.89', env: 'prod', agent: 'ssh' })
  // free space (alerts.diskFreeMinGB 12, GB of 1024³ bytes) at the bounds: just below (raised),
  // right at the threshold and just under threshold + 1 GB (margin: null), threshold + 1 GB (recovered); in prod: warning
  const GIB = 1024 ** 3
  const FREE = { 'libre-sous': 12 * GIB - 1, 'libre-pile': 12 * GIB, 'libre-marge': 13 * GIB - 1, 'libre-ok': 13 * GIB }
  for (const [i, id] of Object.keys(FREE).entries()) raw.hosts.push({ id, name: id, kind: 'external', ip: `192.0.2.${151 + i}`, env: 'prod', agent: 'ssh', alerts: { diskFreeMinGB: 12 } })
  // VPN (simulated Gluetun widget): leak at the ISP, country leak, widget failing, no info, tunnel stopped
  const vpn = (id, port, extra = {}) => ({ id, name: id, group: 'web', host: 'docker-a', url: `http://192.0.2.156:${port}`,
    widget: { url: `http://192.0.2.156:${port}`, auth: { type: 'header', name: 'X-API-Key', secretEnv: 'GLUETUN_KEY' }, fields: [
      { label: 'VPN', path: '/v1/vpn/status', json: 'status', format: 'text' }, { label: 'Pays', path: '/v1/publicip/ip', json: 'country', format: 'text' },
      { label: 'Opérateur', path: '/v1/publicip/ip', json: 'organization', format: 'text' }] },
    vpn: { type: 'gluetun', homeIsp: 'FAI-Maison', ...extra } })
  raw.services.push(vpn('vpn-fai', 4101), vpn('vpn-pays', 4102, { countries: ['Suisse', 'Suède'] }), vpn('vpn-err', 4103), vpn('vpn-vide', 4104), vpn('vpn-arret', 4105))
  const W = { 'vpn-fai': ['running', 'France', 'FAI-Maison SA'], 'vpn-pays': ['running', 'Pays-Bas', 'Opérateur VPN'], 'vpn-vide': ['running', '', ''], 'vpn-arret': ['stopped', 'Suisse', 'Opérateur VPN'] }
  const widgets = { get: id => (id === 'vpn-err' ? { fields: [], error: 'HTTP 401 <clé>', at: new Date(NOW - MIN).toISOString() } : W[id] ? { fields: W[id].map(value => ({ value })), error: null, stale: false, at: new Date(NOW - MIN).toISOString() } : null) }
  // agent memory: posture seen compliant 3 days ago, ports bootstrapped and unknown, automatic updates active for 5 days
  const memory = { postureRow: () => ({ first_ok: NOW - 9 * DAY, last_ok: NOW - 3 * DAY, accepted_at: null }), bootstrapped: () => true, portRow: () => null, unknownPorts: () => [], autoActiveSince: () => NOW - 5 * DAY }
  const pending = { signals: () => [], securityPending: id => (id === 'docker-a' ? [{ name: 'openssl', since: NOW - 4 * DAY }, { name: 'libssl3', since: NOW - 4 * DAY }] : []), isIgnored: () => false }
  raw.services.push({ id: 'svc-c', name: 'svc-c', group: 'web', host: 'docker-a', container: 'absent-c', url: 'http://192.0.2.91' }, { id: 'svc-d', name: 'svc-d', group: 'web', host: 'docker-a', container: 'arrete', url: 'http://192.0.2.92' })
  const cfg = parseConfig(raw).config
  const slow = (o = {}) => cleanSlow({ version: 8, ts: S(NOW), apt: { listsAt: S(NOW), upgradable: 0, security: 0, packages: [] }, ...o })
  const au = (o = {}) => ({ installed: true, enabled: true, securityOnly: true, lastRunAt: S(NOW - 4 * H), lastResult: 'success', applied: [], ...o })
  const fast = (o = {}) => ({ version: 8, fs: [], docker: null, systemd: null, reboot: { required: false }, ...o })
  const states = {
    'docker-a': { fast: fast({ docker: { containers: [{ name: 'arrete', state: 'exited', health: null, restarts: 0, recentRestarts: 0 }] } }), slow: slow({ autoUpdate: au({ lastResult: 'failed' }), time: { ntpSynced: false }, posture: { ssh: { permitRootLogin: 'yes', passwordAuth: true }, firewall: { type: 'nftables', active: false } }, listening: [{ proto: 'tcp', addr: '192.0.2.156', port: 8080, process: 'node' }] }) },
    jamais: { fast: fast(), slow: slow({ autoUpdate: au({ lastRunAt: null }), posture: { ssh: null, firewall: { type: 'none', active: false } } }) },
    // agent v9: processes killed by earlyoom (dns-a), none in the window (lab), earlyoom absent (vps)
    'dns-a': { fast: fast({ version: 9, oom: { windowSec: 3600, kills: 2, lastAt: S(NOW - 10 * MIN), lastProcess: 'stress-ng' } }), slow: slow({ autoUpdate: au({ installed: false }) }) },
    lab: { fast: fast({ version: 9, oom: { windowSec: 3600, kills: 0, lastAt: null, lastProcess: null } }), slow: slow({ apt: { listsAt: null, upgradable: 0, security: 0, packages: [] }, autoUpdate: au({ enabled: false }) }) },
    vps: { fast: fast({ version: 9, oom: null }), slow: slow({ autoUpdate: au({ securityOnly: false }) }) },
    vieux: { fast: fast(), slow: slow({ autoUpdate: au({ lastRunAt: S(NOW - 5 * DAY) }) }) },
    ...Object.fromEntries(Object.entries(FREE).map(([id, free]) => [id, { fast: fast({ fs: [{ mount: '/', size: 100 * GIB, used: 100 * GIB - free, avail: free, inodes: null }] }), slow: null }])),
  }
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: id => (states[id] ? { ok: true, at: NOW - MIN, slowAt: NOW - MIN, error: null, ...states[id] } : { ok: null }), reports: () => [] }
  const base = monitorStub(cfg)
  const monitor = { ...base, result: id => (id === 'cert-6#0' ? { state: 'crit', fails: 1, oks: 0, tls: { daysLeft: -1, validTo: NOW - DAY }, checkedAt: NOW - MIN } : id === 'app#0' ? { state: 'crit', fails: 5, oks: 0, code: null, error: null, checkedAt: NOW - MIN } : base.result(id)) }
  shown('agents v8 et v9, sondes, VPN', createRules(cfg, monitor, agents, pending, null, widgets, memory).evaluate({}, NOW))
  // label of each core rule, as in the first line of an opening
  out.push('# libellés des règles', ...Object.keys(RULE_LABEL).map(rule => createFormatter({ dashboardUrl: null, clock: createClock('Europe/Paris') }).render('open', { rule, title: 'x', severity: 'warning', since: NOW }, NOW)))
  return `${out.join('\n')}\n`
}

// --- network module without an ARP probe: source failing, MAC to confirm ----------------------------
async function networkPiholeDigest(NOW) {
  const cfg = prodConfig()
  const { store } = prodLikeStore({ T: NOW - 6 * H })
  const src = prodSources(cfg)
  let t = NOW - 6 * H
  const network = createNetwork({ cfg, store, ...src, audit: createAudit(store), now: () => t, log: quietLog, ifaces: () => ({}), oui: null })
  for (let i = 0; i < 3; i++) { t += 2 * MIN; src.setClock(t); await network.runAll() }
  const dev = store.db.prepare('SELECT id FROM net_devices WHERE host_id IS NULL ORDER BY id LIMIT 1').get().id
  createNetStore(store).applyOps([{ op: 'upsertMac', mac: '00:00:5e:00:53:7e', device: dev, grade: 'weak', random: 0, first_seen: t, last_seen: t, last_ip: '192.0.2.126', attach: 'name', confirmed_at: null }])
  src.pihole.get = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }
  t = NOW
  src.setClock(t)
  await network.runAll()
  const lines = network.digestLines({ now: t })
  network.stop?.()
  return lines.join('\n')
}

// --- bot on a simulated network module: records, freshness, network buttons, alerts --------------
async function botFakeNetworkOutput(storeDir, NOW) {
  const T = NOW
  const cfg = parseConfig(rawConfig()).config
  const store = openDb(storeDir)
  const silences = createSilences({ store, now: () => NOW })
  silences.create({ matcher: { rule: 'apt_stale' }, reason: 'listes gelées', by: 'admin', source: 'ui', endsAt: null })
  const fresh = ['idle', 'active', 'dhcp', 'stale', 'inconnue']
  const devices = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, state: 'new', name: i ? `appareil-${i}` : null, vendor: i === 0 ? null : null, mac: i === 0 ? null : `00:00:5e:00:54:${String(10 + i)}`, freshness: fresh[i % 5], lastSeen: new Date(T - 3 * H).toISOString(), pending: i === 1 ? 2 : 0 }))
  let view = { presence: 'pihole', counts: { total: 30, active: 20, new: 12, review: 2 }, sources: { pihole: { ok: true }, dhcp: { ok: true } }, presenceSince: null, devices }
  const one = { id: 7, name: 'poste-7', vendor: 'Fabricant <SA>', mac: '00:00:5e:00:54:07', ip: '192.0.2.70', macs: 3, pending: 2, review: 1, state: 'known', hostId: 'vps', freshness: 'active' }
  const network = {
    enabled: true, writes: { ack: () => ({ done: [] }) },
    bot: { check: (a, ref) => (ref === '404' ? null : { title: 'poste <7>' }), act: () => ({ ok: true }) },
    view: () => view,
    search: q => (q === 'poste' ? [one, { ...one, id: 8, name: 'poste-8', ip: null }] : q === 'unique' ? [one] : []),
  }
  const engine = {
    active: () => [{ state: 'firing', rule: 'service_down', incidentId: 3, severity: 'critical', title: 'Service X', detail: 'HTTP 502', ack: { reason: 'je regarde', by: 'admin' }, suppressed: null }],
    byIncident: n => (n === 3 ? { key: 'service_down:x', title: 'Service X' } : null),
    get: () => ({ state: 'ok' }),
  }
  const calls = []
  let commands = null
  const telegram = { configured: true, chatId: '42', send: async text => { calls.push(text); return { message_id: 900 + calls.length } }, answerCallback: async () => {}, clearButtons: async () => {}, getUpdates: async () => new Promise(() => {}), setCommands: async c => { commands = c } }
  const bot = createBot({ telegram, store, cfg, engine, silences, refresher: {}, audit: { log() {}, refused() {} }, clock: createClock('Europe/Paris'), texts: { status: () => '', digest: () => '' }, allowedIds: '7', network, log: quietLog, now: () => T })
  bot.start()
  bot.stop()
  const out = ['# menu des commandes', ...(commands ?? []).map(c => `/${c.command} — ${c.description}`)]
  const u = x => ({ update_id: 1, ...x })
  const msg = (text, replyTo = null) => u({ message: { message_id: 9, text, from: { id: 7, username: 'u7' }, chat: { id: 42 }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } })
  const cb = data => u({ callback_query: { id: 'cb', data, from: { id: 7, username: 'u7' }, message: { message_id: 555, chat: { id: 42 } } } })
  const step = async (label, x) => {
    calls.length = 0
    await bot.handle(x)
    out.push(`## ${label}`, ...calls)
  }
  for (const c of ['/down', '/silences', '/reseau', '/appareil poste', '/appareil unique', '/mute vps 2', '/mute vps 2h']) await step(c, msg(c))
  for (const [data, answer] of [['n:12', 'connu de longue date'], ['c:00005e005407', 'même téléphone'], ['d:00005e005407', 'autre appareil'], ['a:3', 'motif valable']]) {
    await step(`bouton ${data}`, cb(data))
    await step(`motif pour ${data}`, msg(answer, 900 + calls.length))
  }
  view = { ...view, presence: 'arp', counts: { ...view.counts, online: 1, offline: 1 }, devices: [{ id: 1, state: 'new', name: 'a', online: 0, lastPresent: new Date(T - 2 * H).toISOString() }, { id: 2, state: 'new', name: 'b', online: null }] }
  await step('/reseau (sonde ARP)', msg('/reseau'))
  store.db.close()
  return out.join('\n')
}

// --- network module: real module (test bench), digest section and bot ------------------------------
async function networkBench(NOW) {
  const T = NOW
  const { store } = prodLikeStore({ T: T - 2 * H, k: 2 })
  const b = r3Bench({ T: T - 2 * H, store })
  await b.run(10)
  // a new device seen by the probe and by Pi-hole after alerts were enabled
  const extra = [...FIXTURE_HOSTS, { mac: '00:00:5e:00:53:e7', ip: '192.0.2.207' }]
  await b.run(10, extra)
  const ns = createNetStore(b.store)
  const t = b.clock.t
  const dev = b.store.db.prepare('SELECT id FROM net_devices WHERE host_id IS NOT NULL ORDER BY id LIMIT 3').all().map(r => r.id)
  const loose = b.store.db.prepare('SELECT id FROM net_devices WHERE host_id IS NULL ORDER BY id LIMIT 4').all().map(r => r.id)
  ns.applyOps([
    { op: 'insertEvent', device: dev[0], type: 'port_opened', ts: t - H, detail: 'tcp/22 (ssh)' },
    { op: 'insertEvent', device: dev[0], type: 'port_closed', ts: t - 30 * MIN, detail: 'tcp/80 (http)' },
    { op: 'insertEvent', device: loose[0], type: 'arp_conflict', ts: t - H, detail: 'MAC 00:00:5e:00:53:01 : en-tête Ethernet 00:00:5e:00:53:02' },
    { op: 'insertEvent', device: null, type: 'arp_conflict', ts: t - H, detail: 'IP 192.0.2.9 : 2 MAC (00:00:5e:00:53:03, 00:00:5e:00:53:04)' },
    { op: 'insertEvent', device: loose[1], type: 'returned', ts: t - H, detail: '00:00:5e:00:53:05 revenue après suppression du 2026-11-01 09:00 : prêté' },
    { op: 'insertEvent', device: null, type: 'deleted', ts: t - H, detail: 'dev:99 · x · y · z · known — motif', actor: 'admin (192.0.2.1)' },
  ])
  b.store.kv.set('network.legacyPurge', JSON.stringify({ n: 3 }))
  b.store.kv.set('network.mdnsNamed', JSON.stringify(loose.slice(0, 2)))
  b.store.kv.set('network.arpDiscoveredCount', '2')
  b.store.kv.set('network.arpBootstrapUnknown', JSON.stringify(['a', 'b', 'c']))
  b.store.kv.set('network.arpDiscovered', JSON.stringify(loose.slice(2, 4)))
  b.store.kv.set('network.agentLate', JSON.stringify([{ device: loose[0], key: 'docker-a/web/lan', at: t - H, known: true }]))
  // MAC attached through a validated family (24 h)
  ns.applyOps([{ op: 'upsertMac', mac: 'fe:00:00:00:53:77', device: loose[3], grade: 'weak', random: 1, first_seen: t - H, last_seen: t - H, last_ip: '192.0.2.77', attach: 'rule', confirmed_by: 'rule:1', confirmed_at: t - H }])
  await b.step(2 * MIN, extra)
  return b
}

function networkSignalsOutput(NOW, formatter) {
  const T = NOW
  const devices = new Map([
    [1, { id: 1, state: 'new', origin: 'scan', created_at: T - 10 * MIN, first_seen: T - 3 * DAY, disp_name: null, vendor: null, primary_mac: '00:00:5e:00:53:01', alert_down: 1, online: 0, last_present: T - 2 * H }],
    [2, { id: 2, state: 'known', origin: 'scan', created_at: T - DAY, disp_name: 'poste <b>', primary_mac: '00:00:5e:00:53:02', expected_ip: '192.0.2.2', last_ip: '192.0.2.3', online: 1 }],
    [3, { id: 3, state: 'known', origin: 'scan', created_at: T - DAY, disp_name: null, vendor: 'Fabricant SA', primary_mac: '00:00:5e:00:53:03', online: 1 }],
  ])
  const macs = new Map([
    ['00:00:5e:00:53:01', { mac: '00:00:5e:00:53:01', device_id: 1, random: 1, attach: null, confirmed_at: null }],
    ['00:00:5e:00:53:09', { mac: '00:00:5e:00:53:09', device_id: 2, random: 0, attach: 'name', confirmed_at: null }],
    ['00:00:5e:00:53:0a', { mac: '00:00:5e:00:53:0a', device_id: 3, random: 0, attach: 'ip', confirmed_at: null }],
    ['00:00:5e:00:53:0b', { mac: '00:00:5e:00:53:0b', device_id: 3, random: 0, attach: 'rule', confirmed_at: T - H }],
    ['00:00:5e:00:53:0c', { mac: '00:00:5e:00:53:0c', device_id: 2, random: 0, attach: 'agent', confirmed_at: T - H }],
  ])
  const state = {
    devices, macs, seen: new Map(), retired: ['net_new:9'],
    sources: { pihole: { ok: false, error: 'Pi-hole 401' }, dhcp: { ok: true, stale: true }, neigh: { ok: true, stale: false }, pve: { ok: true, stale: false }, arp: { ok: true, stale: false } },
    flood: { episode: { lastOver: T }, refused: new Set(['a', 'b', 'c']) },
    presence: { since: T - DAY, parentsOf: () => [], probe: 'on' },
    agentConflicts: [{ device: 2, key: 'docker-a/web/lan', other: 1 }, { device: 3, key: 'docker-a/db/lan', other: null, current: 'docker-b/db/lan' }],
  }
  const out = networkSignals(state, { now: T, alertsSince: T - H, tz: 'Europe/Paris' })
  return out.map(s => `## ${s.key} · cond ${s.cond} · ${s.severity}\n${formatter.render('open', { ...s, since: T - 10 * MIN, host: s.host ?? null }, T)}`).join('\n\n')
}

async function networkOutput(NOW, b) {
  const clock = createClock('Europe/Paris')
  const formatter = createFormatter({ dashboardUrl: 'https://vigie.example.net', clock })
  const calls = []
  const telegram = { configured: true, chatId: '42', send: async text => { calls.push(text); return { message_id: calls.length } }, answerCallback: async () => {}, getUpdates: async () => [], setCommands: async () => {} }
  const cfg = parseConfig(rawConfig()).config
  const engine = { active: () => [], byIncident: () => null, get: () => null }
  const audit = { log() {}, refused() {} }
  const bot = createBot({ telegram, store: b.store, cfg, engine, silences: { active: () => [] }, refresher: {}, audit, clock, texts: { status: () => '', digest: () => '' }, allowedIds: '7', network: b.network, log: quietLog, now: () => b.clock.t })
  const ask = async text => {
    calls.length = 0
    await bot.handle({ update_id: 1, message: { message_id: 9, text, from: { id: 7, username: 'u7' }, chat: { id: 42 } } })
    return `## ${text}\n${calls.join('\n')}`
  }
  const replies = []
  for (const c of ['/reseau', '/appareil', '/appareil zzzz-aucun', '/appareil invite', '/appareil 00:00:5e:00:53:e7']) replies.push(await ask(c))
  // header without a new device: "0 nouveau" (plural at 0)
  b.store.db.prepare("UPDATE net_devices SET state = 'known' WHERE state = 'new'").run()
  await b.step(2 * MIN)
  replies.push(await ask('/reseau'))
  const digest = b.network.digestLines({ now: b.clock.t }).join('\n')
  return `${networkSignalsOutput(NOW, formatter)}\n\n# section Réseau du digest\n${digest}\n\n# section Réseau sans sonde ARP\n${await networkPiholeDigest(NOW)}\n\n# bot\n${replies.join('\n\n')}\n`
}

// --- /status, acknowledgments, buttons, plugin_error, bot --------------------------------------------
async function extrasOutput(storeDir, NOW) {
  const out = []
  let statusLines = null
  try { ({ statusLines } = await import('../../lib/notify/status.js')) } catch { statusLines = null }
  const full = { state: 'crit', alerts: { critical: 2, warning: 1, masked: 3 }, services: { ok: 4, total: 5, crit: 1 }, guests: { running: 6, total: 8, stoppedDeclared: ['ct-<a>', 'vm-b'] }, backups: [{ node: 'n1', ok: 3, total: 4 }, { node: 'n<2>', error: 'x' }], sourcesDown: ['pve', 'pihole'] }
  const calm = { state: 'ok', alerts: { critical: 0, warning: 0, masked: 0 }, services: { ok: 5, total: 5, crit: 0 }, guests: { running: 8, total: 8, stoppedDeclared: [] }, backups: [], sourcesDown: [] }
  out.push('# /status', statusLines ? statusLines({ s: full, u: { total: 7, security: 2 }, silences: 1 }) : '(absent)', statusLines ? statusLines({ s: calm, u: { total: 0, security: 0 }, silences: 0 }) : '(absent)')
  out.push('', '# acquittements depuis le dashboard', ackMessage(['Disque / · <web>'], 'motif <b>'), ackMessage(['a', 'b', 'c', 'd', 'e', 'f'], 'lot'), ackMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'lot'))
  out.push('', '# boutons', ...[{ key: 'net_new:12' }, { key: 'net_mac_added:00:00:5e:00:53:01' }, { key: 'r:1', incident_id: 7 }].map(r => JSON.stringify(buttonsFor(r, 'titre'))))
  // plugin_error: plugin refused (reserved id), failing hook, core module
  const plug = (id, fn) => definePlugin({ id, apiVersion: 0, configured: () => true, setup: () => ({ rules: [`${id}_rule`], signals: fn }) })
  const host = createHost({ cfg: {}, log: quietLog, reservedIds: ['backups'], plugins: [plug('backups', () => []), plug('demo', () => { throw new Error('boom <x>') })] })
  out.push('', '# plugin_error', ...host.signals({}, NOW).filter(s => s.rule === 'plugin_error').map(s => `${s.key} · ${s.title} · ${s.detail}`))
  // bot: replies outside bot.txt (refresh started, already running, finished; known; unmute)
  const cfg = parseConfig(rawConfig()).config
  const store = openDb(storeDir)
  const silences = createSilences({ store, now: () => NOW })
  const calls = []
  const telegram = { configured: true, chatId: '42', send: async text => { calls.push(text); return { message_id: calls.length } }, answerCallback: async () => {}, getUpdates: async () => [], setCommands: async () => {} }
  let resolveDone
  const done = new Promise(r => { resolveDone = r })
  let runs = 0
  const refresher = { run: () => ({ started: runs++ === 0, done }) }
  const engine = { active: () => [], byIncident: () => null, get: () => null, unack: () => false }
  const network = { enabled: true, writes: { ack: ({ ids }) => ({ done: ids[0] === 12 ? ids : [] }) }, bot: { act: () => ({ ok: true }) }, view: () => ({ presence: 'arp', counts: {}, sources: {}, devices: [] }), search: () => [] }
  const bot = createBot({ telegram, store, cfg, engine, silences, refresher, audit: { log() {}, refused() {} }, clock: createClock('Europe/Paris'), texts: { status: () => '', digest: () => '' }, allowedIds: '7', network, log: quietLog, now: () => NOW })
  const ask = async text => {
    calls.length = 0
    await bot.handle({ update_id: 1, message: { message_id: 9, text, from: { id: 7, username: 'u7' }, chat: { id: 42 } } })
    return `## ${text}\n${calls.join('\n')}`
  }
  out.push('', '# bot')
  out.push(await ask('/refresh'))
  out.push(await ask('/refresh'))
  calls.length = 0
  resolveDone({ startedAt: NOW, finishedAt: NOW + 12_000 })
  await new Promise(r => setImmediate(r))
  out.push(`## fin du passage\n${calls.join('\n')}`)
  for (const c of ['/connu', '/connu 12 x', '/connu 12 téléphone prêté', '/connu 13 déjà vu', '/unack 999', '/mute vps 2h migration', '/silences', '/unmute 1']) out.push(await ask(c))
  store.db.close()
  return `${out.join('\n')}\n`
}

export async function coverageOutputs({ storeDir, NOW }) {
  const b = await networkBench(NOW)
  const out = {
    'notify-cycle.txt': await cycleOutput(`${storeDir}-cycle`, NOW),
    'digest-full.txt': await digestOutput(`${storeDir}-digest`, NOW, b.network),
    'network.txt': await networkOutput(NOW, b),
    'extras.txt': `${await extrasOutput(`${storeDir}-extras`, NOW)}\n${await botFakeNetworkOutput(`${storeDir}-botnet`, NOW)}\n`,
    'rules-extra.txt': await rulesExtraOutput(`${storeDir}-rules`, NOW),
  }
  b.network.stop?.()
  return out
}
export { tmpDir }

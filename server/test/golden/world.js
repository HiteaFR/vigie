// Frozen world of the golden tests. Neutral inputs (example.net, RFC 5737), frozen clock and
// randomness, no network call: Proxmox and Gitea answer through an injected fetch, the agents, the
// probes and the network module are deterministic test benches. The outputs (signals, digest, summary,
// Gitea responses, notifications) are computed by the real server code, without changing it.
// Shared by golden.test.js (comparison) and update.js (deliberate update of the goldens).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../../lib/config.js'
import { createSources } from '../../lib/sources.js'
import { createCollector } from '../../lib/alerts/collect.js'
import { createMonitor } from '../../lib/monitor.js'
import { createRules, CORE_RULES, RULE_LABEL } from '../../lib/alerts/rules.js'
import { createEngine } from '../../lib/alerts/engine.js'
import { createSilences } from '../../lib/alerts/silences.js'
import { createClock } from '../../lib/clock.js'
import { createFormatter } from '../../lib/notify/format.js'
import { createNotifier } from '../../lib/notify/notifier.js'
import { buildDigest } from '../../lib/notify/digest.js'
import { summary } from '../../lib/status.js'
import { createUpdates } from '../../lib/updates/index.js'
import { openDb } from '../../lib/db.js'
import { createHost, definePlugin } from '../../lib/plugins/host.js'
import { cleanSlow } from '../../lib/agents.js'
import { coreModules, CORE_MODULE_RULES, RESERVED_PLUGIN_IDS } from '../../lib/plugins/core.js'
import { createHttp } from '../../lib/http.js'
import { PLUGINS } from '../../plugins/index.js'
import { registryOutputs } from './registries.js'
import { outboxOutput, policyOutput, botOutput } from './notify.js'
import { setLocale } from '../../lib/i18n.js'

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url))
export const NOW = Date.parse('2026-11-10T09:00:00Z') // 10:00 in Paris: outside quiet hours
const MIN = 60_000
const H = 60 * MIN
const S = ms => Math.floor(ms / 1000)
// disk of CTs without an agent, from Proxmox: bounds of 85 / 95 (hysteresis 2)
const GUEST_DISK = [82.9, 83, 84.9, 85, 94.9, 95]

// --- config: the reference test config, agents added on two hosts -------------------------------
export function rawConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, '..', 'fixtures', 'config.reference.json'), 'utf8'))
  // explicit French instance (English is the product default); the French goldens keep it
  raw.locale = 'fr'
  for (const h of raw.hosts) if (h.id === 'docker-a' || h.id === 'dns-a') h.agent = 'ssh'
  // guest numbers outside the 100-120 range (that of a real fleet), for neutral outputs
  const vmid = { 101: 211, 102: 212 }
  for (const h of raw.hosts) if (vmid[h.vmid]) h.vmid = vmid[h.vmid]
  // values at the bounds of each threshold rule; two more agents (apt lists),
  // backups read on a storage, services dedicated to probe and certificate thresholds
  for (const h of raw.hosts) if (h.id === 'lab' || h.id === 'vps') h.agent = 'ssh'
  // disk of CTs without an agent, from Proxmox (85 / 95, hysteresis 2), critical bounds included
  for (const [i, p] of GUEST_DISK.entries()) raw.hosts.push({ id: `ct-d${String(p).replace('.', '')}`, name: `ct-disque-${p}`, kind: 'lxc', pve: 'main', vmid: 231 + i, ip: `192.0.2.${131 + i}`, parent: 'pve-a', env: 'prod' })
  // absolute free space threshold (alerts.diskFreeMinGB): dev workstation with an agent, outside Proxmox (no
  // backup expected), above the threshold here (no alert: numbers and counters unchanged);
  // raised and bounds in rules-extra.txt (coverage.js)
  raw.hosts.push({ id: 'ws', name: 'poste-dev', kind: 'external', ip: '192.0.2.141', env: 'dev', agent: 'ssh', alerts: { diskFreeMinGB: 12 } })
  raw.proxmox[0].backups = { mode: 'storage', node: 'pve-a', storage: 'tank' }
  const svc = (id, check) => ({ id, name: id, group: 'web', host: 'vps', checks: [check] })
  raw.services.push(
    // failAfter (3): 2 failures → nothing, 3 → down; recoverAfter (2): 1 success → nothing, 2 → recovered
    svc('fail-2', { type: 'tcp', target: '192.0.2.61:22' }), svc('fail-3', { type: 'tcp', target: '192.0.2.62:22' }),
    svc('ok-1', { type: 'tcp', target: '192.0.2.63:22' }), svc('ok-2', { type: 'tcp', target: '192.0.2.64:22' }),
    // certificates: warning under 21 days, critical under 7 days
    ...[20, 21, 6, 7].map(d => svc(`cert-${d}`, { type: 'tls', host: `cert-${d}.example.net` })),
  )
  return raw
}
export const CFG = parseConfig(rawConfig()).config
export const ENV = { GITEA_URL: 'http://gitea.example.net', GITEA_TOKEN: 'jeton-de-banc', PVE_TOKEN_ID: 'banc@pve!golden', PVE_TOKEN_SECRET: 'secret-de-banc' }

// --- fake Proxmox and fake Gitea ------------------------------------------------------------------
// nodes at the bounds: memory (90 / 95, hysteresis 2; RAM used = total - available) and swap
// (50, hysteresis 5), out of 1000
const NODES = [
  { node: 'mem-87.9', available: 121, swap: 449 }, { node: 'mem-88', available: 120, swap: 450 },
  { node: 'mem-89.9', available: 101, swap: 499 }, { node: 'mem-90', available: 100, swap: 500 },
  { node: 'mem-94.9', available: 51, swap: 0 }, { node: 'mem-95', available: 50, swap: 0 },
]
const DISKS = [72, 73, 74, 75, 79, 80].map((temp, i) => ({ dev: `/dev/nvme${i}n1`, temp, wear: [9, 10, 11, 50, 50, 50][i] }))
const run = (n, branch, status, sha, title) => ({ run_number: n, head_branch: branch, status, head_sha: sha, display_title: title, updated: '2026-11-10T08:30:00Z' })
const commit = (sha, message) => [{ sha, html_url: `http://gitea.example.net/example/x/commit/${sha}`, commit: { message: `${message}\n\ncorps`, author: { name: 'dev', date: '2026-11-10T08:00:00Z' } } }]
const API = {
  // Gitea
  '/api/v1/users/example/repos?limit=50': [{ name: 'app' }, { name: 'site' }, { name: 'infra' }, { name: 'casse' }],
  '/api/v1/repos/example/app': { default_branch: 'main', html_url: 'http://gitea.example.net/example/app' },
  '/api/v1/repos/example/app/commits?limit=1&stat=false&verification=false': commit('aaaaaaa1111', 'app : correctif'),
  '/api/v1/repos/example/app/pulls?state=open&limit=50': [{ id: 1 }, { id: 2 }],
  '/api/v1/repos/example/app/actions/tasks?limit=10': { workflow_runs: [run(12, 'main', 'failure', 'aaaaaaa1111', 'app : correctif'), run(11, 'main', 'success', 'bbbbbbb2222', 'app : avant')] },
  '/api/v1/repos/example/site': { default_branch: 'main' },
  '/api/v1/repos/example/site/commits?limit=1&stat=false&verification=false': commit('ccccccc3333', 'site : texte'),
  '/api/v1/repos/example/site/pulls?state=open&limit=50': [],
  '/api/v1/repos/example/site/actions/tasks?limit=10': { workflow_runs: [run(7, 'main', 'success', 'ccccccc3333', 'site : texte')] },
  '/api/v1/repos/example/infra': { default_branch: 'main' },
  '/api/v1/repos/example/infra/commits?limit=1&stat=false&verification=false': commit('ddddddd4444', 'infra : en cours'),
  '/api/v1/repos/example/infra/pulls?state=open&limit=50': [{ id: 3 }],
  '/api/v1/repos/example/infra/actions/tasks?limit=10': { workflow_runs: [run(31, 'main', 'running', 'ddddddd4444', 'infra : en cours'), run(30, 'main', 'success', 'eeeeeee5555', 'infra : avant')] },
  '/api/v1/admin/actions/runners': { runners: [
    { id: 2, name: 'runner-b', status: 'offline', busy: false, labels: [{ name: 'ubuntu-latest' }] },
    { id: 1, name: 'runner-a', status: 'online', busy: true, labels: [{ name: 'ubuntu-latest' }, { name: 'banc' }] },
  ] },
  // Proxmox ("main" cluster, node pve-a)
  '/api2/json/cluster/resources': { data: [
    { type: 'node', node: 'pve-a', status: 'online', cpu: 0.1, maxcpu: 8, mem: 8e9, maxmem: 16e9, disk: 1e10, maxdisk: 1e11, uptime: 1e6 },
    { type: 'qemu', vmid: 211, name: 'docker-a', node: 'pve-a', status: 'running', maxmem: 4e9, mem: 2e9, uptime: 1e5 },
    { type: 'lxc', vmid: 212, name: 'dns-a', node: 'pve-a', status: 'running', maxmem: 1e9, mem: 2e8, uptime: 1e5 },
    { type: 'qemu', vmid: 200, name: 'lab', node: 'pve-a', status: 'stopped' },
    { type: 'lxc', vmid: 300, name: 'inconnu', node: 'pve-a', status: 'running' },
    { type: 'storage', storage: 'local', node: 'pve-a', status: 'available', disk: 95e9, maxdisk: 100e9 },
    { type: 'storage', storage: 'tank', node: 'pve-a', status: 'available', disk: 10e9, maxdisk: 100e9 },
    // storage (80 / 90, hysteresis 2), at the bounds
    ...GUEST_DISK.map((p, i) => ({ type: 'lxc', vmid: 231 + i, name: `ct-disque-${p}`, node: 'pve-a', status: 'running', disk: p, maxdisk: 100 })),
    ...[77.9, 78, 79.9, 80, 89.9, 90].map(p => ({ type: 'storage', storage: `st-${p}`, node: 'pve-a', status: 'available', disk: p, maxdisk: 100 })),
  ] },
  // backups read on the tank storage (backupMaxAgeHours 26, strict comparison)
  '/api2/json/cluster/backup': { data: [{ id: 'job-1', enabled: 1, schedule: '02:00', vmid: '211,212' }] },
  '/api2/json/cluster/resources?type=vm': { data: [
    { type: 'qemu', vmid: 211, name: 'docker-a', node: 'pve-a', status: 'running' },
    { type: 'lxc', vmid: 212, name: 'dns-a', node: 'pve-a', status: 'running' },
    { type: 'qemu', vmid: 200, name: 'lab', node: 'pve-a', status: 'stopped' },
  ] },
  '/api2/json/nodes/pve-a/tasks?typefilter=vzdump&limit=14': { data: [] },
  '/api2/json/nodes/pve-a/storage/tank/content?content=backup': { data: [
    { volid: 'tank:backup/a', vmid: 211, ctime: S(NOW - 26 * H) },        // exactly 26 h → up to date
    { volid: 'tank:backup/b', vmid: 212, ctime: S(NOW - 26 * H) - 1 },    // 26 h + 1 s → late
    { volid: 'tank:backup/c', vmid: 200, ctime: S(NOW - 25 * H) },
  ] },
  '/api2/json/nodes': { data: [{ node: 'pve-a', status: 'online' }, ...NODES.map(n => ({ node: n.node, status: 'online' }))] },
  ...Object.fromEntries(NODES.flatMap(n => [
    [`/api2/json/nodes/${n.node}/status`, { data: { memory: { total: 1000, used: 1000 - n.available, available: n.available }, swap: { total: 1000, used: n.swap }, uptime: 1 } }],
    [`/api2/json/nodes/${n.node}/disks/list`, { data: [] }],
  ])),
  '/api2/json/nodes/pve-a/status': { data: { pveversion: 'pve-manager/8.4.1/abc', kversion: 'Linux 6.8.12-4-pve #1', cpuinfo: { model: 'CPU de banc', cpus: 8 }, loadavg: ['0.5', '0.4', '0.3'], wait: 0.01, uptime: 1e6, memory: { total: 16e9, used: 15.5e9, available: 0.5e9 }, swap: { total: 4e9, used: 3e9 }, rootfs: { total: 1e11, used: 5e10, avail: 5e10 } } },
  '/api2/json/nodes/pve-a/disks/list': { data: [
    { devpath: '/dev/sda', type: 'ssd', model: 'SSD_de_banc', size: 5e11, health: 'PASSED', wearout: 15 },
    { devpath: '/dev/sdb', type: 'hdd', model: 'HDD_de_banc', size: 4e12, health: 'FAILED', wearout: null },
    // temperature (75 / 80 °C, hysteresis 2) and wear (remaining life <= 10 %), at the bounds
    ...DISKS.map(d => ({ devpath: d.dev, type: 'ssd', model: 'SSD_borne', size: 1e11, health: 'PASSED', wearout: d.wear })),
  ] },
  ...Object.fromEntries(DISKS.map(d => [`/api2/json/nodes/pve-a/disks/smart?disk=${encodeURIComponent(d.dev)}`, { data: { health: 'PASSED', type: 'text', text: `Temperature: ${d.temp} Celsius` } }])),
  '/api2/json/nodes/pve-a/disks/smart?disk=%2Fdev%2Fsda': { data: { health: 'PASSED', type: 'text', text: 'Temperature_Celsius 194 194 000 Old_age Always - 38' } },
  '/api2/json/nodes/pve-a/disks/smart?disk=%2Fdev%2Fsdb': { data: { health: 'FAILED', type: 'text', text: '' } },
}
export function fakeFetch(url) {
  const u = new URL(url)
  const body = API[u.pathname + u.search]
  if (body === undefined) return Promise.resolve(new Response(JSON.stringify({ error: 'absent du banc' }), { status: 404 }))
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
}

// --- collector snapshot: the real sources on the fake fetch ---------------------------------------
export async function collectorSnap(sources, extra = []) {
  let t = 0
  const timers = []
  const c = createCollector(sources, { setTimer: (fn, ms) => timers.push({ fn, ms }), random: () => 0.5, now: () => NOW + t++, extra })
  // real startup: a first pass per source (start timer), then the reread
  // period it schedules; unconfigured sources: neither start nor period
  c.start()
  const off = new Set(extra.filter(x => x.configured === false).map(x => x.name))
  const names = Object.keys(c.snap).filter(n => sources.configured?.[n] !== false && !off.has(n))
  const first = timers.splice(0)
  const periods = {}
  for (const [i, x] of first.entries()) {
    await x.fn()
    periods[names[i]] = { startMs: x.ms, periodMs: timers.at(-1).ms }
  }
  return { snap: c.snap, periods }
}

// --- test benches: probes, agents, network ---------------------------------------------------------
export function monitorStub(cfg) {
  const real = createMonitor(cfg) // never started: only the list of probes
  const results = {
    'dns#0': { state: 'crit', fails: 5, latencyMs: null, code: null, error: 'NXDOMAIN', checkedAt: NOW - MIN },
    'dns#1': { state: 'ok', fails: 0, latencyMs: 3, code: null, error: null, checkedAt: NOW - MIN },
    'app#0': { state: 'ok', fails: 0, latencyMs: 42, code: 200, error: null, checkedAt: NOW - MIN },
    'site#0': { state: 'warn', fails: 0, latencyMs: 80, code: null, error: null, checkedAt: NOW - MIN, tls: { daysLeft: 9, validTo: NOW + 9 * 24 * H } },
  }
  const tcp = (state, fails, oks) => ({ state, fails, oks, latencyMs: state === 'ok' ? 1 : null, code: null, error: state === 'ok' ? null : 'refusé', checkedAt: NOW - MIN })
  Object.assign(results, { 'fail-2#0': tcp('crit', 2, 0), 'fail-3#0': tcp('crit', 3, 0), 'ok-1#0': tcp('ok', 0, 1), 'ok-2#0': tcp('ok', 0, 2) })
  for (const d of [20, 21, 6, 7]) results[`cert-${d}#0`] = { state: 'ok', fails: 0, oks: 5, latencyMs: null, code: null, error: null, checkedAt: NOW - MIN, tls: { daysLeft: d, validTo: NOW + d * 24 * H } }
  return { checks: real.checks, result: id => results[id] ?? null, completed: real.checks.length }
}
export function agentsStub(cfg) {
  const fast = {
    version: 8,
    fs: [
      { mount: '/', size: 100, used: 93, avail: 7, inodes: { total: 1000, used: 400 } },
      // disk (85 / 95, hysteresis 2) and inodes (same thresholds), at the bounds
      ...[82.9, 83, 84.9, 85, 94.9, 95].map(p => ({ mount: `/disque-${p}`, size: 100, used: p, avail: 100 - p, inodes: { total: 1000, used: 10 } })),
      ...[829, 830, 849, 850, 949, 950].map(u => ({ mount: `/inodes-${u / 10}`, size: 0, used: 0, avail: 0, inodes: { total: 1000, used: u } })),
    ],
    docker: { containers: [{ name: 'web', state: 'running', health: 'unhealthy', restarts: 0, recentRestarts: 0 }, { name: 'worker', state: 'restarting', health: null, restarts: 9, recentRestarts: 5 }] },
    systemd: { failed: ['backup.service'], watched: [{ unit: 'docker.service', active: 'active' }] },
    reboot: { required: true, reason: 'noyau mis à jour' },
  }
  const states = {
    'docker-a': { ok: true, at: NOW - MIN, error: null, fast, slow: null },
    'dns-a': { ok: false, at: NOW - MIN, error: 'connexion refusée', errorKind: 'other', fast: null, slow: null },
  }
  // apt lists (aptMaxAgeDays 7, strict comparison): exactly 7 days → nothing, 7 days + 1 s → alert
  const quiet = { version: 7, fs: [], docker: null, systemd: null, reboot: { required: false } }
  const apt = age => ({ version: 7, apt: { listsAt: S(NOW - age), upgradable: 0, security: 0, packages: [] } })
  // automatic security updates on lab (agent v7): one "versions" line in the digest (updates)
  states.lab = { ok: true, at: NOW - MIN, slowAt: NOW - MIN, error: null, fast: quiet, slow: cleanSlow({ ...apt(7 * 24 * H), ts: S(NOW),
    autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: S(NOW - 4 * H), lastResult: 'success', applied: [{ name: 'openssl', version: '1.0-2' }, { name: 'tzdata', version: '2026a' }] } }) }
  states.vps = { ok: true, at: NOW - MIN, error: null, fast: quiet, slow: apt(7 * 24 * H + 1000) }
  // poste-dev: 60 GiB root with 20 free (threshold 12 + 1 exceeded: disk_free recovered)
  const GIB = 1024 ** 3
  states.ws = { ok: true, at: NOW - MIN, error: null, slow: null,
    fast: { version: 8, fs: [{ mount: '/', size: 60 * GIB, used: 40 * GIB, avail: 20 * GIB, inodes: { total: 1000, used: 100 } }], docker: null, systemd: null, reboot: { required: false } } }
  return { hosts: cfg.hosts.filter(h => h.agent), get: id => states[id] ?? { ok: null }, reports: () => [] }
}
export const networkStub = {
  signals: (now, { parentsOf }) => [
    { key: 'net_new:dev-1', rule: 'net_new', entity: 'dev-1', title: 'Nouvel appareil 02:00:00:00:00:99', env: 'prod', cond: true, severity: 'warning', detail: '192.0.2.99', link: '/network?d=dev-1', parents: parentsOf('router') },
  ],
  digestLines: () => ['🌐 Réseau : 12 appareils, 1 nouveau'],
  summary: () => ({ devices: 12, online: 10, new: 1 }),
  alertsSince: 0,
}

// --- full world ------------------------------------------------------------------------------------
// host like index.js's: internal plugins (gitea), plus the witness plugin, on the fake fetch
const quietLog = { log() {}, warn() {}, error() {} }
// witness plugin in the "ci" slot of the digest: the order of modules (core, then plugins) and the
// slot of each are covered (a versions line placed in "ci" would come before it)
const temoin = definePlugin({ id: 'temoin', apiVersion: 0, configured: () => true, setup: () => ({ digest: { slot: 'ci', lines: () => ['🔖 témoin (créneau ci)'] } }) })
// extraPlugins: extra test plugins (e.g. the message masking sentinel)
export const worldHost = ({ cfg = CFG, env = ENV, store = null, extraPlugins = [] } = {}) => createHost({
  cfg, env, store, log: quietLog, coreRules: CORE_RULES, reservedRules: CORE_MODULE_RULES, reservedIds: RESERVED_PLUGIN_IDS, plugins: [...PLUGINS, temoin, ...extraPlugins],
  http: createHttp({ fetch: fakeFetch, defaultSecret: true }),
})

export async function buildWorld({ storeDir, extraPlugins = [], env = ENV }) {
  const cfg = CFG
  const store = openDb(storeDir)
  const host = worldHost({ store, extraPlugins, env })
  // a world can be rebuilt in another locale (English golden): the rule labels of the
  // plugins set by a previous world are removed first (in prod, a single locale per process)
  for (const rule of Object.keys(host.labels({}))) if ('value' in (Object.getOwnPropertyDescriptor(RULE_LABEL, rule) ?? {})) delete RULE_LABEL[rule]
  Object.assign(RULE_LABEL, host.labels(RULE_LABEL))
  const sources = createSources(cfg, ENV, { fetch: fakeFetch, now: () => NOW })
  const { snap, periods } = await collectorSnap(sources, host.collectors())
  const monitor = monitorStub(cfg)
  const agents = agentsStub(cfg)
  const upstream = { github: async () => [], githubTags: async () => [], giteaCom: async () => [], pypi: async () => [], eol: async () => [], node: async () => [], httpJson: async () => null, remoteDigest: async () => null, remoteTags: async () => [], pvePackages: async () => [], errors: () => [], stats: () => ({}) }
  const updates = createUpdates({ cfg, store, agents, sources: { pveVersions: async () => [] }, collector: { snap }, upstream, decisions: null, log: { error() {} }, extraComponents: () => host.components() })
  await updates.refresh(NOW)
  // like index.js, the core modules (versions, network) go through the host
  for (const m of coreModules({ updates, network: networkStub })) host.addModule(m)
  const rules = createRules(cfg, monitor, agents, updates, null, null, null, { host })
  return { cfg, sources, snap, periods, monitor, agents, store, updates, rules, host }
}

// fake Telegram: each send is kept, in order (text, silent, buttons)
export function fakeTelegram() {
  const sent = []
  return { configured: true, sent, send: async (text, opts = {}) => { sent.push({ text, ...opts }) } }
}

// real engine and notifier on the world: successive evaluations (triggers after
// forSec and failAfter), then flushing the queue to the fake Telegram
export async function notifications(w) {
  const clock = createClock(w.cfg.alerts.timezone)
  const telegram = fakeTelegram()
  const formatter = createFormatter({ dashboardUrl: w.cfg.alerts.dashboardUrl, clock })
  const notifier = createNotifier({ cfg: w.cfg, store: w.store, clock, telegram, formatter, buttons: true, log: { error() {}, warn() {}, log() {} } })
  const silences = createSilences({ store: w.store })
  const start = NOW - 2 * H
  const engine = createEngine({ cfg: w.cfg, store: w.store, rules: w.rules, notifier, clock, silences, startedAt: start - H })
  for (let t = start; t <= NOW; t += 5 * MIN) engine.evaluate(w.snap, t)
  await notifier.flush(NOW)
  return { engine, notifier, formatter, clock, silences, sent: telegram.sent }
}

// second phase, after the digest and the summary: app's CI goes green again and runner-b comes back
// online → resolution notifications
export async function resolutions(w, n) {
  const snap = structuredClone(w.snap)
  for (const r of snap.gitea.data) if (r.name === 'app') r.mainRun.status = 'success'
  for (const x of snap.runners.data) x.status = 'online'
  for (let t = NOW + 5 * MIN; t <= NOW + 20 * MIN; t += 5 * MIN) n.engine.evaluate(snap, t)
  await n.notifier.flush(NOW + 20 * MIN)
  return n.sent
}

// --- readable outputs ------------------------------------------------------------------------------
// values of a signal: functions dropped, keys sorted
const plain = v => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x)))
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v)
export const json = v => `${JSON.stringify(sortKeys(plain(v)), null, 2)}\n`

// each on a fresh world (its own database), so as not to change the other outputs
async function notifyOutputs(storeDir) {
  const w1 = await buildWorld({ storeDir: `${storeDir}-outbox` })
  const outbox = await outboxOutput(w1, NOW)
  w1.store.db.close()
  const w2 = await buildWorld({ storeDir: `${storeDir}-bot` })
  const bot = await botOutput(w2, NOW)
  w2.store.db.close()
  return { 'outbox.txt': outbox, 'notify-policy.txt': policyOutput(CFG), 'bot.txt': bot }
}

// locale: the one from the world config (fr), or another (English golden); set here, never assumed
export async function outputs({ storeDir, locale = CFG.locale }) {
  setLocale(locale)
  const w = await buildWorld({ storeDir })
  const signals = w.rules.evaluate(w.snap, NOW).map(plain).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const n = await notifications(w)
  const servicesView = () => w.cfg.services.map(s => {
    const checks = w.monitor.checks.filter(c => c.serviceId === s.id).map(c => ({ id: c.id, type: c.type, state: w.monitor.result(c.id)?.state ?? 'unknown' }))
    const order = ['crit', 'warn', 'unknown', 'ok']
    const state = checks.length ? order.find(x => checks.some(c => c.state === x)) ?? 'ok' : 'none'
    return { id: s.id, name: s.name, env: s.env ?? w.cfg.hosts.find(h => h.id === s.host)?.env, state, checks }
  })
  const sum = env => ({ ...summary({ cfg: w.cfg, snap: w.snap, monitor: w.monitor, engine: n.engine, servicesView, host: w.host, env, now: NOW }), weather: null })
  const digest = buildDigest({ cfg: w.cfg, engine: n.engine, snap: w.snap, monitor: w.monitor, formatter: n.formatter, clock: n.clock, host: w.host, silences: n.silences, mark: false, now: NOW })
  // Gitea not configured (no GITEA_URL): digest and summary "not configured"
  const offEnv = { PVE_TOKEN_ID: ENV.PVE_TOKEN_ID, PVE_TOKEN_SECRET: ENV.PVE_TOKEN_SECRET }
  const off = createSources(w.cfg, offEnv, { fetch: fakeFetch, now: () => NOW })
  const offHost = worldHost({ env: offEnv })
  const offSnap = (await collectorSnap(off, offHost.collectors())).snap
  const digestOff = buildDigest({ cfg: w.cfg, engine: n.engine, snap: offSnap, monitor: w.monitor, formatter: n.formatter, clock: n.clock, host: w.host, silences: n.silences, mark: false, now: NOW })
  const ciOff = summary({ cfg: w.cfg, snap: offSnap, monitor: w.monitor, engine: n.engine, servicesView, host: w.host, now: NOW }).ci
  const rulesOff = w.rules.evaluate(offSnap, NOW).filter(s => /^(ci_failed|runner_offline):|^source_error:(gitea|runners)$/.test(s.key)).map(s => s.key)
  const deploy = w.updates.view().components.filter(c => c.kind === 'deploy')
  // response of /api/gitea and /api/runners: reading the plugin sources
  const read = name => w.host.collectors().find(c => c.name === name).fn()
  const summaries = { all: strip(sum('all')), prod: strip(sum('prod')), dev: strip(sum('dev')), ciGiteaOff: ciOff, ciRulesGiteaOff: rulesOff }
  const sent = await resolutions(w, n)
  // incidents in opening order (number, key, severity, opening and
  // resolution in UTC). On the first pass, ci_failed:app opens with agent signals without forSec
  // (guest_disk, container_restarting, reboot_required of docker-a): the number of each depends on the
  // slot of the gitea plugin signals (signalsAt 'ci': before the agents), which Telegram does not show
  const hm = t => (t == null ? '—' : new Date(t).toISOString().slice(11, 16))
  const incidents = n.engine.incidents(0, 1000).sort((a, b) => a.id - b.id)
    .map(i => `#${i.id} ${i.key} · ${i.severity} · ouvert ${hm(i.startedAt)} · résolu ${hm(i.resolvedAt)}`)
  const out = {
    'signals.json': json(signals),
    'digest.txt': `${digest}\n`,
    'digest-gitea-off.txt': `${digestOff}\n`,
    'summary.json': json(summaries),
    'gitea.json': json({ gitea: await read('gitea'), runners: await read('runners'), configuredOff: Object.fromEntries(offHost.collectors().map(c => [c.name, c.configured])) }),
    'collector.json': json({ snapNames: Object.keys(w.snap), periods: w.periods, snapErrors: Object.fromEntries(Object.entries(w.snap).map(([k, v]) => [k, v?.error ?? null])) }),
    'updates-deploy.json': json(deploy),
    'incidents.txt': `${incidents.join('\n')}\n`,
    // registries (probes, config errors, widgets, update sources, service definitions)
    ...(await registryOutputs()),
    // send queue after Telegram outages, sending policy and deferred, bot replies
    ...(await notifyOutputs(storeDir)),
    // coverage of the Telegram texts (cycle, full digest, network, extras)
    ...(await (await import('./coverage.js')).coverageOutputs({ storeDir: `${storeDir}-cov`, NOW })),
    'telegram.txt': sent.map((m, i) => `--- message ${i + 1} (silencieux : ${!!m.silent}${m.html === false ? ', texte brut' : ''}${m.replyMarkup ? `, boutons : ${JSON.stringify(m.replyMarkup)}` : ''})\n${m.text}\n`).join('\n'),
  }
  w.store.db.close()
  return out
}
// the same outputs in English (same world, "en" locale) for the texts read by a person;
// <name>.en.txt references next to the French ones, which do not change
export const EN_FILES = ['telegram.txt', 'incidents.txt', 'digest.txt', 'digest-gitea-off.txt', 'notify-cycle.txt', 'digest-full.txt',
  'network.txt', 'extras.txt', 'rules-extra.txt', 'outbox.txt', 'bot.txt']
export const enName = f => f.replace(/\.txt$/, '.en.txt')
export async function englishOutputs({ storeDir }) {
  try {
    const out = await outputs({ storeDir, locale: 'en' })
    return Object.fromEntries(EN_FILES.map(f => [enName(f), out[f]]))
  } finally {
    setLocale(CFG.locale)
  }
}

// generatedAt is already frozen by now; nothing else to remove, but a possible generation
// date must never enter a golden
function strip(o) {
  const { generatedAt, ...rest } = o
  return { generatedAt: generatedAt === new Date(NOW).toISOString() ? '(NOW)' : generatedAt, ...rest }
}

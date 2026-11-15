// Golden of the client VIEWS, frozen on the code from before the text extraction (48988e7): real
// rendering (the client's esbuild and react-dom/server, like client.js) of every view, drawer and the
// frame, with sample data (no request), as readable text: visible text block by block, then the
// attributes a person reads (aria-label, title, placeholder, alt). Frozen clock
// (2026-11-10 09:00 UTC, Europe/Paris time zone), so absolute and relative dates are stable.
// client-views.txt: in French, identical before and after the extraction; client-views.en.txt: the
// same in English, same data (their texts, coming from the server, stay in French).
// Neutral data: RFC 5737 addresses, example.net domains.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../tmpdir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
export const CLIENT_INSTALLED = fs.existsSync(path.join(ROOT, 'client/node_modules/esbuild/lib/main.js'))
export const NOW = Date.parse('2026-11-10T09:00:00Z')
const TZ = 'Europe/Paris'

const VIEWS = {
  App: './src/App.jsx',
  Services: './src/views/Services.jsx',
  Infra: './src/views/Infra.jsx',
  Network: './src/views/Network.jsx',
  Updates: './src/views/Updates.jsx',
  Backups: './src/views/Backups.jsx',
  Alerts: './src/views/Alerts.jsx',
  Integrations: './src/views/Integrations.jsx',
  Mural: './src/views/Mural.jsx',
  Cockpit: './src/views/Cockpit.jsx',
  Ci: './src/plugins/gitea/Ci.jsx',
  ExampleView: './src/plugins/example/ExampleView.jsx',
  ServiceDrawer: './src/ServiceDrawer.jsx',
  HostDrawer: './src/HostDrawer.jsx',
  DeviceDrawer: './src/DeviceDrawer.jsx',
  DeviceForm: './src/DeviceForm.jsx',
  NetworkMap: './src/NetworkMap.jsx',
  LoginScreen: './src/LoginScreen.jsx',
  Unconfigured: './src/Unconfigured.jsx',
}
const ENTRY = [
  ...Object.entries(VIEWS).map(([k, f]) => `import ${k} from '${f}'`),
  "import { AdminProvider } from './src/admin.jsx'",
  "import { AlertRows, BellButton } from './src/AlertBell.jsx'",
  // example plugin (outside the lists): its meta.js registers its catalog, as plugins/meta.js would
  // if it were listed; its tile is rendered alone
  "import './src/plugins/example/meta.js'",
  "import { ExampleKpi } from './src/plugins/example/tiles.jsx'",
  "import { renderToStaticMarkup } from 'react-dom/server'",
  // rendering that waits for lazy views (Suspense), for the application routes
  "import { prerender } from 'react-dom/static'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import * as I18N from './src/i18n/index.js'",
  `const C = { ${Object.keys(VIEWS).join(', ')}, AlertRows, BellButton, ExampleKpi }`,
  // locale: before text extraction, setLocale is enough (catalog in the bundle); after, loadLocale loads the chunk
  'export async function useLocale(l) {',
  '  if (I18N.loadLocale) await I18N.loadLocale(l)',
  '  I18N.setLocale(l)',
  '}',
  // prefilled cache (useSource key or useJson URL), rendered inside the router and the admin provider
  // full application at a path, lazy views loaded: a first render that waits for the
  // views (prerender) loads them, the second (synchronous) renders them fully; → HTML
  'export async function renderReady(name, opts = {}) {',
  '  const { prelude } = await prerender(tree(name, opts))',
  '  await new Response(prelude).text()',
  '  return renderToStaticMarkup(tree(name, opts))',
  '}',
  'function tree(name, { seed = {}, path = "/", search = "", props = {} } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData(k.startsWith("[") ? JSON.parse(k) : [k], v)',
  '  return h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path, ssrSearch: search }, h(AdminProvider, null, h(C[name], props))))',
  '}',
  'export function render(name, { seed = {}, path = "/", search = "", props = {}, admin = true } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData(k.startsWith("[") ? JSON.parse(k) : [k], v)',
  '  const el = h(C[name], props)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path, ssrSearch: search }, admin ? h(AdminProvider, null, el) : el)))',
  '}',
]

async function bundle() {
  const { build } = await import(path.join(ROOT, 'client/node_modules/esbuild/lib/main.js'))
  const r = await build({
    stdin: { contents: ENTRY.join('\n'), resolveDir: path.join(ROOT, 'client'), loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  const file = path.join(tmpDir('vigie-golden-views-'), 'views.mjs')
  fs.writeFileSync(file, r.outputFiles[0].text)
  return import(file)
}

// --- HTML → readable text ----------------------------------------------------------------------------
const ENTITIES = { '&#x27;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ' }
const unescape = s => s.replace(/&#x27;|&amp;|&lt;|&gt;|&quot;|&nbsp;/g, m => ENTITIES[m])
const BLOCK = /<\/?(text|title|g|div|p|li|ul|ol|h[1-6]|section|header|footer|nav|main|aside|table|tr|td|th|thead|tbody|button|label|option|select|dt|dd|dl|dialog|form|details|summary|figure|figcaption|blockquote|pre|br|hr|input|textarea)\b[^>]*>/gi
export function readable(html) {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  const lines = unescape(body.replace(BLOCK, '\n').replace(/<[^>]+>/g, ' ')).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const attrs = []
  for (const m of html.matchAll(/\s(aria-label|title|placeholder|alt|aria-description)="([^"]*)"/g)) {
    const v = `@${m[1]} ${unescape(m[2]).replace(/\s+/g, ' ').trim()}`
    if (m[2].trim() && !attrs.includes(v)) attrs.push(v)
  }
  return [...lines, ...attrs].join('\n')
}

// --- frozen clock --------------------------------------------------------------------------------------
function frozen(fn) {
  const Real = Date
  const warn = console.error
  console.error = () => {} // React development warnings (keys, attributes): off topic here
  class Fixed extends Real {
    constructor(...a) { super(...(a.length ? a : [NOW])) }
    static now() { return NOW }
  }
  globalThis.Date = Fixed
  const restore = () => {
    globalThis.Date = Real
    console.error = warn
  }
  let r
  try {
    r = fn()
  } catch (e) {
    restore()
    throw e
  }
  // asynchronous rendering (prerender): clock frozen until the end
  if (r && typeof r.then === 'function') return r.finally(restore)
  restore()
  return r
}
// content of the view (the frame's <main> element), otherwise the whole page
const mainOf = html => html.match(/<main\b[\s\S]*<\/main>/)?.[0] ?? html

// --- sample data ---------------------------------------------------------------------------------------
const M = 60_000
const H = 3600_000
const D = 86400_000
const iso = ms => new Date(NOW - ms).toISOString()
const sec = ms => Math.floor((NOW - ms) / 1000)
// availability band: one letter per slot, 'o' ok, 'w' degraded, 'c' failing, '-' no measurement
const band = (n, bad = [], part = []) => Array.from({ length: n }, (_, i) => (bad.includes(i) ? 'c' : part.includes(i) ? 'w' : 'o')).join('')

const HOSTS = [
  { id: 'pve-a', name: 'pve-a', kind: 'node', env: 'prod', ip: '192.0.2.10', desc: 'hyperviseur' },
  { id: 'web', name: 'web', kind: 'lxc', env: 'prod', ip: '192.0.2.21', pve: 'main', vmid: 101, parent: 'pve-a', desc: 'serveur web' },
  { id: 'nas', name: 'nas', kind: 'vm', env: 'prod', ip: '192.0.2.22', pve: 'main', vmid: 102, parent: 'pve-a' },
  { id: 'lab', name: 'lab', kind: 'lxc', env: 'dev', ip: '192.0.2.23', pve: 'main', vmid: 103, parent: 'pve-a' },
]
const check = (id, over = {}) => ({ id, label: id, type: 'http', target: `https://${id}.example.net`, state: 'ok', code: 200, latencyMs: 42, checkedAt: iso(M), ...over })
const service = (id, over = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), group: 'apps', env: 'prod', state: 'ok', url: `https://${id}.example.net`, desc: `service ${id}`,
  host: HOSTS[1], container: null, latencyMs: 42, uptime24h: 100, band24h: band(48), pinned: false, icon: null, iconUrl: null, iconUrlDark: null,
  checks: [check(`${id}-http`)], widget: null, ...over,
})
const SERVICES = {
  generatedAt: iso(0),
  summary: { total: 5, ok: 2, warn: 1, crit: 1, unknown: 1, none: 0 },
  groups: [{ id: 'apps', name: 'Applications', icon: 'app' }, { id: 'infra', name: 'Infrastructure', icon: 'server' }],
  hosts: HOSTS,
  bookmarks: [{ group: 'Liens', items: [{ name: 'Documentation', url: 'https://docs.example.net' }] }],
  services: [
    service('wiki', { pinned: true, widget: { at: iso(M), fields: [{ label: 'Pages', value: '128' }, { label: 'Utilisateurs', value: '4' }] } }),
    service('forge', { state: 'warn', latencyMs: 820, uptime24h: 97.9, band24h: band(48, [], [3]), checks: [check('forge-http', { state: 'warn', latencyMs: 820 }), check('forge-tls', { type: 'tls', label: 'certificat', tls: { daysLeft: 12, validTo: '2026-11-22T00:00:00Z', issuer: 'Exemple CA' } })] }),
    service('mail', { state: 'crit', group: 'infra', host: HOSTS[2], container: 'mailserver', uptime24h: 75, band24h: band(48, [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]), checks: [check('mail-smtp', { type: 'tcp', label: 'smtp', target: '192.0.2.22:25', state: 'crit', code: null, latencyMs: null, error: 'connexion refusée' })] }),
    service('dns', { state: 'unknown', group: 'infra', env: 'dev', host: HOSTS[3], checks: [check('dns-a', { type: 'dns', label: 'résolution', target: 'example.net', state: 'unknown', error: null, code: null })], uptime24h: null, band24h: '-'.repeat(48) }),
    service('photos', { url: null, group: 'apps', checks: [check('photos-http')] }),
  ],
}
const SUMMARY = {
  alerts: { critical: 2, warning: 3, info: 1, masked: 1, pending: 0, incidents24h: 7 },
  backups: [{ env: 'prod', failed: ['nas'], id: 'main', last: NOW - 8 * H, late: ['lab'], next: NOW + 15 * H, node: 'pve-a', ok: 1, total: 3 }],
  certs: { minDays: 12, minName: 'forge', soon: 1, total: 3 },
  ci: { configured: true, error: null, failing: [{ date: iso(30 * M), name: 'app', number: 12 }], runnersOnline: 1, runnersTotal: 2, running: 1 },
  env: 'all', generatedAt: iso(0),
  guests: { byEnv: { prod: { node: 'pve-a', running: 2, total: 2 }, dev: { node: 'pve-a', running: 0, total: 1 } }, errors: [], running: 2, stoppedDeclared: ['lab'], total: 3 },
  network: { presence: 'arp', online: 9, active: 10, total: 12, new: 2, sourcesDown: [] },
  services: { crit: 1, medianLatencyMs: 42, ok: 2, total: 5, unknown: 1, warn: 1 },
  sourcesDown: [], state: 'crit',
  updates: { auto: 1, checkedAt: iso(10 * M), deploy: 1, digest: 0, eol: 1, errors: 0, ignored: 1, major: 1, minor: 1, patch: 1, security: 1, total: 6 },
  weather: { label: 'Paris', temp: 12.4, min: 6, max: 14.6, feels: 10, wind: 18, rain: 20, code: 1, isDay: true, text: 'Ciel dégagé' },
}
const alert = (key, over = {}) => ({
  key, rule: key.split(':')[0], severity: 'warning', state: 'firing', title: key, detail: `détail de ${key}`, entity: key.split(':')[1] ?? null,
  env: 'prod', host: 'web', hostId: 'web', since: NOW - 2 * H, firedAt: NOW - 2 * H, notified: true, link: '/services', ack: null, incidentId: 1, suppressed: null, flapping: false, ...over,
})
const ALERTS = {
  generatedAt: iso(0),
  active: [
    alert('service_down:mail', { severity: 'critical', title: 'Mail injoignable', detail: 'smtp : connexion refusée', host: 'nas', hostId: 'nas', since: NOW - 4 * H, firedAt: NOW - 4 * H, link: '/services?s=mail' }),
    alert('disk_full:web', { severity: 'critical', title: 'Disque presque plein sur web', detail: '/ à 96 %', ack: { at: NOW - H, by: 'admin', reason: 'nettoyage prévu ce soir', until: NOW + 10 * H } }),
    alert('cert_expiry:forge', { title: 'Certificat de forge', detail: 'expire dans 12 j' }),
    alert('updates_pending:web', { severity: 'info', title: 'Mises à jour en attente sur web', detail: '3 paquets dont 1 de sécurité', notified: false }),
    alert('agent_unreachable:lab', { env: 'dev', host: 'lab', hostId: 'lab', title: 'Agent injoignable sur lab', detail: 'pas de réponse en 10 s', state: 'pending', since: NOW - 3 * M, firedAt: null, notified: false, flapping: true }),
  ],
  incidents: [
    { id: 3, key: 'service_down:mail', rule: 'service_down', severity: 'critical', title: 'Mail injoignable', entity: 'mail', env: 'prod', startedAt: NOW - 4 * H, resolvedAt: null, summary: null, suppressed: null, ack: null },
    { id: 2, key: 'service_down:wiki', rule: 'service_down', severity: 'critical', title: 'Wiki injoignable', entity: 'wiki', env: 'prod', startedAt: NOW - 26 * H, resolvedAt: NOW - 25 * H, summary: 'rétabli après 1 h', suppressed: null, ack: { at: NOW - 25.5 * H, by: 'admin', reason: 'redémarrage', until: null } },
    { id: 1, key: 'node_down:pve-a', rule: 'node_down', severity: 'critical', title: 'Nœud pve-a hors ligne', entity: 'pve-a', env: 'prod', startedAt: NOW - 3 * D, resolvedAt: NOW - 3 * D + 10 * M, summary: 'coupure de courant', suppressed: 'maintenance', ack: null },
  ],
  notifier: {
    telegram: true, queued: 1, deferred: 0, lastSentAt: iso(20 * M), digestAt: '08:00', graceUntil: null, heartbeat: { lastOkAt: iso(5 * M) },
    quietHours: { start: '22:00', end: '07:00' },
    channels: [{ id: 'telegram', label: 'Telegram', configured: true, lastSentAt: iso(20 * M), queued: 1 }, { id: 'ntfy', label: 'ntfy', configured: false, lastSentAt: null, queued: 0 }],
  },
}
const SILENCES = {
  active: [
    { id: 4, matcher: { rule: 'updates_pending' }, target: 'règle updates_pending', reason: 'mises à jour le mercredi', createdBy: 'admin', source: 'dashboard', createdAt: iso(D), endsAt: NOW + 2 * D },
    { id: 5, matcher: { host: 'lab' }, target: 'hôte lab', reason: 'lab en travaux', createdBy: 'admin', source: 'telegram', createdAt: iso(2 * H), endsAt: null },
  ],
}
const comp = (id, over = {}) => ({ id, name: id, kind: 'app', env: 'prod', where: 'web', host: 'web', current: '1.0.0', latest: '1.0.0', gap: 'same', url: `https://${id}.example.net/releases`, publishedAt: iso(5 * D), ...over })
const UPDATES = {
  checkedAt: iso(10 * M), stats: { requests: 12, notModified: 8, githubAuth: false },
  sources: [{ source: 'registre', msg: 'HTTP 503' }],
  components: [
    comp('nginx', { kind: 'os', current: '1.24.0', latest: '1.24.1', gap: 'patch', security: true, cve: ['CVE-2026-0001'], securityIn: '1.24.1' }),
    comp('forge', { kind: 'docker', current: '1.22.0', latest: '2.0.0', gap: 'major', breaking: 2, latestSameMajor: '1.22.3', notes: 'migration de la base requise' }),
    comp('wiki', { kind: 'docker', current: '3.4.0', latest: '3.5.0', gap: 'minor' }),
    comp('debian', { kind: 'os', current: '11', latest: '12', gap: 'major', eol: { date: '2026-08-31', passed: true }, where: 'nas', host: 'nas' }),
    comp('photos', { kind: 'docker', current: 'sha256:abc', latest: 'sha256:def', gap: 'digest' }),
    comp('app', { kind: 'deploy', current: 'abc1234', latest: 'def5678', gap: 'deploy', skipped: 3 }),
    comp('mail', { current: '2.0.0', latest: '2.1.0', gap: 'minor', ignored: { reason: 'attendre la 2.1.1', until: '2026-12-01' } }),
    comp('dns', { env: 'dev', where: 'lab', host: 'lab', current: '5.0', latest: null, gap: null, error: 'registre : HTTP 503' }),
    comp('wiki-db', { current: '16.2', latest: '16.4', gap: 'minor', pinned: { pin: 'major', reason: 'majeure figée', hidden: '17.0', source: 'config', decisionId: null } }),
    comp('cache', { current: '7.2', latest: '7.2', gap: 'same' }),
    comp('apt:web', { kind: 'apt', name: 'paquets de web', current: '3 paquets', latest: null, gap: 'patch', security: true, auto: true, apt: { upgradable: 3, security: 1, held: 0, ageDays: 2, autoUpdate: { state: 'active', detail: 'sécurité seulement', lastRunAt: sec(20 * H), lastResult: 'success', applied: [{ name: 'openssl' }, { name: 'libssl3' }] } } }),
    comp('apt:nas', { kind: 'apt', name: 'paquets de nas', where: 'nas', host: 'nas', current: '12 paquets', latest: null, gap: 'minor', apt: { upgradable: 12, security: 0, held: 2, ageDays: 9, autoUpdate: { state: 'failed', detail: 'dpkg interrompu', lastRunAt: sec(30 * H), lastResult: 'failed', applied: [] } } }),
  ],
}
const fast = (over = {}) => ({
  version: 8, ts: sec(M), hostname: 'web', os: 'Debian GNU/Linux 12', osId: 'debian', osVersion: '12', kernel: '6.1.0-30-amd64', virt: 'lxc', uptimeSec: 12 * D / 1000,
  load: [0.42, 0.35, 0.3], mem: { total: 4e9, available: 2.5e9 }, swap: { total: 1e9, free: 0.9e9 },
  fs: [{ mount: '/', type: 'ext4', size: 20e9, used: 19.2e9, avail: 0.8e9, inodes: { total: 1e6, used: 3e5 } }, { mount: '/data', type: 'zfs', size: 100e9, used: 40e9, avail: 60e9, inodes: null }],
  systemd: { failed: [], watched: [{ unit: 'nginx.service', active: 'active', sub: 'running' }, { unit: 'backup.timer', active: 'inactive', sub: 'dead' }] },
  docker: {
    version: '27.3.1', networks: [{ name: 'bridge', driver: 'bridge' }],
    containers: [
      { name: 'wiki', image: 'wiki:3.4.0', state: 'running', health: 'healthy', restarts: 0, recentRestarts: 0, restartPolicy: 'unless-stopped', startedAt: iso(3 * D), created: iso(10 * D), compose: 'wiki', service: 'app', networks: [{ network: 'bridge', ip: '198.51.100.2', mac: '02:42:ac:11:00:02' }] },
      { name: 'wiki-db', image: 'postgres:16.2', state: 'exited', health: null, exitCode: 1, restarts: 4, recentRestarts: 2, restartPolicy: 'on-failure', finishedAt: iso(30 * M), created: iso(10 * D), compose: 'wiki', service: 'db', networks: [] },
    ],
  },
  net: { ifaces: [{ name: 'eth0', mac: '00:00:5e:00:53:21', ipv4: ['192.0.2.21'] }], neigh: [{ ip: '192.0.2.1', mac: '00:00:5e:00:53:01', dev: 'eth0', state: 'REACHABLE' }] },
  reboot: { required: true, since: iso(2 * D) },
  ...over,
})
const slow = (over = {}) => ({
  version: 8, ts: sec(2 * H),
  apt: { upgradable: 3, security: 1, held: 1, listsAt: sec(6 * H), packages: [{ name: 'openssl', version: '3.0.15-1', from: '3.0.14-1', suite: 'bookworm-security' }, { name: 'curl', version: '7.88.1-11', from: '7.88.1-10', suite: 'bookworm' }] },
  autoUpdate: { installed: true, enabled: true, securityOnly: true, lastRunAt: iso(20 * H), lastResult: 'ok' },
  restart: { units: ['nginx.service'], processes: 1 },
  time: { ntpSynced: false },
  versions: { nginx: '1.24.0', 'docker-ce': '27.3.1' },
  images: [{ id: 'sha256:abc', tags: ['wiki:3.4.0'], digests: [], created: iso(20 * D) }],
  ...over,
})
// posture and ports (agent v8); without a session: admin only. known.bootstrap: known by default
// at the first report (API field since text extraction, ignored before)
const V8 = {
  known: true, restricted: false,
  posture: {
    ssh_root: { state: 'ok' },
    ssh_password: { state: 'gap', regression: true, seenOk: NOW - 5 * D },
    firewall: { state: 'accepted', accepted: { by: 'admin', at: NOW - 3 * D, reason: 'couvert par le pare-feu de Proxmox' } },
  },
  ports: [
    { proto: 'tcp', port: 22, addrs: ['192.0.2.21'], processes: ['sshd'], status: 'known', known: { at: NOW - 30 * D, by: 'amorçage', reason: null, bootstrap: true } },
    { proto: 'tcp', port: 443, addrs: ['192.0.2.21', '::'], processes: ['nginx'], status: 'known', known: { at: NOW - 3 * D, by: 'admin', reason: 'site public', bootstrap: false } },
    { proto: 'tcp', port: 8080, addrs: ['192.0.2.21'], processes: ['java'], status: 'new', known: null },
    { proto: 'udp', port: 323, addrs: ['127.0.0.1'], processes: [], status: 'local', known: null },
  ],
}
const agentsFor = session => (session.admin ? AGENTS : { ...AGENTS, hosts: AGENTS.hosts.map(h => (h.v8 ? { ...h, v8: { known: true, restricted: true } } : h)) })
const AGENTS = {
  generatedAt: iso(0),
  hosts: [
    { id: 'web', name: 'web', kind: 'lxc', env: 'prod', agent: 'ssh', pve: 'main', vmid: 101, ok: true, at: NOW - M, fast: fast(), slow: slow(), slowAt: NOW - 2 * H, slowError: null, autoUpdate: { state: 'active', detail: 'sécurité seulement', lastRunAt: sec(20 * H), lastResult: 'success', applied: [{ name: 'openssl' }] }, v8: V8 },
    { id: 'nas', name: 'nas', kind: 'vm', env: 'prod', agent: 'ssh', pve: 'main', vmid: 102, ok: false, at: NOW - 3 * H, error: 'pas de réponse en 10 s', errorKind: 'timeout', fast: null, slow: null, slowAt: null, slowError: null },
    { id: 'lab', name: 'lab', kind: 'lxc', env: 'dev', agent: null, ok: null },
  ],
}
const node = (name, over = {}) => ({ name, status: 'online', cpu: 0.12, maxcpu: 8, mem: 12e9, maxmem: 32e9, disk: 40e9, maxdisk: 100e9, uptime: 20 * D / 1000, ...over })
const guest = (vmid, name, over = {}) => ({ vmid, name, type: 'lxc', status: 'running', node: 'pve-a', cpu: 0.05, maxcpu: 2, mem: 1e9, maxmem: 2e9, disk: 5e9, maxdisk: 10e9, uptime: 3 * D / 1000, ...over })
const CLUSTER = [{
  id: 'main', label: 'Cluster principal',
  nodes: [node('pve-a')],
  guests: [guest(101, 'web'), guest(102, 'nas', { type: 'qemu', maxmem: 8e9, mem: 6e9 }), guest(103, 'lab', { status: 'stopped', uptime: 0 })],
  storages: [{ name: 'local-lvm', status: 'available', disk: 60e9, maxdisk: 200e9 }, { name: 'sauvegardes', status: 'available', disk: 300e9, maxdisk: 1000e9 }],
}]
const PROXMOX = {
  generatedAt: iso(0),
  clusters: [{
    id: 'main', label: 'Cluster principal',
    nodes: [{ node: 'pve-a', pveVersion: '8.3.2', kernel: '6.8.12-5-pve', cpuModel: 'Processeur exemple', cpus: 8, load: [0.5, 0.4, 0.3], iowait: 0.01, uptime: 20 * D / 1000, mem: { total: 32e9, used: 14e9, available: 18e9 }, swap: { total: 8e9, used: 0 }, rootfs: { total: 100e9, used: 40e9, avail: 60e9 } }],
    nodesError: null,
    disks: [
      { node: 'pve-a', devpath: '/dev/sda', type: 'ssd', model: 'SSD Exemple', size: 500e9, health: 'PASSED', used: 'LVM', wearout: 92, temperature: 38, powerOnHours: 12000 },
      { node: 'pve-a', devpath: '/dev/sdb', type: 'hdd', model: 'HDD Exemple', size: 4e12, health: 'FAILED', used: 'ZFS', wearout: null, reallocated: 12 },
    ],
    disksError: null,
    tasks: [{ type: 'vzdump', id: '102', node: 'pve-a', user: 'root@pam', start: sec(9 * H), end: sec(8.9 * H), status: 'job errors', level: 'error' }],
    tasksDays: 7, tasksError: null,
    notifications: { targets: [{ name: 'mail-admin', type: 'sendmail', origin: 'user-created', disabled: false }], matchers: [{ name: 'défaut', targets: ['mail-admin'], origin: 'builtin', disabled: false, mode: 'all' }] },
    notificationsError: null,
  }],
}
const BACKUPS = [{
  id: 'main', label: 'Cluster principal', mode: 'storage', storage: 'sauvegardes',
  items: [{ vmid: 101, name: 'web', last: sec(8 * H), count: 7, failed: null, size: 2e9 }, { vmid: 102, name: 'nas', last: sec(3 * D), count: 3, failed: { at: sec(8 * H), msg: 'job errors' }, size: 20e9 }],
  jobs: [{ id: 'quotidien', enabled: true, schedule: '02:00', nextRun: sec(-15 * H), storage: 'sauvegardes', node: null, mode: 'snapshot', all: true, vmid: [], exclude: [103], pool: null, comment: 'tous les invités sauf lab' }],
  runs: { 101: [{ t: sec(8 * H), ok: true }, { t: sec(32 * H), ok: true }], 102: [{ t: sec(8 * H), ok: false }, { t: sec(32 * H), ok: true }] },
  orphans: [{ vmid: 199, count: 2, size: 5e9, last: sec(40 * D) }],
  coverage: [{ vmid: 101, name: 'web', type: 'lxc', covered: true, job: 'quotidien' }, { vmid: 102, name: 'nas', type: 'qemu', covered: true, job: 'quotidien' }, { vmid: 103, name: 'lab', type: 'lxc', covered: false, excluded: true }],
}]
const netDevice = (id, over = {}) => ({
  id, name: `appareil-${id}`, mac: `00:00:5e:00:53:${String(id).padStart(2, '0')}`, ip: `192.0.2.${100 + id}`, type: 'computer', vendor: 'Exemple', location: null,
  state: 'known', review: false, freshness: 'active', online: 1, onlineSince: iso(5 * H), lastSeen: iso(M), firstSeen: iso(30 * D), lastPresent: iso(M), lastDhcp: null,
  hostId: null, hostSrc: null, macs: 1, grade: 'weak', origin: 'scan', pending: 0, random: false, profile: null, profileSet: false, alertDown: false, alertSeverity: null, expectedIp: null, band24h: band(24), ...over,
})
const NETWORK = {
  enabled: true, generatedAt: iso(0), presence: 'arp', presenceSince: iso(30 * D), intervalSec: 300, arpIntervalSec: 120, activeMin: 15, alertsSince: iso(29 * D), lastRunAt: iso(M),
  gateway: { ip: '192.0.2.1', source: 'route' },
  counts: { total: 6, online: 4, active: 4, idle: 1, offline: 1, new: 2, review: 1, pending: 1, stale: 0, unknown: 0, dhcp: 2 },
  types: ['computer', 'phone', 'tv', 'nas', 'printer', 'router'],
  suggestions: [
    { key: 'family:fe:fd:fc', kind: 'family', name: 'tablette', macs: 3, prefix: 'fe:fd:fc', devices: [6, 4], warnings: [{ kind: 'names', text: 'noms saisis différents : tablette, telephone' }] },
    { key: 'name:telephone', kind: 'name', name: 'telephone', devices: [4, 6], warnings: [] },
  ],
  rules: [{ id: 1, action: 'ignore_vendor', prefix: '00:00:5e:00:53', name: 'règle exemple', deviceId: null, createdAt: iso(10 * D) }],
  sources: {
    arp: { ok: true, at: iso(M), n: 6, ms: 900, installed: true, anomalies: { dup: 0, extraMacs: 0, hdrmac: 0, invalid: 0, multiMacIps: 0, wideMacs: 0 } },
    pve: { ok: true, at: iso(5 * M), n: 3 },
    dhcp: { ok: false, at: iso(2 * H), n: 0, error: 'Pi-hole : réponse dhcp/leases inattendue' },
    pihole: { ok: true, at: iso(5 * M), n: 4 },
    agent: { ok: true, at: iso(M), n: 1 },
    neigh: { ok: true, at: iso(M), n: 2 },
    mdns: { enabled: true, listening: true, ok: true, at: iso(M), lastAt: iso(2 * M), packets: 120, rate: 0, rejected: 1, socketErrors: 0, candidates: 3, applied: 2, informative: 1, ambiguous: 0, nameConflict: 0, nameDiffers: 1, noDevice: 0, offline: 0, outsideLan: 0 },
    probe: { enabled: true, ok: true, defsOk: true, nextRun: new Date(NOW + 2 * H).toISOString(), queued: 0 },
  },
  devices: [
    netDevice(1, { name: 'box', type: 'router', ip: '192.0.2.1', hostId: null }),
    netDevice(2, { name: 'web', type: 'server', ip: '192.0.2.21', hostId: 'web', hostSrc: 'pve', grade: 'hypervisor', origin: 'pve' }),
    netDevice(3, { name: '', vendor: 'Fabricant', state: 'new', freshness: 'active', firstSeen: iso(20 * M), type: null }),
    netDevice(4, { name: 'telephone', type: 'phone', random: true, state: 'new', freshness: 'idle', online: 0, lastSeen: iso(3 * H), lastPresent: iso(3 * H), band24h: band(24, [21, 22, 23]) }),
    netDevice(5, { name: 'imprimante', type: 'printer', freshness: 'offline', online: 0, lastSeen: iso(9 * D), lastPresent: iso(9 * D), review: true, band24h: band(24, [...Array(24).keys()]), alertDown: true, alertSeverity: 'warning' }),
    netDevice(6, { name: 'tablette', type: 'phone', pending: 1, macs: 2, band24h: band(24, [], [5, 6]) }),
  ],
}
const DEVICE = {
  ...netDevice(5, { name: 'imprimante', type: 'printer', freshness: 'offline', online: 0, lastSeen: iso(9 * D), lastPresent: iso(9 * D), review: true, band24h: band(24, [...Array(24).keys()]), alertDown: true, alertSeverity: 'warning', location: 'bureau' }),
  saisie: { name: 'imprimante', location: 'bureau', expectedIp: '192.0.2.105', alertDown: true, alertSeverity: 'warning', notes: 'au fond du couloir' },
  macs: [{ mac: '00:00:5e:00:53:05', grade: 'weak', attach: null, identity: false, pending: false, lastIp: '192.0.2.105', lastSeen: iso(9 * D), vendor: 'Exemple' }],
  attrs: [
    { attr: 'name', source: 'dhcp', value: 'PRN-01', rank: 1, seenAt: iso(9 * D), chosen: false },
    { attr: 'mdns_name', source: 'mdns', value: 'imprimante.local', rank: 2, seenAt: iso(9 * D), chosen: true },
    { attr: 'vendor', source: 'oui', value: 'Exemple', rank: 2, seenAt: iso(30 * D), chosen: true },
  ],
  events: [
    { at: iso(9 * D), type: 'port_closed', detail: 'tcp/9100', actor: null },
    { at: iso(10 * D), type: 'probed', detail: '2 services', actor: 'admin' },
    { at: iso(20 * D), type: 'edited', detail: 'nom : imprimante', actor: 'admin' },
    { at: iso(30 * D), type: 'new', detail: null, actor: null },
  ],
  addresses: [{ ip: '192.0.2.105', mac: '00:00:5e:00:53:05', firstSeen: iso(30 * D), lastSeen: iso(9 * D), source: 'arp' }],
  seen: [{ mac: '00:00:5e:00:53:05', source: 'arp', lastSeen: iso(9 * D), lastIp: '192.0.2.105' }],
  rules: [], services: [{ id: 'photos', name: 'Photos', state: 'ok', iconUrl: null, iconUrlDark: null }],
  probeServices: [{ id: 'ipp', name: 'Impression (IPP)', port: 631, confidence: 'high', cfgService: null }, { id: 'web', name: 'Page web', port: 80, confidence: 'low', cfgService: 'photos' }],
  ports: [{ port: 631, proto: 'tcp', open: true, service: 'ipp', firstSeen: iso(30 * D), lastSeen: iso(10 * D) }, { port: 9100, proto: 'tcp', open: true, service: null, firstSeen: iso(30 * D), lastSeen: iso(10 * D) }, { port: 22, proto: 'tcp', open: false, service: null, firstSeen: iso(30 * D), lastSeen: iso(20 * D) }],
  lastProbe: { at: iso(10 * D), origin: 'planned' },
  probe: { available: true, excluded: false, needsForce: true },
  sessions: [{ start: iso(12 * D), end: iso(9 * D) }],
  deletion: { allowed: true, why: null },
  parent: null,
  mapParent: { label: 'box', ip: '192.0.2.1', origin: 'manual', link: { id: 3, kind: 'wifi', port: null, note: 'répéteur du salon' } },
}
const TOPOLOGY = {
  warnings: ['1 lien saisi ignoré : cycle'],
  nodes: [
    { id: 'internet', parent: null, kind: 'internet', label: 'Internet', state: 'ok' },
    { id: 'dev:1', parent: 'internet', kind: 'device', label: 'box', ip: '192.0.2.1', state: 'ok', origin: 'default', link: '?d=1' },
    { id: 'host:pve-a', parent: 'dev:1', kind: 'host', label: 'pve-a', ip: '192.0.2.10', state: 'ok', origin: 'config', link: '?h=pve-a' },
    { id: 'host:web', parent: 'host:pve-a', kind: 'host', label: 'web', ip: '192.0.2.21', state: 'warn', origin: 'pve', link: '?h=web' },
    { id: 'group:pve-a', parent: 'host:pve-a', kind: 'group', label: '2 invités', state: 'crit' },
    { id: 'host:nas', parent: 'group:pve-a', group: 'group:pve-a', kind: 'host', label: 'nas', ip: '192.0.2.22', state: 'crit', origin: 'pve' },
    { id: 'dev:5', parent: 'dev:1', kind: 'device', label: 'imprimante', ip: '192.0.2.105', state: 'crit', origin: 'manual', linkId: 3, link: '?d=5' },
    { id: 'dev:6', parent: 'host:web', kind: 'device', label: 'tablette', ip: '192.0.2.106', state: 'ok', origin: 'service', originService: 'wiki', link: '?d=6' },
  ],
}
const HISTORY = { days: 7, enabled: true, points: Array.from({ length: 7 }, (_, i) => ({ t: iso((7 - i) * D), online: 8 + (i % 3), total: 12 })) }
const pts = (n, base) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * H, lat: i === 3 ? null : base + i }))
const SERVICE_HISTORY = {
  historySince: NOW - 10 * H, bandStart: NOW - 24 * H, bandSize: H,
  checks: [
    { id: 'mail-smtp', label: 'smtp', type: 'tcp', state: 'crit', uptime: 75, target: '192.0.2.22:25', band: band(24, [20, 21, 22, 23]), points: pts(12, 40),
      failures: [{ t: NOW - 3 * H, error: 'connexion refusée', code: null }, { t: NOW - 4 * H, error: null, code: 503 }] },
    { id: 'mail-tls', label: '', type: 'tls', state: 'ok', uptime: 100, target: 'mail.example.net:465', band: [], points: [], tls: { validTo: '2027-01-15T00:00:00Z', daysLeft: 66, issuer: 'Exemple CA' } },
  ],
  incidents: [
    { id: 3, startedAt: NOW - 4 * H, resolvedAt: null, summary: null },
    { id: 2, startedAt: NOW - 20 * H, resolvedAt: NOW - 19 * H - 20 * M, summary: 'smtp : connexion refusée' },
  ],
}
const RRD = Array.from({ length: 24 }, (_, i) => ({ t: NOW - (24 - i) * H, cpu: 10 + (i % 5), mem: 40 + (i % 7), netin: 1000 * i, netout: 500 * i, diskread: 0, diskwrite: 0 }))
const PLUGINS = { apiVersion: 0, modules: [
  { id: 'updates', label: 'versions', kind: 'core', state: 'active', errors: [] },
  { id: 'gitea', label: 'Gitea', kind: 'plugin', state: 'active', errors: [] },
  { id: 'casse', label: 'Cassé', kind: 'plugin', state: 'error', errors: [{ hook: 'signals', message: 'boum', at: iso(5 * M) }] },
] }
const run = (status, number, title, ms) => ({ status, number, sha: 'abc1234', title, branch: 'main', date: iso(ms), url: `https://forge.example.net/org/app/actions/runs/${number}` })
const repo = (name, mainStatus, extra = {}) => ({
  name, htmlUrl: `https://forge.example.net/org/${name}`, openPRs: 0, defaultBranch: 'main',
  lastCommit: { message: `commit de ${name}`, author: 'auteur', date: iso(3 * H), sha: 'def5678', url: `https://forge.example.net/org/${name}/commit/def5678` },
  lastRun: run(mainStatus, 12, `run de ${name}`, 2 * H), mainRun: run(mainStatus, 12, `run de ${name}`, 2 * H), lastSuccess: null, ...extra,
})
const GITEA = [repo('app', 'failure', { openPRs: 2 }), repo('site', 'success'), { name: 'casse', error: true }]
const RUNNERS = [{ id: 1, name: 'runner-a', status: 'online', busy: true, labels: ['ubuntu-latest', 'docker'] }, { id: 2, name: 'runner-b', status: 'offline', busy: false, labels: ['ubuntu-latest'] }]

const ADMIN = { admin: true, anonymousRead: true, configured: true, networkAllowed: true, expiresAt: NOW + 12 * H }
const ANON = { admin: false, anonymousRead: true, configured: true, networkAllowed: true }
const config = locale => ({ title: 'Banc', subtitle: 'tableau de bord de démonstration', footer: 'pied de page', locale })
// every source, like a full instance
const all = (locale, session = ADMIN) => ({
  config: config(locale), session, services: SERVICES, alerts: ALERTS, silences: SILENCES, updates: UPDATES, agents: agentsFor(session), cluster: CLUSTER,
  proxmox: PROXMOX, backups: BACKUPS, network: NETWORK, plugins: PLUGINS, gitea: GITEA, runners: RUNNERS,
  bands: { services: {} },
  '/api/summary': SUMMARY, '/api/summary?env=prod': { ...SUMMARY, env: 'prod', state: 'ok', alerts: { critical: 0, warning: 0, info: 0, masked: 0, pending: 0, incidents24h: 0 }, certs: { minDays: null, minName: null, soon: 0, total: 0 }, backups: [], network: { ...SUMMARY.network, new: 0 } },
  '/api/network/devices/5': DEVICE,
  '/api/history/service/mail?range=24h': SERVICE_HISTORY,
  '/api/rrd/main/pve-a?timeframe=day': RRD,
  '/api/rrd/main/guest/101?timeframe=day': { maxcpu: 2, maxmem: 2e9, points: RRD },
  '/api/network/history?days=7': HISTORY,
  '/api/network/topology': TOPOLOGY,
  '/api/example': { depth: 12, max: 10 },
})

// --- cases ---------------------------------------------------------------------------------------------
// [title, component, options(locale)]; options: seed, path, search, props, admin
const CASES = [
  // frame
  ['cadre : accueil, session admin (navigation, en-tête, cockpit, pied)', 'App', l => ({ seed: all(l) })],
  ['cadre : accueil, lecture anonyme', 'App', l => ({ seed: all(l, ANON) })],
  ['cadre : session en cours de lecture', 'App', l => ({ seed: { config: config(l) } })],
  ['cadre : écran de connexion (lecture réservée)', 'App', l => ({ seed: { config: config(l), session: { admin: false, anonymousRead: false, configured: true, networkAllowed: true } } })],
  ['cadre : connexion impossible (réseau non autorisé)', 'App', l => ({ seed: { config: config(l), session: { admin: false, anonymousRead: false, configured: true, networkAllowed: false } } })],
  ['cadre : instance à configurer', 'App', l => ({ seed: { config: config(l), session: { unconfigured: true } } })],
  ['cadre : page introuvable', 'App', l => ({ seed: all(l), path: '/inconnu' })],
  ['cadre : route /mural (vue paresseuse : attente de son chunk)', 'App', l => ({ seed: all(l), path: '/mural' })],
  ['cadre : cloche des alertes (bouton et liste)', 'AlertRows', l => ({ seed: all(l), props: { list: ALERTS.active, onClose() {} } })],
  ['cadre : bouton de la cloche', 'BellButton', l => ({ seed: all(l), props: { count: 3, tone: 'crit', open: false, onClick() {} } })],
  // each view under its English name and under its former French name (durable alias), view loaded
  ...[['/alerts', '/alertes'], ['/network', '/reseau'], ['/backups', '/sauvegardes'], ['/updates', '/maj'], ['/wall', '/mural']].flatMap(([path, old]) => [
    [`routes : ${path} (vue seule)`, 'App', l => ({ seed: all(l), path }), true],
    [`routes : ${old} (ancien nom, même vue)`, 'App', l => ({ seed: all(l), path: old }), true, 'same'],
  ]),
  ['cadre : écran de connexion seul', 'LoginScreen', l => ({ seed: { config: config(l) }, props: { session: { admin: false, anonymousRead: false, configured: true, networkAllowed: true, httpRefused: true }, config: config(l) } })],
  ['cadre : page « à configurer » seule', 'Unconfigured', () => ({})],
  // cockpit
  ['cockpit : toutes les sources', 'Cockpit', l => ({ seed: all(l) })],
  ['cockpit : environnement prod', 'Cockpit', l => ({ seed: all(l), search: 'env=prod' })],
  ['cockpit : aucune donnée encore', 'Cockpit', l => ({ seed: { config: config(l), session: ADMIN } })],
  ['cockpit : sources en panne', 'Cockpit', l => ({ seed: { ...all(l), '/api/summary': { ...SUMMARY, state: 'unknown', sourcesDown: ['proxmox', 'agents'], guests: { ...SUMMARY.guests, errors: ['Proxmox injoignable'] }, ci: { configured: false }, network: { ...SUMMARY.network, new: 0, sourcesDown: ['pihole'] }, weather: null } } })],
  // services
  ['services : liste', 'Services', l => ({ seed: all(l) })],
  ['services : filtre « en panne » et recherche', 'Services', l => ({ seed: all(l), search: 'state=crit,warn&q=ma' })],
  ['services : recherche sans résultat', 'Services', l => ({ seed: all(l), search: 'q=introuvable' })],
  ['services : chargement', 'Services', l => ({ seed: { config: config(l), session: ADMIN } })],
  // infrastructure
  ['infra : Proxmox, agents et nœuds', 'Infra', l => ({ seed: all(l) })],
  ['infra : Proxmox injoignable', 'Infra', l => ({ seed: { ...all(l), cluster: [{ id: 'main', label: 'Cluster principal', error: 'connect ECONNREFUSED', errorKind: 'network' }], proxmox: { generatedAt: iso(0), clusters: [{ id: 'main', label: 'Cluster principal', nodes: null, nodesError: 'délai dépassé', disks: null, disksError: 'délai dépassé', tasks: null, tasksDays: 7, tasksError: 'délai dépassé', notifications: null, notificationsError: 'délai dépassé' }] } } })],
  ['infra : chargement', 'Infra', l => ({ seed: { config: config(l), session: ADMIN } })],
  // network
  ['réseau : inventaire', 'Network', l => ({ seed: all(l) })],
  ['réseau : filtre « nouveaux », tri par nom', 'Network', l => ({ seed: all(l), search: 'state=new&sort=name' })],
  ['réseau : onglet historique', 'Network', l => ({ seed: all(l), search: 'tab=history' })],
  ['réseau : onglet carte (la carte, paresseuse, attend son chunk)', 'Network', l => ({ seed: all(l), search: 'tab=carte' })],
  ['réseau : carte (admin)', 'NetworkMap', l => ({ seed: all(l) })],
  ['réseau : carte (lecture anonyme)', 'NetworkMap', l => ({ seed: all(l, ANON) })],
  ['réseau : filtre par type et recherche', 'Network', l => ({ seed: all(l), search: 'type=printer&q=imp' })],
  ['réseau : présence passive (sans sonde ARP)', 'Network', l => ({ seed: { ...all(l), network: { ...NETWORK, presence: 'passive', presenceSince: null, gateway: null, sources: { ...NETWORK.sources, arp: { ok: false, installed: false, at: null, n: 0 } } } } })],
  ['réseau : lecture anonyme', 'Network', l => ({ seed: all(l, ANON) })],
  ['réseau : module désactivé', 'Network', l => ({ seed: { ...all(l), network: { enabled: false } } })],
  // updates
  ['mises à jour : à traiter', 'Updates', l => ({ seed: all(l) })],
  ['mises à jour : filtre « à jour »', 'Updates', l => ({ seed: all(l), search: 'f=same' })],
  ['mises à jour : filtre « ignorées »', 'Updates', l => ({ seed: all(l), search: 'f=ignored' })],
  ['mises à jour : filtre « erreurs » et recherche', 'Updates', l => ({ seed: all(l), search: 'f=error&q=dns' })],
  ['mises à jour : tout est à jour', 'Updates', l => ({ seed: { ...all(l), updates: { ...UPDATES, sources: [], components: [comp('wiki')] } } })],
  ['mises à jour : première vérification', 'Updates', l => ({ seed: { ...all(l), updates: { checkedAt: null, sources: [], stats: null, components: [] } } })],
  // backups
  ['sauvegardes : stockage, jobs, couverture, orphelines', 'Backups', l => ({ seed: all(l) })],
  ['sauvegardes : non configurées', 'Backups', l => ({ seed: { ...all(l), backups: [{ id: 'main', label: 'Cluster principal', mode: null, items: [], jobs: [], runs: {}, orphans: null, coverage: [] }] } })],
  // alerts
  ['alertes : actives, incidents, silences (admin)', 'Alerts', l => ({ seed: all(l) })],
  ['alertes : lecture anonyme', 'Alerts', l => ({ seed: all(l, ANON) })],
  ['alertes : environnement dev', 'Alerts', l => ({ seed: all(l), search: 'env=dev' })],
  ['alertes : aucune alerte', 'Alerts', l => ({ seed: { ...all(l), alerts: { ...ALERTS, active: [], incidents: [] }, silences: { active: [] } } })],
  // integrations, CI, example plugin
  ['intégrations', 'Integrations', l => ({ seed: all(l) })],
  ['CI (plugin gitea) : en échec', 'Ci', l => ({ seed: all(l) })],
  ['CI (plugin gitea) : non configurée', 'Ci', l => ({ seed: { ...all(l), gitea: { configured: false }, runners: { configured: false } } })],
  ['plugin d\'exemple : vue', 'ExampleView', l => ({ seed: all(l) })],
  ['plugin d\'exemple : tuile du cockpit', 'ExampleKpi', l => ({ seed: all(l), props: { s: { example: { depth: 12, max: 10 } }, env: 'all' } })],
  ['plugin d\'exemple : tuile sans donnée', 'ExampleKpi', l => ({ seed: all(l), props: { s: {}, env: 'all' } })],
  // wall display
  ['mural : vue seule', 'Mural', l => ({ seed: all(l), props: { config: config(l) } })],
  // drawers
  ['tiroir de service : mail (en panne, sondes, historique)', 'ServiceDrawer', l => ({ seed: all(l), search: 's=mail' })],
  ['tiroir de service : forge (certificat, 7 jours)', 'ServiceDrawer', l => ({ seed: { ...all(l), '/api/history/service/forge?range=7d': { historySince: null, bandStart: NOW - 7 * D, bandSize: 6 * H, checks: [{ id: 'forge-http', label: 'forge-http', type: 'http', state: 'warn', uptime: 99.97, target: 'https://forge.example.net', band: band(24, [3]), points: pts(28, 700) }], incidents: [] } }, search: 's=forge&range=7d' })],
  ['tiroir d\'hôte : web (agent complet, admin)', 'HostDrawer', l => ({ seed: all(l), search: 'h=web' })],
  ['tiroir d\'hôte : web (lecture anonyme)', 'HostDrawer', l => ({ seed: all(l, ANON), search: 'h=web' })],
  ['tiroir d\'hôte : nas (agent injoignable)', 'HostDrawer', l => ({ seed: all(l), search: 'h=nas' })],
  ['tiroir d\'appareil : imprimante (admin)', 'DeviceDrawer', l => ({ seed: all(l), search: 'd=5' })],
  ['tiroir d\'appareil : imprimante (lecture anonyme)', 'DeviceDrawer', l => ({ seed: all(l, ANON), search: 'd=5' })],
  ['tiroir d\'appareil : suppression impossible', 'DeviceDrawer', l => ({ seed: { ...all(l), '/api/network/devices/5': { ...DEVICE, hostId: 'web', hostSrc: 'pve', deletion: { allowed: false, why: 'MAC d\'identité de l\'hôte « web » (Proxmox)' } } }, search: 'd=5' })],
  ['formulaire d\'appareil', 'DeviceForm', l => ({ seed: all(l), props: { open: true, onClose() {}, device: DEVICE, types: NETWORK.types } })],
]

export const CASE_COUNT = CASES.length

export async function clientViewsOutputs(locale = 'fr') {
  const before = process.env.TZ
  process.env.TZ = TZ
  try {
    const m = await bundle()
    await m.useLocale(locale)
    const out = []
    let previous = null
    for (const [title, name, opts, ready, same] of CASES) {
      let body
      try {
        body = ready ? readable(mainOf(await frozen(() => m.renderReady(name, opts(locale))))) : readable(frozen(() => m.render(name, opts(locale))))
      } catch (e) {
        body = `!! erreur de rendu : ${String(e?.message ?? e).split('\n')[0]}`
      }
      // former name of a route: rendering identical to the previous case (its English name), otherwise the whole rendering
      const shown = same && body === previous ? '= même rendu que le cas précédent' : body
      previous = body
      out.push(`### ${title}`, shown, '')
    }
    return `${out.join('\n')}`
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

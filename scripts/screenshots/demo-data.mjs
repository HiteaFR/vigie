// Demo world of the README screenshots: every name, address and number is made up (example.net
// domains, RFC 5737 addresses, generic host names, invented MAC addresses on public vendor
// prefixes). The shapes copy the answers of the real routes (server/index.js, lib/status.js,
// lib/alerts/engine.js, lib/updates, lib/network, plugins/gitea); nothing is read from a real
// instance. Every timestamp is computed from `now`, so the "ago" texts do not move between runs.
//
// demoApi(now) → { '/api/…': body } for the fixed routes; rrd(now, node) and history(now, days)
// answer the parameterized ones.

const MIN = 60_000
const H = 60 * MIN
const D = 24 * H
const GIB = 1024 ** 3

// small deterministic generator (same screenshots on every run)
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const seedOf = text => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

// --- hosts ------------------------------------------------------------------------------------
// two Proxmox clusters: "prod" (pve-1) and "dev" (pve-2); vmid, address, kind
const GUESTS = [
  { vmid: 101, name: 'proxy', type: 'lxc', ip: '192.0.2.31', cluster: 'prod', cpu: 0.02, mem: 0.31 },
  { vmid: 102, name: 'dns-1', type: 'lxc', ip: '192.0.2.32', cluster: 'prod', cpu: 0.01, mem: 0.22 },
  { vmid: 103, name: 'web-1', type: 'qemu', ip: '192.0.2.33', cluster: 'prod', cpu: 0.06, mem: 0.48 },
  { vmid: 104, name: 'db-1', type: 'lxc', ip: '192.0.2.34', cluster: 'prod', cpu: 0.09, mem: 0.71 },
  { vmid: 105, name: 'apps', type: 'qemu', ip: '192.0.2.35', cluster: 'prod', cpu: 0.18, mem: 0.66 },
  { vmid: 106, name: 'media', type: 'qemu', ip: '192.0.2.36', cluster: 'prod', cpu: 0.27, mem: 0.58 },
  { vmid: 108, name: 'home-assistant', type: 'qemu', ip: '192.0.2.37', cluster: 'prod', cpu: 0.04, mem: 0.52 },
  { vmid: 109, name: 'cloud', type: 'qemu', ip: '192.0.2.38', cluster: 'prod', cpu: 0.05, mem: 0.61 },
  { vmid: 110, name: 'git', type: 'lxc', ip: '192.0.2.39', cluster: 'prod', cpu: 0.03, mem: 0.44 },
  { vmid: 111, name: 'monitoring', type: 'lxc', ip: '192.0.2.40', cluster: 'prod', cpu: 0.04, mem: 0.39 },
  { vmid: 112, name: 'backup', type: 'lxc', ip: '192.0.2.41', cluster: 'prod', cpu: 0.01, mem: 0.27 },
  { vmid: 201, name: 'dev-1', type: 'qemu', ip: '192.0.2.51', cluster: 'dev', cpu: 0.07, mem: 0.55 },
  { vmid: 202, name: 'ci-runner', type: 'lxc', ip: '192.0.2.52', cluster: 'dev', cpu: 0.12, mem: 0.34 },
  { vmid: 203, name: 'web-staging', type: 'lxc', ip: '192.0.2.53', cluster: 'dev', cpu: 0.02, mem: 0.29 },
  { vmid: 204, name: 'sandbox', type: 'qemu', ip: '192.0.2.54', cluster: 'dev', cpu: 0, mem: 0, stopped: true },
]
const NODES = {
  prod: { name: 'pve-1', ip: '192.0.2.10', cpu: 0.23, maxcpu: 16, mem: 0.64, maxmem: 64 * GIB, uptime: 41 * 86400 + 5 * 3600 },
  dev: { name: 'pve-2', ip: '192.0.2.11', cpu: 0.11, maxcpu: 8, mem: 0.57, maxmem: 32 * GIB, uptime: 12 * 86400 + 19 * 3600 },
}
const envOfCluster = c => (c === 'dev' ? 'dev' : 'prod')
const HOSTS = [
  { id: 'pve-1', name: 'pve-1', kind: 'pve-node', pve: 'prod', vmid: null, ip: NODES.prod.ip, env: 'prod', parent: null },
  { id: 'pve-2', name: 'pve-2', kind: 'pve-node', pve: 'dev', vmid: null, ip: NODES.dev.ip, env: 'dev', parent: null },
  { id: 'nas', name: 'nas', kind: 'external', pve: null, vmid: null, ip: '192.0.2.20', env: 'prod', parent: null },
  ...GUESTS.map(g => ({ id: g.name, name: g.name, kind: g.type === 'qemu' ? 'vm' : 'lxc', pve: g.cluster, vmid: g.vmid, ip: g.ip, env: envOfCluster(g.cluster), parent: NODES[g.cluster].name })),
]
const hostRef = id => {
  const h = HOSTS.find(x => x.id === id)
  return h ? { id: h.id, name: h.name, kind: h.kind, pve: h.pve, vmid: h.vmid, ip: h.ip, env: h.env } : null
}

// --- services ---------------------------------------------------------------------------------
// band: 48 cells of 30 min over 24 h ('o' ok, 'w' degraded, 'c' down), the last one is now
function band(id, { down = 0, degraded = [] } = {}) {
  const r = rng(seedOf(id))
  const cells = Array.from({ length: 48 }, () => (r() < 0.006 ? 'w' : 'o'))
  for (const i of degraded) cells[i] = 'w'
  for (let i = 0; i < down; i++) cells[47 - i] = 'c'
  return cells.join('')
}
const uptimeOf = b => {
  const v = [...b].map(c => (c === 'o' ? 100 : c === 'w' ? 92 : 0))
  return Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 100) / 100
}
const SERVICES = [
  { id: 'proxmox-1', name: 'Proxmox pve-1', group: 'infra', host: 'pve-1', url: 'https://pve-1.example.net:8006', latencyMs: 18, pinned: true },
  { id: 'proxmox-2', name: 'Proxmox pve-2', group: 'infra', host: 'pve-2', url: 'https://pve-2.example.net:8006', latencyMs: 21 },
  { id: 'pihole', name: 'Pi-hole', group: 'infra', host: 'dns-1', url: 'https://dns.example.net/admin', latencyMs: 4, pinned: true },
  { id: 'traefik', name: 'Traefik', group: 'infra', host: 'proxy', url: 'https://proxy.example.net', latencyMs: 6 },
  { id: 'gitea', name: 'Gitea', group: 'infra', host: 'git', url: 'https://git.example.net', latencyMs: 38, pinned: true },
  { id: 'grafana', name: 'Grafana', group: 'infra', host: 'monitoring', url: 'https://grafana.example.net', latencyMs: 52 },
  { id: 'vaultwarden', name: 'Vaultwarden', group: 'home', host: 'apps', url: 'https://vault.example.net', latencyMs: 45, state: 'warn', tlsDays: 12 },
  { id: 'nextcloud', name: 'Nextcloud', group: 'home', host: 'cloud', url: 'https://cloud.example.net', latencyMs: 182, pinned: true, degraded: [14, 15] },
  { id: 'immich', name: 'Immich', group: 'home', host: 'apps', url: 'https://photos.example.net', latencyMs: null, state: 'crit', down: 1, degraded: [45, 46] },
  { id: 'paperless', name: 'Paperless-ngx', group: 'home', host: 'apps', url: 'https://docs.example.net', latencyMs: 96 },
  { id: 'home-assistant', name: 'Home Assistant', group: 'home', host: 'home-assistant', url: 'https://ha.example.net', latencyMs: 27, pinned: true },
  { id: 'jellyfin', name: 'Jellyfin', group: 'media', host: 'media', url: 'https://jellyfin.example.net', latencyMs: 64, pinned: true, degraded: [6, 7, 8] },
  { id: 'sonarr', name: 'Sonarr', group: 'media', host: 'media', url: 'https://sonarr.example.net', latencyMs: 33 },
  { id: 'radarr', name: 'Radarr', group: 'media', host: 'media', url: 'https://radarr.example.net', latencyMs: 31 },
  { id: 'qbittorrent', name: 'qBittorrent', group: 'media', host: 'media', url: 'https://torrent.example.net', latencyMs: 12 },
  { id: 'blog', name: 'Blog', group: 'web', host: 'web-1', url: 'https://www.example.net', latencyMs: 74 },
  { id: 'blog-staging', name: 'Blog (staging)', group: 'web', host: 'web-staging', url: 'https://staging.example.net', latencyMs: 88, degraded: [30, 31] },
  { id: 'code', name: 'Code server', group: 'web', host: 'dev-1', url: 'https://code.example.net', latencyMs: 41 },
]
const TLS_DAYS = { proxmox: 64, pihole: 71, gitea: 47, grafana: 53, nextcloud: 39, immich: 58, 'home-assistant': 33, jellyfin: 44, blog: 81 }

function servicesView(now) {
  return SERVICES.map(s => {
    const h = hostRef(s.host)
    const b = band(s.id, s)
    const state = s.state ?? 'ok'
    const checks = [{ id: `${s.id}#0`, type: 'http', target: s.url, state: state === 'warn' ? 'ok' : state, latencyMs: s.latencyMs, code: state === 'crit' ? 502 : 200, error: state === 'crit' ? 'HTTP 502' : null, checkedAt: now - 40_000 }]
    const days = s.tlsDays ?? TLS_DAYS[s.id] ?? TLS_DAYS[s.id.split('-')[0]]
    if (days != null) checks.push({ id: `${s.id}#1`, type: 'tls', target: new URL(s.url).hostname, state: days < 21 ? 'warn' : 'ok', latencyMs: null, tls: { daysLeft: days, validTo: now + days * D }, checkedAt: now - 2 * H })
    return {
      id: s.id, name: s.name, group: s.group, env: h.env, url: s.url, desc: null, icon: null,
      tags: [], pinned: !!s.pinned, container: null, host: h, state,
      latencyMs: s.latencyMs, uptime24h: uptimeOf(b), band24h: b, widget: null, checks,
    }
  })
}

// --- alerts -----------------------------------------------------------------------------------
function alertsActive(now) {
  return [
    { key: 'service_down:immich', rule: 'service_down', entity: 'immich', title: 'Immich', env: 'prod', severity: 'critical', state: 'firing', since: now - 23 * MIN, firedAt: now - 20 * MIN, suppressed: null, flapping: false, detail: 'HTTP https://photos.example.net: HTTP 502', host: 'apps', link: '/services?s=immich', notified: true, incidentId: 48, hostId: 'apps', ack: null },
    { key: 'cert_expiry:vaultwarden#1', rule: 'cert_expiry', entity: 'vaultwarden', title: 'Vaultwarden — TLS vault.example.net', env: 'prod', severity: 'warning', state: 'firing', since: now - 9 * D, firedAt: now - 9 * D, suppressed: null, flapping: false, detail: `expires in 12 d (${new Date(now + 12 * D).toLocaleDateString('en-GB')})`, host: 'apps', link: '/services?s=vaultwarden', notified: true, incidentId: 41, hostId: 'apps', ack: null },
    { key: 'net_new:25', rule: 'net_new', entity: 'dev:25', title: 'New device: Espressif Inc. (device 25)', env: 'prod', severity: 'warning', state: 'firing', since: now - 2 * H - 14 * MIN, firedAt: now - 2 * H - 9 * MIN, suppressed: null, flapping: false, detail: '24:0a:c4:5e:91:07 · Espressif Inc.', host: null, link: '/network?d=25', notified: true, incidentId: 47, hostId: null, ack: null },
    { key: 'security_updates:web-1', rule: 'security_updates', entity: 'web-1', title: 'Security updates · web-1', env: 'prod', severity: 'warning', state: 'firing', since: now - 26 * H, firedAt: now - 26 * H, suppressed: null, flapping: false, detail: '4 security updates out of 11 pending', host: 'web-1', link: '/updates?q=web-1', notified: true, incidentId: 44, hostId: 'web-1', ack: { by: 'admin', reason: 'Planned for the Wednesday maintenance window', at: now - 5 * H, until: null } },
    { key: 'backup_late:web-staging', rule: 'backup_late', entity: 'web-staging', title: 'Backup web-staging (203)', env: 'dev', severity: 'info', state: 'firing', since: now - 27 * H, firedAt: now - 27 * H, suppressed: null, flapping: false, detail: 'last backup 2 d ago', host: 'web-staging', link: '/backups', notified: true, incidentId: 43, hostId: 'web-staging', ack: null },
    { key: 'guest_stopped:sandbox', rule: 'guest_stopped', entity: 'sandbox', title: 'sandbox', env: 'dev', severity: 'warning', state: 'firing', since: now - 3 * H, firedAt: now - 3 * H, suppressed: 'silence: Rebuilding the sandbox VM', flapping: false, detail: 'Proxmox state: stopped', host: 'sandbox', link: '/infra?h=sandbox', notified: false, incidentId: 46, hostId: 'sandbox', ack: null },
  ]
}
function incidents(now, active) {
  const ongoing = active.map(a => ({ id: a.incidentId, key: a.key, rule: a.rule, entity: a.entity, title: a.title, env: a.env, severity: a.severity, startedAt: a.since, resolvedAt: null, summary: a.detail, suppressed: a.suppressed, ack: a.ack ? { by: a.ack.by, reason: a.ack.reason, at: a.ack.at } : null }))
  const past = [
    [45, 'service_down:jellyfin', 'service_down', 'Jellyfin', 'prod', 'critical', 21 * H + 10 * MIN, 38 * MIN, 'HTTP https://jellyfin.example.net: timeout'],
    [42, 'container_unhealthy:media/sonarr', 'container_unhealthy', 'Container sonarr · media', 'prod', 'warning', 31 * H, 12 * MIN, 'Docker healthcheck failing'],
    [40, 'disk_temp:pve-1/nvme0n1', 'disk_temp', 'Temperature nvme0n1 (pve-1)', 'prod', 'warning', 2 * D + 4 * H, 47 * MIN, '76 °C (thresholds 75 / 80 °C)'],
    [39, 'service_down:nextcloud', 'service_down', 'Nextcloud', 'prod', 'critical', 2 * D + 17 * H, 9 * MIN, 'HTTP https://cloud.example.net: HTTP 503'],
    [37, 'reboot_required:db-1', 'reboot_required', 'Reboot required · db-1', 'prod', 'info', 3 * D + 8 * H, 26 * H, 'kernel updated'],
    [36, 'storage_usage:pve-1/tank', 'storage_usage', 'Storage tank (pve-1)', 'prod', 'warning', 4 * D + 2 * H, 5 * H + 20 * MIN, '81 % used'],
    [34, 'ci_failed:homelab-config', 'ci_failed', 'CI homelab-config', 'dev', 'warning', 5 * D + 6 * H, 34 * MIN, 'run #214 failed on main'],
    [33, 'service_down:blog-staging', 'service_down', 'Blog (staging)', 'dev', 'warning', 6 * D + 1 * H, 16 * MIN, 'HTTP https://staging.example.net: HTTP 502'],
  ].map(([id, key, rule, title, env, severity, ago, dur, summary]) => ({ id, key, rule, entity: key.split(':')[1], title, env, severity, startedAt: now - ago, resolvedAt: now - ago + dur, summary, suppressed: null, ack: null }))
  return [...ongoing, ...past].sort((a, b) => b.startedAt - a.startedAt)
}

// --- updates ----------------------------------------------------------------------------------
function updates(now) {
  const c = x => ({
    id: x.id, name: x.name, kind: x.kind, host: x.host ?? null, where: x.where ?? x.host ?? null,
    env: x.env ?? (x.host ? hostRef(x.host)?.env : null) ?? 'prod', service: x.service ?? null,
    current: x.current ?? null, latest: x.latest ?? null, gap: x.gap ?? null,
    url: x.url ?? null, publishedAt: x.days != null ? new Date(now - x.days * D).toISOString() : null, notes: x.notes ?? null,
    skipped: x.skipped ?? null, breaking: x.breaking ?? 0, security: !!x.security, cve: null, securityIn: x.securityIn ?? null,
    latestSameMajor: x.latestSameMajor ?? null, nextMajor: x.nextMajor ?? null,
    eol: x.eol ?? null, auto: !!x.auto, local: false, detail: x.detail ?? null,
    source: x.source ?? null, error: x.error ?? null, apt: x.apt ?? null, newImage: false,
  })
  const auto = (state, ranH, applied = []) => ({ state, detail: state === 'off' ? 'automatic updates disabled' : null, lastRunAt: Math.floor((now - ranH * H) / 1000), lastResult: 'success', applied })
  const components = [
    c({ id: 'os:db-1', name: 'Debian', kind: 'os', host: 'db-1', current: '11', latest: '13', gap: 'major', nextMajor: '13', eol: { cycle: '11', date: '2026-08-31', passed: true, soon: false, link: null }, source: 'endoflife.date' }),
    c({ id: 'runtime:db-1/postgresql', name: 'PostgreSQL', kind: 'runtime', host: 'db-1', current: '13.16', latest: '13.22', gap: 'patch', eol: { cycle: '13', date: '2025-11-13', passed: true, soon: false, link: null }, days: 96, source: 'endoflife.date' }),
    c({ id: 'docker:cloud/nextcloud', name: 'Nextcloud', kind: 'docker', host: 'cloud', current: '31.0.4', latest: '31.0.9', gap: 'patch', security: true, securityIn: '31.0.8', days: 9, url: 'https://github.example.net/nextcloud/server/releases', skipped: 5, source: 'docker' }),
    c({ id: 'apt:web-1', name: 'apt packages', kind: 'apt', host: 'web-1', current: '11 pending', gap: 'patch', security: true, detail: '4 security', apt: { upgradable: 11, security: 4, held: 0, ageDays: 0.3, autoUpdate: auto('off', 0) } }),
    c({ id: 'pve:prod', name: 'Proxmox VE', kind: 'pve', host: 'pve-1', where: 'pve-1', current: '8.4.14', latest: '9.1.1', gap: 'major', latestSameMajor: '8.4.14', days: 18, source: 'download.proxmox.com' }),
    c({ id: 'docker:apps/immich', name: 'Immich', kind: 'docker', host: 'apps', current: 'v1.142.1', latest: 'v2.2.3', gap: 'major', days: 6, skipped: 7, breaking: 1, latestSameMajor: 'v1.144.1', source: 'docker' }),
    c({ id: 'deploy:homelab-config', name: 'homelab-config', kind: 'deploy', where: 'git.example.net', env: 'prod', current: '#213', latest: 'a41f9c2', gap: 'deploy', days: 1, detail: 'main is ahead of the last deployment' }),
    c({ id: 'ha:core', name: 'Home Assistant', kind: 'ha', host: 'home-assistant', current: '2026.10.4', latest: '2026.11.1', gap: 'minor', days: 4, source: 'home-assistant' }),
    c({ id: 'docker:media/jellyfin', name: 'Jellyfin', kind: 'docker', host: 'media', current: '10.10.7', latest: '10.11.2', gap: 'minor', days: 12, source: 'docker' }),
    c({ id: 'app:gitea', name: 'Gitea', kind: 'app', host: 'git', current: '1.24.6', latest: '1.25.1', gap: 'minor', days: 15, source: 'github' }),
    c({ id: 'docker:proxy/traefik', name: 'Traefik', kind: 'docker', host: 'proxy', current: 'v3.5.3', latest: 'v3.6.1', gap: 'minor', days: 8, source: 'docker' }),
    c({ id: 'docker:apps/paperless', name: 'Paperless-ngx', kind: 'docker', host: 'apps', current: '2.18.4', latest: '2.19.5', gap: 'minor', days: 3, source: 'docker' }),
    c({ id: 'app:pihole', name: 'Pi-hole', kind: 'app', host: 'dns-1', current: 'v6.1.4', latest: 'v6.1.5', gap: 'patch', days: 10, auto: false, source: 'github' }),
    c({ id: 'apt:media', name: 'apt packages', kind: 'apt', host: 'media', current: '3 pending', gap: 'patch', apt: { upgradable: 3, security: 0, held: 0, ageDays: 0.2, autoUpdate: auto('active', 7, [{ name: 'openssl', version: '3.0.17-1' }]) } }),
    c({ id: 'docker:media/qbittorrent', name: 'qBittorrent', kind: 'docker', host: 'media', current: 'latest', latest: 'latest', gap: 'digest', days: 2, source: 'docker' }),
    c({ id: 'runtime:web-1/nodejs', name: 'Node.js', kind: 'runtime', host: 'web-1', current: '22.21.1', latest: '22.21.1', gap: 'same', eol: { cycle: '22', date: '2027-04-30', passed: false, soon: false, link: null }, source: 'endoflife.date' }),
    c({ id: 'docker:apps/vaultwarden', name: 'Vaultwarden', kind: 'docker', host: 'apps', current: '1.34.3', latest: '1.34.3', gap: 'same', source: 'docker' }),
    c({ id: 'docker:media/sonarr', name: 'Sonarr', kind: 'docker', host: 'media', current: '4.0.15', latest: '4.0.15', gap: 'same', auto: true, source: 'docker' }),
    c({ id: 'docker:media/radarr', name: 'Radarr', kind: 'docker', host: 'media', current: '5.28.0', latest: '5.28.0', gap: 'same', auto: true, source: 'docker' }),
    c({ id: 'apt:apps', name: 'apt packages', kind: 'apt', host: 'apps', current: '0 pending', gap: 'same', apt: { upgradable: 0, security: 0, held: 0, ageDays: 0.1, autoUpdate: auto('active', 5) } }),
    c({ id: 'apt:dns-1', name: 'apt packages', kind: 'apt', host: 'dns-1', current: '0 pending', gap: 'same', apt: { upgradable: 0, security: 0, held: 0, ageDays: 0.4, autoUpdate: auto('active', 6) } }),
    c({ id: 'pve:dev', name: 'Proxmox VE', kind: 'pve', host: 'pve-2', where: 'pve-2', current: '9.1.1', latest: '9.1.1', gap: 'same', source: 'download.proxmox.com' }),
    c({ id: 'docker:dev-1/code-server', name: 'code-server', kind: 'docker', host: 'dev-1', current: '4.105.1', latest: '4.106.0', gap: 'minor', days: 5, source: 'docker' }),
  ]
  const by = g => components.filter(x => x.gap === g).length
  return {
    checkedAt: new Date(now - 47 * MIN).toISOString(),
    components,
    counts: { total: components.length, security: components.filter(x => x.security).length, eol: components.filter(x => x.eol?.passed).length, major: by('major'), minor: by('minor'), patch: by('patch'), digest: by('digest'), deploy: by('deploy'), auto: components.filter(x => x.auto).length, ignored: 0, errors: 0, checkedAt: new Date(now - 47 * MIN).toISOString() },
    sources: [],
    stats: { requests: 31, notModified: 24, githubAuth: true },
  }
}

// --- network ----------------------------------------------------------------------------------
// presence band: 24 cells of one hour ('o' present, 'w' partly, 'c' absent), the last one is now
function presence(id, kind) {
  const r = rng(seedOf(`net${id}`))
  if (kind === 'always') return 'o'.repeat(24)
  if (kind === 'away') return Array.from({ length: 24 }, (_, i) => (i >= 1 && i < 9 ? 'c' : i === 0 || i === 9 ? 'w' : 'o')).join('')
  if (kind === 'evening') return Array.from({ length: 24 }, (_, i) => (i < 10 ? 'o' : i < 14 ? (r() < 0.5 ? 'w' : 'c') : 'c')).join('')
  if (kind === 'off3h') return `${'o'.repeat(20)}wccc`
  if (kind === 'new') return `${'-'.repeat(21)}woo`
  return Array.from({ length: 24 }, () => (r() < 0.06 ? 'w' : 'o')).join('')
}
// id, name, type, ip, mac, vendor, presence kind, extra
const DEVICES = [
  [1, 'Gateway', 'router', '192.0.2.1', '00:15:6d:3a:10:01', 'Ubiquiti Inc', 'always'],
  [2, 'Core switch', 'switch', '192.0.2.2', '00:27:22:4b:20:02', 'Ubiquiti Inc', 'always'],
  [3, 'AP living room', 'ap', '192.0.2.3', '00:27:22:4b:30:03', 'Ubiquiti Inc', 'always'],
  [4, 'AP office', 'ap', '192.0.2.4', '00:27:22:4b:30:04', 'Ubiquiti Inc', 'always'],
  [5, 'pve-1', 'hypervisor', '192.0.2.10', '00:12:f0:6e:a1:10', 'Intel Corporate', 'always', { hostId: 'pve-1' }],
  [6, 'pve-2', 'hypervisor', '192.0.2.11', '00:12:f0:6e:a1:11', 'Intel Corporate', 'always', { hostId: 'pve-2' }],
  [7, 'nas', 'nas', '192.0.2.20', '00:11:32:9c:44:20', 'Synology Incorporated', 'always', { hostId: 'nas' }],
  [8, 'proxy', 'server', '192.0.2.31', 'bc:24:11:5d:01:31', 'Proxmox Server Solutions GmbH', 'always', { hostId: 'proxy' }],
  [9, 'dns-1', 'server', '192.0.2.32', 'bc:24:11:5d:01:32', 'Proxmox Server Solutions GmbH', 'always', { hostId: 'dns-1' }],
  [10, 'apps', 'server', '192.0.2.35', 'bc:24:11:5d:01:35', 'Proxmox Server Solutions GmbH', 'always', { hostId: 'apps' }],
  [11, 'media', 'server', '192.0.2.36', 'bc:24:11:5d:01:36', 'Proxmox Server Solutions GmbH', 'always', { hostId: 'media' }],
  [12, 'home-assistant', 'server', '192.0.2.37', 'bc:24:11:5d:01:37', 'Proxmox Server Solutions GmbH', 'always', { hostId: 'home-assistant' }],
  [13, 'Zigbee bridge', 'iot', '192.0.2.60', '28:cd:c1:07:3e:60', 'Raspberry Pi Trading Ltd', 'always'],
  [14, 'Living room TV', 'tv', '192.0.2.101', '00:07:ab:a8:12:65', 'Samsung Electronics Co.,Ltd', 'evening'],
  [15, 'Kitchen speaker', 'speaker', '192.0.2.102', '00:04:3c:51:8e:66', 'SONOS Co., Ltd.', 'normal'],
  [16, 'Office printer', 'printer', '192.0.2.103', '00:1b:a9:2f:70:67', 'Brother industries, LTD.', 'off3h', { online: 0 }],
  [17, 'Front door camera', 'camera', '192.0.2.104', 'ec:71:db:16:c4:68', 'Reolink Innovation Limited', 'always'],
  [18, 'Light bridge', 'iot', '192.0.2.105', 'c4:29:96:3d:5a:69', 'Signify B.V.', 'always'],
  [19, 'Smart plug (desk)', 'iot', '192.0.2.106', '84:00:ec:72:19:6a', 'Shelly Europe LTD', 'always'],
  [20, 'Game console', 'console', '192.0.2.120', '00:16:56:e4:0b:78', 'Nintendo Co., Ltd.', 'evening'],
  [21, 'Work laptop', 'laptop', '192.0.2.130', '00:08:74:c1:5f:82', 'Dell Inc.', 'normal'],
  [22, 'MacBook', 'laptop', '192.0.2.131', '00:05:02:7a:e3:83', 'Apple, Inc.', 'normal'],
  [23, 'Phone', 'phone', '192.0.2.140', '02:3f:8a:61:d2:8c', null, 'away', { random: true }],
  [24, 'Tablet', 'tablet', '192.0.2.141', '06:b2:57:e9:14:8d', null, 'evening', { random: true, online: 0 }],
  [25, null, 'iot', '192.0.2.147', '24:0a:c4:5e:91:07', 'Espressif Inc.', 'new', { state: 'new' }],
]
function network(now) {
  const iso = t => new Date(t).toISOString()
  const devices = DEVICES.map(([id, name, type, ip, mac, vendor, kind, extra = {}]) => {
    const b = presence(id, kind)
    const online = extra.online ?? (b.at(-1) === 'c' ? 0 : 1)
    const lastPresent = online ? now - 40_000 : now - (kind === 'off3h' ? 3 : 9) * H - 12 * MIN
    return {
      id, name, type, icon: null, state: extra.state ?? 'known', review: false,
      freshness: online ? 'active' : 'idle', lastSeen: iso(lastPresent), lastDhcp: iso(now - 5 * H), firstSeen: iso(now - (extra.state === 'new' ? 2.3 * H : 180 * D)),
      ip, mac, macs: 1, random: !!extra.random, grade: null, vendor, hostId: extra.hostId ?? null, hostSrc: extra.hostId ? 'config' : null,
      location: null, origin: null, pending: 0, online, onlineSince: online ? iso(now - 2 * H) : null, lastPresent: iso(lastPresent),
      profile: 'always', profileSet: false, alertDown: false, alertSeverity: null, expectedIp: null, band24h: b,
    }
  })
  const n = f => devices.filter(f).length
  const counts = {
    total: devices.length, active: n(d => d.freshness === 'active'), idle: n(d => d.freshness === 'idle'), dhcp: 0, stale: 0,
    new: n(d => d.state === 'new'), review: 0, pending: 0, online: n(d => d.online === 1), offline: n(d => d.online === 0), unknown: 0,
  }
  const src = (n, agoMs) => ({ ok: true, at: iso(now - agoMs), error: null, n, stale: false })
  return {
    enabled: true, presence: 'arp', presenceSince: iso(now - 120 * D), gateway: { ip: '192.0.2.1', source: 'route' }, arpIntervalSec: 300,
    generatedAt: iso(now), lastRunAt: iso(now - 70_000), intervalSec: 300, activeMin: 15, baseline: false, alertsSince: iso(now - 120 * D),
    sources: {
      pihole: src(22, 70_000), pve: src(7, 70_000), agent: src(5, 95_000),
      arp: { ...src(counts.online, 50_000), ms: 1840, installed: true, gatewayUnknown: false },
      mdns: { ok: true, at: iso(now - 4 * MIN), enabled: true, listening: true, error: null },
      probe: { ok: true, at: iso(now - 3 * D), enabled: true, running: false },
    },
    counts, devices, types: {}, suggestions: [], rules: [],
  }
}

// devices online per hour over `days` days (History tab)
export function history(now, days = 7) {
  const r = rng(days)
  const end = Math.floor(now / H) * H
  const points = []
  for (let t = end - days * D; t <= end; t += H) {
    const hour = new Date(t).getUTCHours()
    const base = 17 + (hour >= 7 && hour < 9 ? 2 : 0) + (hour >= 18 && hour < 23 ? 4 : 0) - (hour >= 1 && hour < 6 ? 2 : 0)
    points.push({ t: new Date(t).toISOString(), online: base + Math.round(r() * 2) })
  }
  return { enabled: true, days, points }
}

// CPU and RAM of a node over 24 h, one point every 10 min (cockpit sparklines)
export function rrd(now, node) {
  const r = rng(seedOf(node))
  const cpuBase = node === 'pve-1' ? 21 : 9
  const memBase = node === 'pve-1' ? 63 : 56
  const pts = []
  for (let i = 143; i >= 0; i--) {
    const t = now - i * 10 * MIN
    const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60
    // nightly backup around 02:00, daytime activity, noise
    const backup = hour >= 2 && hour < 3 ? 28 : 0
    const day = 6 * Math.sin(((hour - 8) / 24) * 2 * Math.PI)
    pts.push({ t, cpu: Math.max(1, cpuBase + day + backup + (r() - 0.5) * 6), mem: memBase + (backup ? 4 : 0) + Math.sin(i / 20) * 1.5 + (r() - 0.5), load: null })
  }
  return pts
}

// --- every fixed route --------------------------------------------------------------------------
export function demoApi(now) {
  const iso = t => new Date(t).toISOString()
  const services = servicesView(now)
  const active = alertsActive(now)
  const firing = active.filter(a => a.state === 'firing' && !a.suppressed)
  const net = network(now)
  const upd = updates(now)
  const guests = GUESTS.map(g => ({
    vmid: g.vmid, name: g.name, type: g.type, status: g.stopped ? 'stopped' : 'running', node: NODES[g.cluster].name,
    cpu: g.cpu, maxcpu: g.type === 'qemu' ? 4 : 2, mem: g.mem * 8 * GIB, maxmem: (g.type === 'qemu' ? 8 : 2) * GIB,
    disk: 0, maxdisk: 32 * GIB, uptime: g.stopped ? 0 : 9 * 86400,
  }))
  const cluster = Object.entries(NODES).map(([id, n]) => ({
    id, label: id === 'prod' ? 'Main cluster' : 'Lab',
    nodes: [{ name: n.name, status: 'online', cpu: n.cpu, maxcpu: n.maxcpu, mem: n.mem * n.maxmem, maxmem: n.maxmem, disk: 18 * GIB, maxdisk: 96 * GIB, uptime: n.uptime }],
    guests: guests.filter(g => g.node === n.name),
    storages: id === 'prod'
      ? [{ name: 'local', status: 'available', disk: 21 * GIB, maxdisk: 96 * GIB }, { name: 'local-lvm', status: 'available', disk: 1.12e12, maxdisk: 1.86e12 }, { name: 'tank', status: 'available', disk: 5.9e12, maxdisk: 7.9e12 }]
      : [{ name: 'local', status: 'available', disk: 14 * GIB, maxdisk: 96 * GIB }, { name: 'local-lvm', status: 'available', disk: 0.31e12, maxdisk: 0.93e12 }],
  }))
  const lat = services.map(s => s.latencyMs).filter(x => x != null).sort((a, b) => a - b)
  const svcCount = st => services.filter(s => s.state === st).length
  const declared = id => GUESTS.filter(g => g.cluster === id)
  const tonight = Math.ceil((now - 2 * H) / D) * D + 2 * H // next 02:00 UTC
  const summary = {
    generatedAt: iso(now), env: 'all', state: 'crit', sourcesDown: [],
    services: { total: services.length, ok: svcCount('ok'), warn: svcCount('warn'), crit: svcCount('crit'), unknown: 0, medianLatencyMs: lat[Math.floor(lat.length / 2)] },
    guests: {
      running: guests.filter(g => g.status === 'running').length, total: guests.length,
      byEnv: Object.fromEntries(Object.keys(NODES).map(id => [envOfCluster(id), { running: declared(id).filter(g => !g.stopped).length, total: declared(id).length, node: NODES[id].name }])),
      stoppedDeclared: GUESTS.filter(g => g.stopped).map(g => g.name), errors: [],
    },
    alerts: {
      critical: firing.filter(a => a.severity === 'critical').length, warning: firing.filter(a => a.severity === 'warning').length,
      info: firing.filter(a => a.severity === 'info').length, pending: 0, masked: active.filter(a => a.suppressed).length, incidents24h: 4,
    },
    certs: { total: 13, minDays: 12, minName: 'Vaultwarden', soon: 1 },
    backups: [
      { id: 'prod', node: 'pve-1', env: 'prod', total: 11, ok: 11, late: [], failed: [], last: tonight - D + 23 * MIN, next: tonight },
      { id: 'dev', node: 'pve-2', env: 'dev', total: 4, ok: 3, late: ['web-staging'], failed: [], last: tonight - D + 41 * MIN, next: tonight + 30 * MIN },
    ],
    ci: { configured: true, runnersOnline: 2, runnersTotal: 2, failing: [], running: 1, error: null },
    network: { presence: 'arp', online: net.counts.online, offline: net.counts.offline, unknown: 0, total: net.counts.total, active: net.counts.active, new: net.counts.new, review: 0, pending: 0, sourcesOk: true, sourcesDown: [], lastRunAt: net.lastRunAt },
    updates: upd.counts,
    weather: { code: 2, isDay: true, temp: 11.4, feels: 9.8, min: 6.2, max: 13.1, wind: 14, rain: 0, text: 'Partly cloudy', label: 'Home' },
  }
  const run = (number, status, minutesAgo, title, branch = 'main') => ({ branch, date: iso(now - minutesAgo * MIN), number, sha: 'a41f9c2', status, title, url: `https://git.example.net/lab/actions/runs/${number}` })
  const repo = (name, last) => ({ name, defaultBranch: 'main', htmlUrl: `https://git.example.net/lab/${name}`, openPRs: 0, lastCommit: null, lastRun: last, lastSuccess: last, mainRun: last })
  return {
    '/api/config': { title: 'Homelab', subtitle: 'Demo instance · made-up data', footer: 'Vigie · demo', locale: 'en' },
    '/api/session': { admin: false, anonymousRead: true, configured: true, networkAllowed: true, httpRefused: false, expiresAt: null, bot: { enabled: true }, refresh: { running: false, last: null } },
    '/api/services': {
      generatedAt: iso(now),
      groups: [{ id: 'infra', name: 'Infrastructure', icon: null }, { id: 'home', name: 'Home', icon: null }, { id: 'media', name: 'Media', icon: null }, { id: 'web', name: 'Web', icon: null }],
      services, bookmarks: [], hosts: HOSTS.map(h => ({ ...h, desc: null })),
      summary: { total: services.length, ok: svcCount('ok'), warn: svcCount('warn'), crit: svcCount('crit'), unknown: 0, none: 0 },
    },
    '/api/summary': summary,
    '/api/cluster': cluster,
    '/api/alerts': {
      generatedAt: iso(now), active, incidents: incidents(now, active),
      notifier: {
        telegram: true, dryRun: false, quietNow: false, queued: 0, deferred: 0, lastSentAt: now - 20 * MIN, lastError: null,
        channels: [{ id: 'telegram', label: 'Telegram', configured: true, queued: 0, lastSentAt: now - 20 * MIN, lastError: null }],
        graceUntil: now - 9 * D, quietHours: { start: '23:00', end: '07:00' }, digestAt: '08:00', heartbeat: { lastOkAt: now - MIN, lastError: null },
      },
    },
    '/api/silences': {
      active: [{ id: 7, matcher: { host: 'sandbox' }, target: 'host sandbox', reason: 'Rebuilding the sandbox VM', createdBy: 'admin', source: 'ui', createdAt: now - 3 * H, endsAt: now + 2 * D, endedAt: null, endedBy: null }],
      recent: [],
    },
    '/api/updates': { generatedAt: iso(now), ...upd },
    '/api/network': net,
    '/api/agents': { generatedAt: iso(now), hosts: ['web-1', 'db-1', 'apps', 'media', 'dns-1'].map(id => ({ id, name: id, agent: 'ssh' })) },
    '/api/gitea': [
      repo('homelab-config', run(214, 'running', 3, 'Traefik: new router for docs')),
      repo('blog', run(88, 'success', 95, 'Post: winter backup checklist')),
      repo('ansible', run(57, 'success', 26 * 60, 'Role for the media host')),
      repo('dotfiles', run(19, 'success', 4 * 24 * 60, 'Shell aliases')),
    ],
    '/api/runners': [
      { id: 1, name: 'runner-1', status: 'online', busy: true, labels: ['ubuntu-latest'] },
      { id: 2, name: 'runner-2', status: 'online', busy: false, labels: ['ubuntu-latest'] },
    ],
  }
}

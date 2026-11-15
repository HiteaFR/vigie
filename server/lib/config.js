// Loads and validates config.json (schema v2; v1 is refused with a clear message).
// Used by the server at startup and by scripts/check-config.js in CI, before the
// restart: an invalid config must never be deployed.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseCidr, isIpv4, inCidr } from './net/ip.js'
import { parseProxyEntry } from './net/proxies.js'
import { normalizeMac } from './net/mac.js'
import { isPrivateIpv4Literal } from './tls.js'
import { duration, envName } from './config-types.js'
import { probeTypes, widgetAuths, widgetFormats, latestSources, currentSources, unionOf, enumOf } from './registry.js'
// core entries registered in the registries (probes: lib/checks.js; widgets: lib/widget-types.js)
import './checks.js'
import './widget-types.js'
import './updates/source-types.js'

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id: lowercase letters, digits and dashes')
const env = z.enum(['prod', 'dev'])
// upper bound of hosts[].alerts.diskFreeMinGB (100 TB): anything above is a typo
export const DISK_FREE_MAX_GB = 100_000

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time: HH:MM')
const timeWindow = z.object({
  start: hhmm,
  end: hhmm,
  days: z.array(z.number().int().min(1).max(7)).optional(), // 1 = Monday
}).strict()

// alert settings of a service or a host
const alertOpts = z.object({
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  mute: z.boolean().optional(),
}).strict()
// hosts only: ports false → no port_new alert for this host (ports of a dev workstation
// that come and go); port memory, display, "Known" and other alerts unchanged. Absent or
// true: default behavior
// diskFreeMinGB: absolute free-space threshold of the root "/" (agent report), in GB of 1024³
// bytes like the display and df -h; below it → disk_free alert (warning). Absent: no alert of
// this kind (the percentage thresholds of alerts.disk still apply). Capped at 100,000 GB
// backups false → no not_backed_up or backup_late alert for this guest (deliberately left out of
// the backup jobs, e.g. a guest that can be recreated), nor in the cockpit and digest figures
// (status.js); backup_failed and the Backups page are unchanged. Absent or true: default behavior
const hostAlertOpts = alertOpts.extend({
  ports: z.boolean().optional(),
  backups: z.boolean().optional(),
  diskFreeMinGB: z.number().positive().max(DISK_FREE_MAX_GB).optional(),
}).strict()

// Schemas that embed a registry (probe types, widget authentications and formats, version
// sources) are functions: configSchema() rebuilds them when a registry changes (plugins register
// before the config is read; zod 4's z.lazy resolves its getter only once). Without plugins: same
// entries in the same order, hence same messages.

// origin http(s)://host[:port], without path, query, fragment or credentials
// Host made of letters, digits, dots and dashes, or IPv6 in brackets; optional port: nothing that
// could inject text into the CSP (";", ",", "'", "*", space, %XX). The resulting .origin
// is checked against the same pattern.
const ORIGIN = /^https?:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?\/?$/
const frameOrigin = z.string().refine(s => ORIGIN.test(s) && URL.canParse(s) && ORIGIN.test(new URL(s).origin),
  'origin http(s)://host[:port], without path, query or fragment').transform(s => new URL(s).origin)

// generic widget (inspired by Homepage, no code reused): API routes + extraction + format
const widgetSchema = () => z.object({
  url: z.string().url(),
  interval: duration.optional(),
  // authentications from the registry (lib/widget-types.js, then plugins)
  auth: unionOf(widgetAuths).optional(),
  fields: z.array(z.object({
    label: z.string(),
    path: z.string().startsWith('/'),
    json: z.string().optional(),
    prom: z.string().optional(),
    // formats from the registry (lib/widget-types.js, then plugins), same order without plugins
    format: enumOf(widgetFormats).optional(),
    unit: z.string().optional(),
  }).strict().refine(f => !(f.json && f.prom), 'json or prom, not both')).min(1),
}).strict()

// versions: where to read the installed version, where to find the latest one
// sources from the registries (lib/updates/source-types.js for core ones, then plugins),
// same sources in the same order without plugins
function versionSpecSchema() {
  const versionComponent = z.object({
    name: z.string().optional(),
    current: unionOf(currentSources, 'from'),
    latest: unionOf(latestSources, 'from').optional(),
    notes: z.string().url().optional(),
    auto: z.boolean().optional(), // the app updates itself: shown, not announced
  }).strict()
  return z.union([
    // Home Assistant: every update.* entity (core, OS, add-ons, HACS)
    z.object({ from: z.literal('ha'), url: z.string().url(), secretEnv: envName }).strict(),
    versionComponent,
    z.array(versionComponent).min(1),
  ])
}

// full MAC (normalized to lowercase); MAC prefix "aa:bb:cc:*" or "aa:bb:cc"
const mac = z.string().regex(/^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/, 'MAC: aa:bb:cc:dd:ee:ff').transform(normalizeMac)
const cidr = z.string().refine(s => parseCidr(s) != null, 'CIDR : a.b.c.d/nn')

const host = z.object({
  id,
  name: z.string(),
  kind: z.enum(['pve-node', 'vm', 'lxc', 'appliance', 'external']),
  pve: z.string().optional(),
  vmid: z.number().int().optional(),
  ip: z.string().optional(),
  parent: z.string().optional(),
  env,
  desc: z.string().optional(),
  alerts: hostAlertOpts.optional(),
  // dash-report agent: "ssh" (forced-command key) or "local" (the dashboard's container)
  agent: z.enum(['ssh', 'local']).optional(),
  // network module: links the device seen on the LAN to this host (except Proxmox guests, linked by their MAC)
  mac: mac.optional(),
  // containers false → no docker: component on the updates page for this host
  // (ephemeral dev containers); OS, apt and runtimes stay tracked, container alerts
  // and agent inventory unchanged. Absent or true: default behavior
  updates: z.object({ containers: z.boolean().optional() }).strict().optional(),
}).strict()

// Network module: optional, without this block the module does not start. Passive sources
// (pihole, neigh, pve) plus arp, a file written by the net-scan unit, whose path is restricted
// to /run/net-scan: the web process never reads an arbitrary path.
const network = z.object({
  // gateway: optional override of the ARP probe anchor (otherwise the container's default
  // route), an IPv4 address INSIDE the subnet's CIDR
  subnets: z.array(z.object({
    cidr,
    name: z.string(),
    gateway: z.string().refine(isIpv4, 'IPv4 expected').optional(),
  }).strict().refine(s => s.gateway == null || inCidr(s.gateway, s.cidr), { message: 'gateway outside the subnet', path: ['gateway'] })).min(1),
  sources: z.object({
    pihole: z.object({
      url: z.string().url(), secretEnv: envName, intervalSec: z.number().int().min(30).default(60),
    }).strict().optional(),
    neigh: z.object({ iface: z.string().regex(/^[\w.-]{1,15}$/, 'invalid interface').default('eth0') }).strict().optional(),
    pve: z.boolean().default(true),
    arp: z.object({
      file: z.string().regex(/^\/run\/net-scan\/[\w.-]+\.json$/, 'file: /run/net-scan/<name>.json').refine(s => !s.includes('..'), 'file: /run/net-scan/<name>.json'),
      intervalSec: z.number().int().min(30).default(120),
    }).strict().optional(),
  }).strict(),
  ingestDays: z.number().int().min(1).default(30), // MAC silent in Pi-hole for longer than this: no record
  activeMin: z.number().int().min(1).default(15), // "active" freshness
  maxNewPerCycle: z.number().int().min(1).default(20), // above this, creations suspended for 1 h
  // presence defaults live here only (no fallback in presence.js)
  // (.prefault: the default goes through the schema, inner defaults included)
  presence: z.object({
    fixedMin: z.number().positive().default(5),
    normalMin: z.number().positive().default(10),
    sleepyMin: z.number().positive().default(45),
    minMissedScans: z.number().int().min(1).default(3),
  }).strict().prefault({}),
  alerts: z.object({
    newSeverity: z.enum(['info', 'warning', 'critical']).default('warning'), // default set here only
  }).strict().prefault({}),
  // no network.ignore list (nothing is ignored); the .strict() schema refuses it. Only the
  // by-nature exclusions (mac.js) and the subnets perimeter remain
  // ranges where the IP is the identity (macvlan: random MAC on every re-creation)
  ipIdentity: z.array(cidr).default([]),
  // domain suffixes removed from discovered names, on top of .lan, .local, .home and
  // .localdomain (for example the domain an ISP router appends to DHCP names)
  hostSuffixes: z.array(z.string().max(253).regex(/^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i, 'domain suffix expected (example.net)')).max(16).default([]),
  // service probe; enabled only drives the scheduled probe; exclude (IPv4 or host id from
  // cfg.hosts) ALWAYS applies, to the scheduled probe as well as on demand
  probe: z.object({
    enabled: z.boolean().default(false),
    exclude: z.array(z.string().min(1).max(64)).max(256).default([]),
    // extra definition directories (*.json in the format of the shipped file), absolute
    // paths; absent: the shipped file only
    defsDirs: z.array(z.string().max(256).refine(s => s.startsWith('/'), 'absolute path')).max(8).optional(),
  }).strict().prefault({}),
  // passive mDNS listening; enabled false → no socket, and mdns attributes removed at
  // startup; iface: defaults to network.sources.neigh.iface (eth0)
  mdns: z.object({
    enabled: z.boolean().default(false),
    iface: z.string().regex(/^[\w.-]{1,15}$/, 'invalid interface').optional(),
  }).strict().prefault({}),
}).strict()

// VPN tunnel of a service, read from the fields of ITS widget (no extra call).
// type gluetun: /v1/vpn/status (status) and /v1/publicip/ip (organization, country). homeIsp:
// the home ISP (main protection): an organization that contains it (case-insensitive) =
// leak; countries (optional): expected exit countries, any other country = leak
export const VPN_FIELDS = Object.freeze({ status: ['/v1/vpn/status', 'status'], country: ['/v1/publicip/ip', 'country'], organization: ['/v1/publicip/ip', 'organization'] })
const vpn = z.object({
  type: z.literal('gluetun'),
  homeIsp: z.string().trim().min(2),
  countries: z.array(z.string().trim().min(2)).min(1).optional(),
}).strict()

const serviceSchema = () => z.object({
  id,
  name: z.string(),
  group: z.string(),
  host: z.string().optional(),
  container: z.string().optional(),
  env: env.optional(),
  url: z.string().url().optional(),
  desc: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  // probe types from the registry (lib/checks.js for core ones, then plugins)
  checks: z.array(unionOf(probeTypes)).optional(),
  alerts: alertOpts.optional(),
  widget: widgetSchema().optional(),
  version: versionSpecSchema().optional(),
  vpn: vpn.optional(),
}).strict()

const bookmarkGroup = z.object({
  group: z.string(),
  items: z.array(z.object({
    name: z.string(),
    url: z.string().url(),
    icon: z.string().optional(),
  }).strict()),
}).strict()

const proxmox = z.object({
  id: z.string(),
  label: z.string(),
  host: z.string().url(),
  // PREFIX of the cluster variables (<env>_TOKEN_ID, <env>_TOKEN_SECRET, <env>_HOST)
  env: envName,
  // discriminated union on mode, each branch strict; storage required in storage mode
  backups: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('tasks'), node: z.string(), jobs: z.number().int().optional() }).strict(),
    z.object({ mode: z.literal('storage'), node: z.string(), storage: z.string(), jobs: z.number().int().optional() }).strict(),
  ]).optional(),
  // pinned CA, path relative to server/; required for an https:// host
  ca: z.string().regex(/^pki\/[\w.-]+\.pem$/, 'ca: pki/<name>.pem (relative to server/)').optional(),
  // guests deliberately missing from hosts[] (no guest_undeclared alert)
  ignoreGuests: z.array(z.number().int().positive()).default([]),
}).strict().refine(p => !p.host.startsWith('https://') || p.ca, { message: 'ca required for an https:// host (pinned CA, pki/…)', path: ['ca'] })

// Alert engine and notifications: everything has a default value
// (.prefault: the default value goes through the schema, inner defaults included, as .default
// did in zod 3; zod 4's .default returns its value as is)
const unitName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.@\\-]{0,127}$/, 'systemd unit name')
const alerts = z.object({
  timezone: z.string().default('Europe/Paris'),
  dashboardUrl: z.string().url().optional(),    // links in Telegram messages
  quietHours: timeWindow.prefault({ start: '23:00', end: '07:30' }),
  businessHours: timeWindow.prefault({ start: '08:00', end: '19:00', days: [1, 2, 3, 4, 5] }),
  digestAt: hhmm.default('08:00'),
  startupGraceSec: z.number().int().min(0).default(120),
  failAfter: z.number().int().min(1).default(3),
  recoverAfter: z.number().int().min(1).default(2),
  repeat: z.object({ critical: duration.default('6h'), warning: duration.default('24h') }).strict().prefault({}),
  backupMaxAgeHours: z.number().positive().default(26),
  storage: z.object({ warnPct: z.number().default(80), critPct: z.number().default(90) }).strict().prefault({}),
  // internal file systems of hosts running the agent
  disk: z.object({ warnPct: z.number().default(85), critPct: z.number().default(95) }).strict().prefault({}),
  aptMaxAgeDays: z.number().positive().default(7),
  // automatic security updates (unattended-upgrades, agent v7): maximum age of the last run
  // (autoupdate_failed), and age from which a still-pending fix is considered stuck
  // (security_updates in automatic-updates mode)
  autoUpdateMaxAgeHours: z.number().positive().default(48),
  securityPendingHours: z.number().positive().default(48),
  // essential systemd units, common to all hosts: their failure makes systemd_failed
  // critical (others: warning). Exact name or name + ".service". None by default, each
  // instance declares its own (alerts.criticalUnits)
  criticalUnits: z.array(unitName).default([]),
  // Proxmox nodes: memory actually used, swap, SSD wear (remaining life)
  nodeMem: z.object({ warnPct: z.number().default(90), critPct: z.number().default(95) }).strict().prefault({}),
  nodeSwap: z.object({ warnPct: z.number().default(50) }).strict().prefault({}),
  diskWearMinPct: z.number().default(10),
  // temperature of the nodes' disks (SMART), °C; warn < crit
  diskTemp: z.object({ warn: z.number().default(75), crit: z.number().default(80) }).strict()
    .refine(t => t.warn < t.crit, { message: 'diskTemp: warn must be lower than crit', path: ['warn'] }).prefault({}),
}).strict().prefault({})

// recurring window during which the targeted alerts are not notified
const maintenance = timeWindow.extend({
  match: z.object({
    host: z.string().optional(),
    service: z.string().optional(),
    rule: z.string().optional(),
  }).strict().refine(m => Object.keys(m).length > 0, 'match: at least one criterion'),
  reason: z.string().optional(),
}).strict()

const buildSchemaV2 = () => z.object({
  version: z.literal(2),
  // instance language (texts and formats); "en" by default, "fr" must be set explicitly
  locale: z.enum(['fr', 'en']).default('en'),
  title: z.string(),
  subtitle: z.string().optional(),
  footer: z.string().optional(),
  // host names or IPv4 addresses accepted in the Host header, without port (in addition to
  // localhost, 127.0.0.1, [::1] and the name of alerts.dashboardUrl); any other Host → 421
  // origins allowed to show the dashboard in a frame (wall display mode); empty →
  // frame-ancestors 'none' and X-Frame-Options: DENY
  frameAncestors: z.array(frameOrigin).default([]),
  // IP addresses of trusted proxies (Traefik), read for X-Forwarded-For and
  // X-Forwarded-Proto only from these addresses; no names; empty → headers ignored.
  // Exact IPv4 or IPv6, or IPv4/IPv6 CIDR ranges (proxy in a container); prefix ≥ /8 in IPv4,
  // ≥ /32 in IPv6; an IPv6 range covering the IPv4-mapped addresses (::ffff:0:0/96) is refused, a
  // mapped entry counts as its IPv4 form (lib/net/proxies.js); no name, no port
  trustedProxies: z.array(z.string().refine(x => parseProxyEntry(x) != null, 'IPv4, IPv6 or CIDR (prefix ≥ /8 in IPv4, ≥ /32 in IPv6, never the IPv4-mapped range ::ffff:0:0/96), no name, no port')).default([]),
  // safe defaults (lib/security.js): listen address (a non-empty LISTEN_HOST wins; default
  // 127.0.0.1; "::" = all interfaces, dual stack); instance security options, with NO
  // default here (absent = safe default, and the startup log line says "default")
  listenHost: z.string().trim().min(1).max(255).optional(),
  security: z.object({
    anonymousRead: z.boolean().optional(), // API read access without a session (default false)
    httpLogin: z.boolean().optional(), // admin login over HTTP outside loopback (default false)
    // admin networks, IPv4 or IPv4/nn (a non-empty ADMIN_ALLOWED_CIDRS wins; default 127.0.0.1/32)
    adminCidrs: z.array(z.string().refine(s => isIpv4(s) || parseCidr(s) != null, 'a.b.c.d or a.b.c.d/nn')).min(1).optional(),
  }).strict().optional(),
  allowedHosts: z.array(z.string().regex(/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/, 'host name or IPv4, without port')).default([]),
  proxmox: z.array(proxmox),
  hosts: z.array(host),
  groups: z.array(z.object({ id, name: z.string(), icon: z.string().optional() }).strict()),
  services: z.array(serviceSchema()),
  bookmarks: z.array(bookmarkGroup).default([]),
  // former root-level block of a plugin (plugins/gitea: configKeys), accepted for now and
  // validated by the plugin's schema (validatePluginConfig), like plugins.<id>
  gitea: z.unknown().optional(),
  // blocks of internal plugins (plugins.<id>), validated by each plugin's schema
  // (lib/plugins/host.js, validatePluginConfig: at startup and in check-config)
  plugins: z.record(z.string(), z.unknown()).optional(),
  alerts,
  maintenance: z.array(maintenance).default([]),
  // durable update decisions (the UI adds its own, stored in the database)
  updates: z.object({
    ignore: z.array(z.object({
      id: z.string(),                                   // component id (updates view), trailing "*" accepted
      version: z.string().optional(),                   // ignore this version only (until the next one)
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: YYYY-MM-DD').optional(), // postpone
      pin: z.literal('major').optional(),               // never offer a major version
      reason: z.string().optional(),
    }).strict()).default([]),
  }).strict().prefault({}),
  network: network.optional(),
  weather: z.object({
    label: z.string(),
    lat: z.number(),
    lon: z.number(),
    timezone: z.string().optional(),
  }).strict().optional(),
}).strict()

// schemaV2 of the current registries, rebuilt when one of them changes (names and order)
let built = null
function configSchema() {
  const key = [probeTypes, widgetAuths, widgetFormats, currentSources, latestSources].map(r => r.names().join(' ')).join('|')
  if (built?.key !== key) built = { key, schema: buildSchemaV2() }
  return built.schema
}

// Consistency checks zod cannot express (cross references)
// errors (config refused) and warnings (logged, the dashboard starts)
// → { errors, warnings }
function crossCheck(cfg) {
  const errors = []
  const warnings = []
  const dup = (list, what) => {
    const seen = new Set()
    for (const x of list) {
      if (seen.has(x.id)) errors.push(`duplicate ${what}: ${x.id}`)
      seen.add(x.id)
    }
  }
  dup(cfg.hosts, 'host')
  dup(cfg.groups, 'group')
  dup(cfg.services, 'service')
  const hosts = new Set(cfg.hosts.map(h => h.id))
  const groups = new Set(cfg.groups.map(g => g.id))
  const pves = new Set(cfg.proxmox.map(p => p.id))
  for (const h of cfg.hosts) {
    if (h.parent && !hosts.has(h.parent)) errors.push(`host ${h.id}: unknown parent "${h.parent}"`)
    if (h.pve && !pves.has(h.pve)) errors.push(`host ${h.id}: unknown proxmox "${h.pve}"`)
    if ((h.kind === 'vm' || h.kind === 'lxc') && (h.vmid == null || !h.pve)) {
      errors.push(`host ${h.id}: a VM/LXC requires pve and vmid`)
    }
    if (h.agent === 'ssh' && !h.ip) errors.push(`host ${h.id}: ssh agent without ip`)
    // disk_free reads the agent report: without an agent the threshold is useless (warning only)
    if (h.alerts?.diskFreeMinGB != null && !h.agent) warnings.push(`host ${h.id}: alerts.diskFreeMinGB without agent (ignored)`)
    // backup alerts only exist for Proxmox guests (VM/LXC)
    if (h.alerts?.backups != null && h.kind !== 'vm' && h.kind !== 'lxc') warnings.push(`host ${h.id}: alerts.backups on a host that is not a VM or LXC (ignored)`)
  }
  const macs = cfg.hosts.filter(h => h.mac).map(h => h.mac)
  for (const m of new Set(macs.filter((m, i) => macs.indexOf(m) !== i))) errors.push(`hosts: duplicate MAC "${m}"`)
  if (cfg.hosts.filter(h => h.agent === 'local').length > 1) errors.push('local agent: a single host (the dashboard container)')
  // an exclusion entry is an IPv4 address or the id of a host of the config
  // an unknown exclusion only disables the probe (probe.js); warning only
  for (const x of cfg.network?.probe?.exclude ?? []) if (!isIpv4(x) && !hosts.has(x)) warnings.push(`network.probe.exclude: "${x}" is neither an IPv4 address nor a host (service probe disabled)`)
  for (const s of cfg.services) {
    // TLS exception of an http check, always justified; a widget with auth does not target
    // a private IP over https (no ca possible: the certificate could not be verified)
    for (const [i, c] of (s.checks ?? []).entries()) {
      if (c.tls && !c.tlsReason?.trim()) errors.push(`service ${s.id}: check ${i} tls: "insecure" without tlsReason`)
      if (!c.tls && c.tlsReason != null) errors.push(`service ${s.id}: check ${i} tlsReason without tls`)
    }
    if (s.widget?.auth && s.widget.url.startsWith('https://') && isPrivateIpv4Literal(new URL(s.widget.url).hostname)) {
      errors.push(`service ${s.id}: widget with auth over https to a private IP, without ca: certificate cannot be verified`)
    }
    if (!groups.has(s.group)) errors.push(`service ${s.id}: unknown group "${s.group}"`)
    if (s.host && !hosts.has(s.host)) errors.push(`service ${s.id}: unknown host "${s.host}"`)
    if (!s.host && !s.env) errors.push(`service ${s.id}: env required when host is missing`)
    if (!s.url && (s.checks?.length ?? 0) === 0) errors.push(`service ${s.id}: neither url nor probe`)
    const comps = !s.version || s.version.from === 'ha' ? [] : [s.version].flat()
    for (const v of comps) {
      if (v.current.from === 'agent' && !cfg.hosts.find(h => h.id === s.host)?.agent) {
        errors.push(`service ${s.id}: version read by the agent, but host "${s.host ?? '?'}" has no agent`)
      }
      for (const re of [v.current.regex, v.latest?.tagPattern].filter(Boolean)) {
        try {
          new RegExp(re)
        } catch {
          errors.push(`service ${s.id}: invalid regular expression "${re}"`)
        }
      }
    }
    if (Array.isArray(s.version) && s.version.some(v => !v.name)) errors.push(`service ${s.id}: several version components, each one needs a name`)
    // a vpn service reads its widget: text fields expected, and a host (parents)
    if (s.vpn) {
      const need = ['status', 'organization', ...(s.vpn.countries ? ['country'] : [])]
      for (const k of need) {
        const [p, j] = VPN_FIELDS[k]
        const f = s.widget?.fields.find(x => x.path === p && x.json === j)
        if (!f) errors.push(`service ${s.id}: vpn requires a widget field ${p} (json ${j})`)
        else if ((f.format ?? 'number') !== 'text') errors.push(`service ${s.id}: widget field ${p} (json ${j}) must use the text format`)
      }
      if (!s.host) errors.push(`service ${s.id}: vpn requires a host`)
    }
  }
  // a guest both ignored AND declared: the declaration wins (warning only)
  for (const p of cfg.proxmox) {
    for (const vmid of p.ignoreGuests) {
      if (cfg.hosts.some(h => h.pve === p.id && h.vmid === vmid)) warnings.push(`proxmox ${p.id}: guest ${vmid} declared both in hosts[] and in ignoreGuests`)
    }
  }
  for (const [i, m] of cfg.maintenance.entries()) {
    if (m.match.host && !hosts.has(m.match.host)) errors.push(`maintenance[${i}]: unknown host "${m.match.host}"`)
    if (m.match.service && !cfg.services.some(s => s.id === m.match.service)) errors.push(`maintenance[${i}]: unknown service "${m.match.service}"`)
  }
  try {
    // time zone validation only (the language plays no part)
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.alerts.timezone })
  } catch {
    errors.push(`alerts.timezone: unknown time zone "${cfg.alerts.timezone}"`)
  }
  return { errors, warnings }
}

// No secret in config.json (committed): widgets go through secretEnv.
// A field named like a secret, with a value, is refused (CI included).
const SECRET_KEY = /^(key|api_?key|password|passwd|token|secret|client_secret)$/i
function secretsIn(node, at = '', out = []) {
  if (Array.isArray(node)) node.forEach((x, i) => secretsIn(x, `${at}[${i}]`, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_KEY.test(k) && typeof v === 'string' && v) out.push(`${at}.${k}: plain-text secret forbidden, use secretEnv`)
      else secretsIn(v, `${at}.${k}`, out)
    }
  }
  return out
}

// hostHeader removed (undici does not forward a provided Host header: the option did nothing).
// A config that uses it is refused, never silently converted.
export const HOST_HEADER_GONE = 'hostHeader is no longer supported: put the name in url'
function retiredIn(raw) {
  const out = []
  ;(Array.isArray(raw.services) ? raw.services : []).forEach((s, i) => (Array.isArray(s?.checks) ? s.checks : []).forEach((c, j) => {
    if (c && typeof c === 'object' && 'hostHeader' in c) out.push(`services[${i}].checks[${j}].hostHeader : ${HOST_HEADER_GONE}`)
  }))
  return out
}

// v1 (links[] and health[], no version field) is no longer converted: clear refusal
export const V1_GONE = 'config v1 no longer supported: move to version 2 (see docs/configuration.md)'
// a null config, an array, a scalar or an empty object is not a v1
export const NOT_V2 = 'empty or invalid config: version 2 expected (see docs/configuration.md)'

export function parseConfig(raw) {
  const leaks = secretsIn(raw)
  if (leaks.length) return { errors: leaks }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) return { errors: [NOT_V2] }
  if (raw.version == null || raw.version === 1) return { errors: [V1_GONE] }
  const retired = retiredIn(raw)
  if (retired.length) return { errors: retired }
  const parsed = configSchema().safeParse(raw)
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  const { errors, warnings } = crossCheck(parsed.data)
  return errors.length ? { errors, warnings } : { config: parsed.data, warnings }
}

// "to be configured" mode. Only when CONFIG_PATH is ABSENT from the environment and the
// default path does not exist at all (lstat: a symbolic link, even broken, counts as present
// and fails on read). CONFIG_PATH set, even empty or made of spaces, means a declared
// instance: empty → error (a "CONFIG_PATH=" line of an EnvironmentFile overrides the unit's
// Environment= and must never silently start an empty instance).
// → { file, unconfigured } or { error }; lstat injectable (tests)
export function configSource({ configPath, defaultFile, lstat = fs.lstatSync }) {
  if (configPath !== undefined) {
    if (String(configPath).trim() === '') return { error: 'CONFIG_PATH is set but empty: path of the config file expected' }
    return { file: path.resolve(configPath), unconfigured: false }
  }
  try {
    lstat(defaultFile)
    return { file: defaultFile, unconfigured: false }
  } catch (e) {
    return { file: defaultFile, unconfigured: e?.code === 'ENOENT' }
  }
}
// built-in config of the "to be configured" mode: nothing to read, nothing to probe
export const UNCONFIGURED = Object.freeze({ version: 2, title: 'Vigie', proxmox: [], hosts: [], groups: [], services: [], alerts: {} })

export function loadConfig(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return { errors: [`reading ${file}: ${e.message}`] }
  }
  return parseConfig(raw)
}

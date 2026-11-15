import express from 'express'
import { fetch as uFetch } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, parseConfig, configSource, UNCONFIGURED } from './lib/config.js'
import { setLocale, t as tr } from './lib/i18n.js'
import { createMonitor, worst } from './lib/monitor.js'
import { createSources } from './lib/sources.js'
import { openDb } from './lib/db.js'
import { createClock } from './lib/clock.js'
import { createRules, RULE_LABEL, CORE_RULES } from './lib/alerts/rules.js'
import { createEngine } from './lib/alerts/engine.js'
import { ackMany, knownMany, ackMessage, reasonOf } from './lib/alerts/bulk.js'
import { createCollector } from './lib/alerts/collect.js'
import { createTelegram } from './lib/notify/telegram.js'
import { createFormatter } from './lib/notify/format.js'
import { createNotifier } from './lib/notify/notifier.js'
import { buildDigest, createDigest } from './lib/notify/digest.js'
import { createHistory } from './lib/history.js'
import { summary } from './lib/status.js'
import { createWeather } from './lib/weather.js'
import { createWidgets } from './lib/widgets.js'
import { createPiholes } from './lib/pihole.js'
import { createAgents } from './lib/agents.js'
import { createUpstream } from './lib/updates/upstream.js'
import { createUpdates } from './lib/updates/index.js'
import { createAgentMemory, agentsView } from './lib/agentmemory.js'
import { createDecisions } from './lib/updates/decisions.js'
import { createAuth, createAudit, sameOrigin, allowedHostsOf, hostGuard } from './lib/auth.js'
import { resolveSecurity, securityLogLine } from './lib/security.js'
import { createSilences } from './lib/alerts/silences.js'
import { createRefresher } from './lib/refresh.js'
import { createNetwork } from './lib/network/index.js'
import { createBot } from './lib/notify/bot.js'
import { tHtml } from './lib/notify/format.js'
import { statusLines } from './lib/notify/status.js'
import { errorHandler, wrap, installProcessHandlers } from './lib/http-errors.js'
import { securityHeaders, staticHeaders, iconHeaders, missingAsset } from './lib/security-headers.js'
import { stateDir, iconsDir } from './lib/paths.js'
import { AUDIT, auditLabel, auditRow, silenceDetail } from './lib/codes.js'
import { loadIconUrls, iconRoute } from './lib/icons.js'
import { readRevision } from './lib/revision.js'
import { VERSION } from './lib/user-agent.js'
import { shutdown } from './lib/shutdown.js'
import { withUserAgent, createHttp } from './lib/http.js'
import { createHost, validatePluginConfig } from './lib/plugins/host.js'
import { coreModules, CORE_MODULE_RULES, RESERVED_PLUGIN_IDS } from './lib/plugins/core.js'
import { PLUGINS } from './plugins/index.js'
import { registerExtensions } from './lib/plugins/extensions.js'

// an unhandled rejection is logged, the process keeps running
installProcessHandlers(console)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// --- optional .env (local dev); in production systemd injects EnvironmentFile ---
// ENV_FILE=none → no file read (tests, test bench); ENV_FILE=<path> → that file;
// without ENV_FILE → <root>/.env if it exists
const ENV_FILE = process.env.ENV_FILE
try {
  const envPath = ENV_FILE === 'none' ? null : ENV_FILE ? path.resolve(ENV_FILE) : path.join(ROOT, '.env')
  if (envPath && fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
} catch { /* ignore */ }

const { PORT = 8088 } = process.env

// CONFIG_PATH chooses the config file (default <root>/config.json).
// Default file missing AND CONFIG_PATH not set → "to be configured" mode (empty built-in
// config, status page in the client); otherwise, missing or invalid file → stop
const source = configSource({ configPath: process.env.CONFIG_PATH, defaultFile: path.join(ROOT, 'config.json') })
if (source.error) {
  console.error(`config: ${source.error}`)
  process.exit(1)
}
const unconfigured = source.unconfigured
if (unconfigured) console.warn(`config missing (${source.file}): "to configure" mode, nothing is read or probed; no collection, versions, digest, bot or heartbeat (see docs/installation.md)`)
// plugin extensions (probe types…) registered in the registries BEFORE the config, whose
// unions come from the registries; a refused extension → plugin_error (host), nothing is registered
const extensions = registerExtensions(PLUGINS, { reservedIds: RESERVED_PLUGIN_IDS })
for (const [id, msg] of extensions.errors) console.error(`[${id}] extensions refused: ${msg}`)
const loaded = unconfigured ? parseConfig(UNCONFIGURED) : loadConfig(source.file)
if (loaded.errors) {
  console.error('config.json invalid:\n  - ' + loaded.errors.join('\n  - '))
  process.exit(1)
}
const cfg = loaded.config
// instance language: texts (t) and formats (dates, numbers) of the process
setLocale(cfg.locale)
// config warnings are logged, the dashboard starts
for (const w of loaded.warnings ?? []) console.warn(`config.json: ${w}`)
// secure defaults: effective listening, anonymous read, HTTP login and admin networks, with their
// source (env, config, default; priority and reason in lib/security.js); log only, never
// a secret, nothing in healthz
const security = resolveSecurity(cfg, process.env)
console.log(securityLogLine(security))

const monitor = createMonitor(cfg)
const startedAt = Date.now()

const sources = createSources(cfg)
// pinned CA of each cluster in the log; warning 90 d before
// expiry; a missing or invalid CA puts the cluster in error, the service starts
for (const c of sources.clusters) {
  if (c.caError) console.error(`proxmox ${c.id}: certificate not verified: ${c.caError}`)
  else if (c.caInfo) {
    const msg = `proxmox ${c.id}: pinned CA ${c.ca} (${c.caInfo.subject}), expires on ${new Date(c.caInfo.validTo).toISOString().slice(0, 10)}`
    if (c.caInfo.daysLeft < 90) console.warn(`${msg}: in ${c.caInfo.daysLeft} d, renew it`)
    else console.log(msg)
  }
}

// --- alerts and notifications ---
// STATE_DIRECTORY comes from systemd (StateDirectory=vigie in deploy/vigie.service.example); else <root>/data (lib/paths.js)
const store = openDb(stateDir(process.env, ROOT))
// probe history: subscribed before the monitor starts
const history = createHistory(store, monitor)
monitor.start()
const weather = createWeather(cfg.weather)
weather.start()
// shared Pi-hole sessions (widget, network module): FTL limits their number
const piholes = createPiholes()
const widgets = createWidgets(cfg, process.env, { piholes })
widgets.start()
const agents = createAgents(cfg)
agents.start()
const clock = createClock(cfg.alerts.timezone)
const telegram = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID })
const formatter = createFormatter({ dashboardUrl: cfg.alerts.dashboardUrl, clock })
const dryRun = process.env.ALERTS_DRY_RUN === '1'
// writes (admin session), silences, update decisions, audit log
const audit = createAudit(store)
// accepted hosts (Host header, origin of writes and of the login)
const hosts = allowedHostsOf(cfg)
// real IP behind the trusted proxies (clientIp), never `trust proxy`
const auth = createAuth({ store, audit, allowedHosts: hosts, trustedProxies: cfg.trustedProxies, adminCidrs: security.adminCidrs.value, httpLogin: security.httpLogin.value })
const silences = createSilences({ store })
const decisions = createDecisions({ store })
// interactive bot: known chat and authorized accounts, not in dry-run (BOT_DISABLED=1 for a test instance)
const botWanted = telegram.configured && !!process.env.TELEGRAM_ALLOWED_USER_IDS && !dryRun && process.env.BOT_DISABLED !== '1'
// plugin channels (ntfy…) in addition to Telegram, read at each send (the host is created afterwards)
const notifier = createNotifier({ cfg, store, clock, telegram, formatter, dryRun, buttons: botWanted, channels: () => host.channels() })
// host of modules and plugins (lib/plugins/host.js): the built-in plugins (plugins/index.js)
// first (their sources join the common collector), then the core modules (updates,
// network), added once created. Config block plugins.<id> validated before anything else
const pluginErrors = validatePluginConfig(cfg, PLUGINS)
if (pluginErrors.length) {
  console.error('config.json invalid (plugins):\n  - ' + pluginErrors.join('\n  - '))
  process.exit(1)
}
const host = createHost({ cfg, env: process.env, store, http: createHttp({ defaultSecret: true }), plugins: PLUGINS, coreRules: CORE_RULES, reservedRules: CORE_MODULE_RULES, reservedIds: RESERVED_PLUGIN_IDS, extensionErrors: extensions.errors })
Object.assign(RULE_LABEL, host.labels(RULE_LABEL))
const collector = createCollector(sources, { extra: host.collectors() })
// network module: inert without a network block in config.json;
// same Pi-hole session as the widget
const netPihole = cfg.network?.sources.pihole
const network = createNetwork({
  cfg, store, sources, audit,
  // agent reports, through a function (no import of agents.js in lib/network)
  agentReports: () => agents.reports(),
  pihole: netPihole ? piholes.get(netPihole.url, netPihole.secretEnv) : null,
})
// versions and updates: read only, upstream sources cached in SQLite
const upstream = createUpstream({ store })
const updates = createUpdates({ cfg, store, agents, sources, collector, upstream, decisions, extraComponents: () => host.components() })
// memory of agent v8 (posture already seen compliant, accepted gaps, listening ports)
const memory = createAgentMemory({ db: store.db, kv: store.kv, hostIds: cfg.hosts.filter(h => h.agent).map(h => h.id) })
// "to be configured" mode: no versions, no collection, no evaluation, no digest, no bot, no
// heartbeat (an instance emptied by mistake does not claim to be alive)
// core modules (lib/plugins/core.js): versions, then network
for (const m of coreModules({ updates, network, unconfigured })) host.addModule(m)
host.start()
// the network module is created before the engine: it sets network.alertsSince before any evaluation
const engine = createEngine({ cfg, store, rules: createRules(cfg, monitor, agents, updates, null, widgets, memory, { host, channels: () => notifier.channelSignals() }), notifier, clock, silences, startedAt })
// network write (UI, bot): alerts re-evaluated immediately ("Known" resolves net_new)
network.onWrite(() => engine.evaluate(collector.snap))
network.firing(key => engine.active().some(a => a.key === key && a.state === 'firing'))
const buildNow = (now, { mark = false } = {}) => buildDigest({ cfg, engine, snap: collector.snap, monitor, formatter, clock, host, silences, mark, now })
const digest = createDigest({ cfg, store, notifier, clock, build: buildNow })
if (!unconfigured) collector.start()
const refresher = createRefresher({ agents, sources, collector, monitor, widgets, updates, engine, host })
const every = (ms, fn) => setInterval(() => {
  try {
    const r = fn()
    if (r?.catch) r.catch(e => console.error(e))
  } catch (e) {
    console.error(e)
  }
}, ms)
if (!unconfigured) {
  every(15_000, () => engine.evaluate(collector.snap))
  every(5_000, () => notifier.flush())
  every(60_000, () => digest.tick())
}
every(60_000, () => memory.observe(agents))
every(15_000, () => history.flush())
every(6 * 3600_000, () => {
  store.purge()
  history.purge()
  host.purge()
})
// bot /status: one line per domain (lib/notify/status.js)
function statusText() {
  return statusLines({ s: summary({ cfg, snap: collector.snap, monitor, engine, servicesView, host }), u: updates.counts(), silences: silences.active().length })
}

const bot = createBot({
  telegram, store, cfg, engine, silences, refresher, audit, clock,
  texts: { status: statusText, digest: () => buildNow(Date.now()) },
  allowedIds: process.env.TELEGRAM_ALLOWED_USER_IDS, network,
})
if (botWanted && !unconfigured) bot.start()

if (!telegram.configured) console.warn('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID): alerts visible in the dashboard only')
if (dryRun) console.warn('ALERTS_DRY_RUN=1: notifications are logged, not sent')

// Dead man's switch: healthchecks.io warns if this ping stops (dashboard, container or hypervisor down).
// We only ping if the alert engine is really running.
const heartbeat = { url: process.env.HEALTHCHECKS_PING_URL || null, lastOkAt: null, lastError: null }
if (heartbeat.url && !unconfigured) {
  every(60_000, async () => {
    if (!engine.lastEvalAt || Date.now() - engine.lastEvalAt > 120_000) return
    try {
      const r = await uFetch(heartbeat.url, { headers: withUserAgent(), signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await r.body?.cancel()
      heartbeat.lastOkAt = Date.now()
      heartbeat.lastError = null
    } catch (e) {
      heartbeat.lastError = String(e?.cause?.code || e.message || e)
    }
  })
}

const app = express()
// no X-Powered-By, no banner
app.disable('x-powered-by')
// Host header checked before anything else (DNS rebinding) → 421 if not in the list
app.use(hostGuard(hosts))
// CSP, nosniff, Referrer-Policy and X-Frame-Options on all the responses that follow
app.use(securityHeaders(cfg))
// JSON body of writes: small, and only on /api; 32 KB for the two
// bulk routes (200 items), read before the general limit (a body already read is not reread)
app.use(['/api/alerts/ack/bulk', '/api/agents/ports/known/bulk'], express.json({ limit: '32kb' }))
app.use('/api', express.json({ limit: '8kb' }))

// API read restricted to an admin session (allowed network + session), except explicit
// anonymous read (security.anonymousRead) and public routes. EXACT path comparison: a
// variant that Express routing would also accept (case, trailing slash) requires a session,
// never the reverse. Writes keep their guard (auth.require); /api/audit keeps its session.
const PUBLIC_READS = new Set(['/api/healthz', '/api/session', '/api/config'])
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  if (security.anonymousRead.value || PUBLIC_READS.has(req.baseUrl + req.path)) return next()
  auth.requireSession(req, res, next)
})

app.get('/api/cluster', wrap(async (req, res) => {
  res.json(await sources.cluster())
}))

// read routes of the plugin sources ("sources" slot: /api/gitea and /api/runners of the
// gitea plugin, at their historical paths)
host.mount(app, { wrap }, 'sources')

app.get('/api/backups', wrap(async (req, res) => {
  res.json(await sources.backups())
}))

// extended Proxmox data: nodes, disks and SMART, failed tasks, notifications
app.get('/api/proxmox', wrap(async (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), clusters: await sources.proxmoxView() })
}))

// dash-report agent: reports of the equipped hosts, "not instrumented" otherwise
// posture and listening ports only with an admin session (like the ports of the network
// module): without a session, neither slow.posture nor slow.listening (agentsView)
app.get('/api/agents', (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), hosts: agentsView(agents.view(), memory, { admin: auth.status(req).admin }) })
})

// Versions and updates: tracked components, gaps, failing sources
app.get('/api/updates', (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), ...updates.view() })
})

// Active alerts, incidents (7 d) and state of the notification channel
app.get('/api/alerts', (req, res) => {
  const now = Date.now()
  res.json({
    generatedAt: new Date(now).toISOString(),
    active: engine.active(),
    incidents: engine.incidents(now - 7 * 86400_000, 200),
    notifier: {
      ...notifier.status(now),
      graceUntil: startedAt + cfg.alerts.startupGraceSec * 1000,
      quietHours: cfg.alerts.quietHours,
      digestAt: cfg.alerts.digestAt,
      heartbeat: heartbeat.url ? { lastOkAt: heartbeat.lastOkAt, lastError: heartbeat.lastError } : null,
    },
  })
})

// --- admin session and writes --------------------------------------------
// Every write goes through auth.require: allowed network, Origin of the same host,
// JSON, valid session. Each action is logged (audit table).
const admin = (req, res, next) => auth.require(req, res, next)
const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) })
const ms = v => (v == null || v === '' ? null : Number(v))

// public (the client knows whether it must show the login); without a session or anonymous read,
// neither the bot state nor the refresh state
app.get('/api/session', (req, res) => {
  const st = auth.status(req)
  // unconfigured: no config file, the client shows the "to be configured" page
  const base = { ...st, anonymousRead: security.anonymousRead.value, ...(unconfigured ? { unconfigured: true } : {}) }
  if (!st.admin && !security.anonymousRead.value) return res.json(base)
  res.json({ ...base, bot: { enabled: botWanted, ...bot.status() }, refresh: refresher.status() })
})
app.post('/api/login', wrap(async (req, res) => {
  // same origin check as the writes: no forced login from another site
  if (!sameOrigin(req, hosts) || !req.is('application/json')) return res.status(403).json({ error: tr('api.origin_refused') })
  const r = await auth.login(req, res, req.body?.password)
  res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true, expiresAt: r.expiresAt } : { error: r.error })
}))
app.post('/api/logout', (req, res) => {
  auth.logout(req, res)
  res.json({ ok: true })
})

app.post('/api/alerts/ack', admin, (req, res) => {
  try {
    const a = engine.ack(String(req.body?.key || ''), { by: req.actor, reason: req.body?.reason, until: ms(req.body?.until) })
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.ACK, target: a.key, detail: req.body.reason })
    notifier.enqueueRaw('ack', tHtml('ack.ui_one', { title: a.title, reason: req.body.reason }))
    res.json(a)
  } catch (e) { fail(res, e) }
})
// posture (accept or withdraw the acceptance of a gap) and ports ("Known"); admin,
// reason required, audit; the rule concerned resolves or alerts again at the next evaluation
const v8Posture = host => { const sl = agents.get(host)?.slow; return sl?.version >= 8 ? sl.posture : null }
app.post('/api/agents/posture/accept', admin, (req, res) => {
  try {
    const { host, criterion, reason } = req.body ?? {}
    const r = memory.accept(String(host ?? ''), String(criterion ?? ''), reason, req.actor, v8Posture(String(host ?? '')))
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.POSTURE_ACCEPT, target: `${r.host}/${r.criterion}`, detail: r.accepted.reason })
    engine.evaluate(collector.snap)
    res.json(r)
  } catch (e) { fail(res, e) }
})
app.post('/api/agents/posture/unaccept', admin, (req, res) => {
  try {
    const { host, criterion, reason } = req.body ?? {}
    const r = memory.unaccept(String(host ?? ''), String(criterion ?? ''), reason, req.actor)
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.POSTURE_UNACCEPT, target: `${r.host}/${r.criterion}`, detail: String(reason).trim() })
    engine.evaluate(collector.snap)
    res.json(r)
  } catch (e) { fail(res, e) }
})
app.post('/api/agents/ports/known', admin, (req, res) => {
  try {
    const { host, proto, port, reason } = req.body ?? {}
    const r = memory.portKnown(String(host ?? ''), String(proto ?? ''), Number(port), reason, req.actor)
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.PORT_KNOWN, target: `${r.host}/${r.proto}/${r.port}`, detail: r.known.reason })
    engine.evaluate(collector.snap)
    res.json(r)
  } catch (e) { fail(res, e) }
})
// bulk actions (admin, one reason for the whole batch, at most BULK_MAX items, result per
// item, no all-or-nothing); one audit row per successful item
app.post('/api/alerts/ack/bulk', admin, (req, res) => {
  try {
    const results = ackMany(engine, { keys: req.body?.keys, reason: req.body?.reason, until: ms(req.body?.until), by: req.actor })
    const done = results.filter(r => r.ok)
    const reason = reasonOf(req.body.reason)
    for (const r of done) audit.log({ actor: req.actor, source: 'ui', action: AUDIT.ACK, target: r.key, detail: reason })
    // a single notification for the whole batch
    if (done.length) notifier.enqueueRaw('ack', ackMessage(done.map(r => r.title), reason))
    res.json({ results, ok: done.length, failed: results.length - done.length })
  } catch (e) { fail(res, e) }
})
app.post('/api/agents/ports/known/bulk', admin, (req, res) => {
  try {
    const results = knownMany(memory, { items: req.body?.items, reason: req.body?.reason, by: req.actor })
    const done = results.filter(r => r.ok)
    const reason = reasonOf(req.body.reason)
    for (const r of done) audit.log({ actor: req.actor, source: 'ui', action: AUDIT.PORT_KNOWN, target: `${r.host}/${r.proto}/${r.port}`, detail: reason })
    // a single evaluation for the whole batch
    if (done.length) engine.evaluate(collector.snap)
    res.json({ results, ok: done.length, failed: results.length - done.length })
  } catch (e) { fail(res, e) }
})
app.post('/api/alerts/unack', admin, (req, res) => {
  const a = engine.unack(String(req.body?.key || ''))
  if (!a) return res.status(404).json({ error: tr('api.alert_not_acked') })
  audit.log({ actor: req.actor, source: 'ui', action: AUDIT.UNACK, target: a.key })
  res.json(a)
})

app.get('/api/silences', (req, res) => {
  res.json({ active: silences.active(), recent: silences.recent(7) })
})
app.post('/api/silences', admin, (req, res) => {
  try {
    const s = silences.create({ matcher: req.body?.matcher, reason: req.body?.reason, by: req.actor, source: 'ui', endsAt: ms(req.body?.endsAt) })
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.SILENCE, target: s.target, detail: silenceDetail(s.reason, s.endsAt) })
    engine.evaluate(collector.snap)
    res.json(s)
  } catch (e) { fail(res, e) }
})
app.post('/api/silences/end', admin, (req, res) => {
  const s = silences.end(Number(req.body?.id), req.actor)
  if (!s) return res.status(404).json({ error: tr('api.silence_not_found') })
  audit.log({ actor: req.actor, source: 'ui', action: AUDIT.SILENCE_END, target: s.target })
  engine.evaluate(collector.snap)
  res.json(s)
})

app.post('/api/updates/decisions', admin, (req, res) => {
  try {
    const d = decisions.create({ ...req.body, by: req.actor })
    audit.log({ actor: req.actor, source: 'ui', action: AUDIT.UPDATE_DECISION, target: d.id, detail: `${req.body.mode} : ${d.reason}` })
    updates.redecide()
    res.json(d)
  } catch (e) { fail(res, e) }
})
app.post('/api/updates/decisions/remove', admin, (req, res) => {
  const d = decisions.remove(Number(req.body?.decisionId), req.actor)
  if (!d) return res.status(404).json({ error: tr('api.decision_not_found') })
  audit.log({ actor: req.actor, source: 'ui', action: AUDIT.UPDATE_DECISION_LIFT, target: d.id })
  updates.redecide()
  res.json(d)
})

app.post('/api/refresh', admin, (req, res) => {
  const r = refresher.run(req.actor)
  if (r.cooldownSec) return res.status(429).json({ error: tr('api.refresh_cooldown', { s: r.cooldownSec }) })
  if (r.started) audit.log({ actor: req.actor, source: 'ui', action: AUDIT.REFRESH })
  res.status(202).json({ started: r.started, running: true })
})
app.get('/api/refresh', (req, res) => res.json(refresher.status()))

// state of modules and plugins (Integrations page), readable like the others
// (session, unless anonymous read); no secret nor config
app.get('/api/plugins', (req, res) => res.json(host.view()))

app.get('/api/audit', (req, res, next) => auth.requireSession(req, res, next), (req, res) => res.json(audit.list(200).map(r => ({ ...auditRow(r), label: auditLabel(r.action) }))))

// Icons: downloaded by hand by scripts/vendor-icons.mjs into ICONS_DIR (default
// <state folder>/icons, outside the deployed tree), never in the repository. Slug → public URL, read
// once at startup (restart after adding one); same files as the /icons route
// (lib/icons.js: .svg or .png named after the slug, regular file). Missing or empty folder:
// no icon, a monogram is displayed.
const ICONS = iconsDir(process.env, ROOT)
const iconUrls = loadIconUrls(ICONS)

// iconUrlDark: "-light" variant of a monochrome icon, for the dark theme
const icon = slug => ({
  iconUrl: (slug && iconUrls.get(slug)) || null,
  iconUrlDark: (slug && iconUrls.get(`${slug}-light`)) || null,
})

const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
const checksByService = Map.groupBy(monitor.checks, c => c.serviceId)

function checkView(c) {
  const r = monitor.result(c.id)
  return {
    id: c.id, type: c.type, label: c.label, target: c.display,
    state: r?.state ?? 'unknown',
    latencyMs: r?.latencyMs ?? null,
    code: r?.code ?? null,
    error: r?.error ?? null,
    checkedAt: r?.checkedAt ?? null,
    ...(r?.tls ? { tls: r.tls } : {}),
  }
}

// service bar: all probes failing → c; some of them → w; otherwise o
function serviceBand(bands) {
  if (!bands.length) return null
  const len = bands[0].length
  let out = ''
  for (let i = 0; i < len; i++) {
    const cells = bands.map(b => b[i]).filter(x => x !== '-')
    out += !cells.length ? '-' : cells.every(x => x === 'c') ? 'c' : cells.some(x => x !== 'o') ? 'w' : 'o'
  }
  return out
}

// Service state: snapshot of the probes + 24 h uptime, without any outgoing call
function servicesView() {
  const bands = history.bands('24h')
  return cfg.services.map(s => {
    const h = s.host ? hostsById.get(s.host) : null
    const checks = (checksByService.get(s.id) || []).map(checkView)
    const timed = checks.find(c => c.type !== 'tls' && c.latencyMs != null)
    const avail = checks.filter(c => c.type !== 'tls').map(c => bands.checks[c.id]).filter(Boolean)
    const ups = avail.map(b => b.uptime).filter(x => x != null)
    return {
      id: s.id, name: s.name, group: s.group,
      env: s.env ?? h?.env,
      url: s.url ?? null, desc: s.desc ?? null,
      icon: s.icon ?? null, ...icon(s.icon),
      tags: s.tags ?? [], pinned: !!s.pinned, container: s.container ?? null,
      host: h ? { id: h.id, name: h.name, kind: h.kind, pve: h.pve ?? null, vmid: h.vmid ?? null, ip: h.ip ?? null, env: h.env } : null,
      state: checks.length ? worst(checks.map(c => c.state)) : 'none',
      latencyMs: timed?.latencyMs ?? null,
      uptime24h: ups.length ? Math.round((ups.reduce((a, b) => a + b, 0) / ups.length) * 100) / 100 : null,
      band24h: serviceBand(avail.map(b => b.band)),
      widget: widgets.get(s.id),
      checks,
    }
  })
}

app.get('/api/services', (req, res) => {
  const services = servicesView()
  const summary = { total: services.length, ok: 0, warn: 0, crit: 0, unknown: 0, none: 0 }
  for (const s of services) summary[s.state]++
  res.json({
    generatedAt: new Date().toISOString(),
    groups: cfg.groups.map(g => ({ id: g.id, name: g.name, icon: g.icon ?? null })),
    services,
    bookmarks: cfg.bookmarks.map(g => ({
      group: g.group,
      items: g.items.map(it => ({ name: it.name, url: it.url, ...icon(it.icon) })),
    })),
    hosts: cfg.hosts.map(h => ({
      id: h.id, name: h.name, kind: h.kind, pve: h.pve ?? null, vmid: h.vmid ?? null,
      ip: h.ip ?? null, env: h.env, parent: h.parent ?? null, desc: h.desc ?? null,
    })),
    summary,
  })
})

// Cockpit: aggregates (KPIs, overall state), filterable by environment
app.get('/api/summary', (req, res) => {
  const env = ['prod', 'dev'].includes(req.query.env) ? req.query.env : 'all'
  res.json({
    ...summary({ cfg, snap: collector.snap, monitor, engine, servicesView, host, env }),
    weather: weather.get()?.data ?? null,
  })
})

// --- network module (in-memory snapshot and SQLite) ---
// services hosted by a device: linked host, or URL / probe that targets its IP
const servicesOf = (ip, hostId) => servicesView()
  .filter(s => (hostId && s.host?.id === hostId) || s.host?.ip === ip
    || [s.url, ...s.checks.map(c => c.target)].some(u => typeof u === 'string' && new RegExp(`(^|//|@)${ip.replace(/\./g, '\\.')}(:|/|$)`).test(u)))
  .map(s => ({ id: s.id, name: s.name, state: s.state, url: s.url, ...icon(s.icon) }))
host.mount(app, { servicesOf, admin, fail, wrap, isAdmin: req => auth.status(req).admin })

const RANGES = ['24h', '7d', '30d', '90d']
const rangeOf = q => (RANGES.includes(q) ? q : '24h')

// History of a service: series per probe, uptime, incidents
app.get('/api/history/service/:id', (req, res) => {
  const s = cfg.services.find(x => x.id === req.params.id)
  if (!s) return res.status(404).json({ error: tr('api.unknown_service') })
  const range = rangeOf(req.query.range)
  const bands = history.bands(range === '24h' ? '24h' : range)
  const checks = (checksByService.get(s.id) || []).map(c => ({
    ...checkView(c),
    uptime: bands.checks[c.id]?.uptime ?? null,
    band: bands.checks[c.id]?.band ?? null,
    ...history.series(c.id, range),
  }))
  const since = Date.now() - { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[range] * 86400_000
  const incidents = engine.incidents(since, 500)
    .filter(i => i.key === `service_down:${s.id}` || i.key.startsWith(`cert_expiry:${s.id}#`))
    .slice(0, 20)
  res.json({ id: s.id, name: s.name, range, bandStart: bands.start, bandSize: bands.size, historySince: history.since(), checks, incidents })
})

// Uptime bars of all probes (24 h: 30-min slots; 7/30/90 d: one-day slots)
app.get('/api/history/bands', (req, res) => {
  res.json(history.bands(rangeOf(req.query.range)))
})

// CPU / RAM curves of a Proxmox node (rrddata)
app.get('/api/rrd/:cluster/:node', wrap(async (req, res) => {
  const tf = ['hour', 'day', 'week', 'month', 'year'].includes(req.query.timeframe) ? req.query.timeframe : 'day'
  try {
    res.json(await sources.rrd(req.params.cluster, req.params.node, tf))
  } catch (e) {
    // 404 unknown node or guest, 502 Proxmox unreachable or in error
    res.status(e.status === 404 ? 404 : 502).json({ error: String(e.message || e) })
  }
}))

// Curves of a guest: CPU, RAM, network, disk — day or week
app.get('/api/rrd/:cluster/guest/:vmid', wrap(async (req, res) => {
  const tf = ['hour', 'day', 'week', 'month'].includes(req.query.timeframe) ? req.query.timeframe : 'day'
  const vmid = Number(req.params.vmid)
  if (!Number.isInteger(vmid) || vmid <= 0) return res.status(400).json({ error: tr('api.bad_vmid') })
  try {
    res.json(await sources.guestRrd(req.params.cluster, vmid, tf))
  } catch (e) {
    // 404 unknown node or guest, 502 Proxmox unreachable or in error
    res.status(e.status === 404 ? 404 : 502).json({ error: String(e.message || e) })
  }
}))

// v1 compatibility: flat list of probes (old "Service status" widget)
app.get('/api/health', (req, res) => {
  res.json(monitor.checks.map(c => {
    const v = checkView(c)
    const svc = cfg.services.find(s => s.id === c.serviceId)
    return {
      name: `${svc.name} · ${v.label}`, url: c.display,
      status: v.state === 'crit' ? 'down' : 'up',
      code: v.code, latencyMs: v.latencyMs, error: v.error ?? undefined,
    }
  }))
})

// Liveness of the process (CI, external monitoring): depends on no source
// version (package.json) and deployed commit (REVISION file at the root of the code, read at
// startup; null if missing or invalid): is production running the intended version?
const REVISION = readRevision(path.join(ROOT, 'REVISION'))
app.get('/api/healthz', (req, res) => {
  res.json({
    ok: true, version: VERSION, commit: REVISION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    checks: monitor.checks.length, completed: monitor.completed,
    alertsEvaluatedAt: engine.lastEvalAt ? new Date(engine.lastEvalAt).toISOString() : null,
    // only in "to be configured" mode (external monitoring sees it); unchanged shape otherwise
    ...(unconfigured ? { unconfigured: true } : {}),
  })
})

// Non-sensitive config for the front end (titles); public: the login screen shows the title
app.get('/api/config', (req, res) => {
  // the instance locale, for the texts and formats of the client
  res.json({ title: cfg.title, subtitle: cfg.subtitle, footer: cfg.footer, locale: cfg.locale })
})

app.all('/api/*', (req, res) => res.status(404).json({ error: tr('api.unknown_route') }))

// Static SPA — index.html never cached (always revalidated), hashed
// assets as immutable. Prevents a browser from keeping an old index.html → old JS.
const dist = path.join(ROOT, 'client', 'dist')
// cache and strict CSP of SVG icons (lib/security-headers.js), after the general CSP
// explicit dotfiles: any path with a dotted segment (dist/.vite/: deployment manifest)
// goes to the next handler (SPA fallback, or 404 under /assets/); without the option, send only hides
// dotted FILES, not folders
// /icons/<slug>.svg|png served from ICONS_DIR (strict CSP for SVGs, one-day cache); any
// other name (sources.json, "..", subfolder), link or missing file → 404 no-store, never the
// application fallback
app.get('/icons/:file', iconRoute(ICONS, { setHeaders: iconHeaders, fallback: missingAsset }))
app.use('/icons', missingAsset)
app.use(express.static(dist, { setHeaders: staticHeaders, dotfiles: 'ignore' }))
// a missing asset answers 404 no-store, not the application fallback
app.use('/assets', missingAsset)
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(dist, 'index.html'))
})

// final handler, JSON without stack nor path (malformed JSON → 400,
// body too large → 413, the rest → 500 logged)
app.use(errorHandler(console))

// port actually opened in the log (PORT=0 in tests; identical otherwise). Listening
// address always explicit: non-empty LISTEN_HOST, otherwise listenHost of the config, otherwise 127.0.0.1
// (lib/security.js); "::" = all interfaces in dual stack, like app.listen(PORT) without a
// host. Never HOST: some environments export it with the machine name
const listening = () => console.log(`vigie listening on :${server.address().port}`)
const server = app.listen(PORT, security.listenHost.value, listening)

// clean shutdown: the SQLite database is closed (WAL flushed) before exiting. Each stop()
// is guarded (lib/shutdown.js): an error is logged, the database is closed anyway
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdown({
      // bot, then running network reading finished, then Pi-hole sessions closed (2 s max in total)
      steps: [['bot', () => bot.stop()], ...host.stopSteps(), ['sessions Pi-hole', () => piholes.stop()]],
      // pending refusal summaries written before the database is closed
      finalize: [() => audit.flush(), () => store.db.close()],
      log: console,
    }).finally(() => process.exit(0))
  })
}

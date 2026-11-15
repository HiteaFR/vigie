// Host of modules and plugins. A MODULE carries optional hooks; the core loops over the
// list of modules instead of hand-written calls (index.js, collector, rules, digest,
// summary, refresh, cleanup, shutdown). Two kinds of modules:
//   - core modules (network, updates): registered by index.js with moduleOf();
//   - internal plugins (server/plugins/, static list, no external
//     loading): definePlugin({ id, apiVersion: 0, configSchema?, configured?, setup(ctx) }), where
//     setup returns the hooks.
//
// Hooks of a module (all optional):
//   collect: { <name>: { periodSec, fn, configured? } }  sources read by the shared collector
//                                                       (snapshot snap[<name>], error kept)
//   signals(snap, now, { parentsOf })   → alert signals (same shape as rules.js)
//   digest: { slot: 'ci' | 'end', lines({ mark, now }) → lines }
//   summary: { key, value({ env, now }) }               key of /api/summary
//   routes(router, helpers)                             express.Router mounted by the host
//   rules: [<rule type>, …]                             rule types emitted (mandatory with signals)
//   signalsAt: 'ci' | 'end'                             place of the signals among the core ones (default
//                                                       end; ci: just before the agent ones, where the
//                                                       CI rules used to be): order of application
//                                                       and of notifications unchanged
//   routesAt: 'sources' | 'modules'                     place of the routes (default modules; sources:
//                                                       with the source read routes, { wrap }
//                                                       helper only)
//   components() → items of the updates page (shape of lib/updates: id, name, kind, current, latest…)
//   invalidate()                                        clear the caches before a "Refresh"
//   status() → { configured }                          module-specific state (Integrations page:
//                                                       an always-active plugin may report itself not
//                                                       configured, like gitea without GITEA_URL)
//   labels: { <rule>: <label> | { en, fr } }            label of a rule, per locale
//   start(), refresh(), afterRefresh(), purge(), stop()
//
// Key ownership: every signal of a module must be of a rule type it declares (rules) and
// have a "<type>:…" key; a core type (createRules: CORE_RULES) cannot be declared by a
// module, except shared types (source_error); plugin_error is reserved for the host; a key
// already emitted in the same pass (by the core or another module) is refused; source_error:
// a module's key is source_error:<id>, source_error:<id>/… or source_error:<one of its
// collection sources>. Refused signal: dropped, plugin_error raised. A plugin declaring a
// rule type that is still in CORE_RULES (such as ci_failed or runner_offline before they moved
// to the Gitea plugin) is refused at load time (no double emission).
//
// Isolation: a module that throws in signals, digest or summary breaks neither the others
// nor the evaluation (hence the heartbeat). Its last signals are FROZEN (cond: null: neither
// firing nor resolution, the alert is never silently forgotten after FORGET_AFTER),
// a "⚠️ …: unavailable" line takes its place in the digest, its summary key is null, and
// the plugin_error:<id> alert fires; it resolves when every failing hook has succeeded
// again. A collection error stays data (snap[<name>].error), as for the core
// sources: the module's rules decide (no double alert for the same cause). setup or
// start that throws: plugin disabled, plugin_error raised, the rest starts. refresh, purge and
// stop: log only, as for the core modules.
//
// Known limit (see the plugin authoring guide, docs/plugins.md): a SYNCHRONOUS infinite loop
// in a hook blocks the whole process; no isolation is possible within a single process.
// Acceptable with internal, reviewed plugins.
import express from 'express'
import { createHttp } from '../http.js'
import { redact } from '../redact.js'
import { checkExtensions } from './extensions.js'
import fs from 'node:fs'
import { t as tr, createI18n, locale, LOCALES } from '../i18n.js'

export const PLUGIN_API_VERSION = 0
const ID = /^[a-z][a-z0-9-]{0,31}$/
const HOOKS = new Set(['status', 'channel', 'collect', 'signals', 'signalsAt', 'rules', 'digest', 'summary', 'routes', 'routesAt', 'components', 'invalidate', 'labels', 'start', 'refresh', 'afterRefresh', 'purge', 'stop'])
const ROUTE_SLOTS = new Set(['sources', 'modules'])
const SLOTS = new Set(['ci', 'end'])
const ERROR_MAX = 200
const PLUGIN_ERROR_FOR_SEC = 60
// timeout of a send through a plugin's channel
export const CHANNEL_TIMEOUT_MS = 30_000
// rule types a module may declare even if they also belong to the core (distinct keys)
export const SHARED_RULES = Object.freeze(['source_error'])
const RESERVED_RULES = new Set(['plugin_error'])
const RULE = /^[a-z][a-z0-9_]{0,47}$/
// timeout of a module source: default min(periodSec, 60) s, bounded to 1 s .. periodSec
export const collectTimeoutSec = c => Math.min(Math.max(Number.isInteger(c.timeoutSec) ? c.timeoutSec : Math.min(c.periodSec, 60), 1), c.periodSec)

export class PluginError extends Error {}

// short error message, without stack or line break, secrets masked BEFORE truncation (lib/redact.js:
// values of the secrets declared by the plugin, URL credentials, parameters, headers, tokens); it
// goes out through /api/plugins, the detail of plugin_error (/api/alerts, digest, Telegram) and the log
const brief = (e, secrets = []) => redact(String(e?.message || e || tr('errors.generic')).replace(/\s+/g, ' '), secrets).slice(0, ERROR_MAX)

export function definePlugin(def) {
  if (!def || typeof def !== 'object') throw new PluginError('plugin: object expected')
  if (!ID.test(String(def.id))) throw new PluginError(`plugin: invalid id (${String(def.id).slice(0, 40)}): ^[a-z][a-z0-9-]{0,31}$`)
  if (def.apiVersion !== PLUGIN_API_VERSION) throw new PluginError(`plugin ${def.id}: apiVersion ${def.apiVersion} not supported (this host: ${PLUGIN_API_VERSION})`)
  if (typeof def.setup !== 'function') throw new PluginError(`plugin ${def.id}: setup(ctx) expected`)
  if (def.configSchema != null && typeof def.configSchema.safeParse !== 'function') throw new PluginError(`plugin ${def.id}: configSchema must be a zod schema`)
  // plugin catalog (optional): { <locale>: { <key>: text | { one, other } } }
  if (def.locales != null && (typeof def.locales !== 'object' || Object.entries(def.locales).some(([l, c]) => !LOCALES.includes(l) || !c || typeof c !== 'object'))) {
    throw new PluginError(`plugin ${def.id}: locales: { ${LOCALES.join(', ')} } of catalogues expected`)
  }
  // declared extensions (probe types…), registered before the config (lib/plugins/extensions.js)
  checkExtensions(def.id, def.extensions)
  return Object.freeze({ ...def, kind: 'plugin' })
}

// a plugin's catalog, stored next to it (server/plugins/<id>/locales/<locale>.json);
// missing file: empty catalog for that locale. Usage: definePlugin({ …, locales:
// pluginLocales(import.meta.url) }); the plugin translates with ctx.t(key, params)
export function pluginLocales(url) {
  const out = {}
  for (const l of LOCALES) {
    const file = new URL(`./locales/${l}.json`, url)
    if (fs.existsSync(file)) out[l] = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  return out
}

// label of a rule (labels hook): a string, or { en, fr } read in the instance locale
// (fallback: en, then the first value)
export const labelIn = v => (typeof v === 'string' ? v : v?.[locale()] ?? v?.en ?? Object.values(v ?? {})[0])

// label of a module: string, or function (core modules: from the instance catalog)
const labelOf = m => (typeof m.label === 'function' ? m.label() : m.label)

// core module: same hooks, without setup
export function moduleOf(id, hooks, { label = id } = {}) {
  checkHooks(id, hooks)
  return Object.freeze({ id, label, kind: 'core', hooks })
}

function checkHooks(id, hooks) {
  for (const k of Object.keys(hooks)) if (!HOOKS.has(k)) throw new PluginError(`module ${id}: unknown hook "${k}"`)
  if (hooks.digest && !SLOTS.has(hooks.digest.slot)) throw new PluginError(`module ${id}: unknown digest slot "${hooks.digest.slot}" (ci, end)`)
  if (hooks.signalsAt != null && !SLOTS.has(hooks.signalsAt)) throw new PluginError(`module ${id}: unknown signals slot "${hooks.signalsAt}" (ci, end)`)
  if (hooks.routesAt != null && !ROUTE_SLOTS.has(hooks.routesAt)) throw new PluginError(`module ${id}: unknown routes slot "${hooks.routesAt}" (sources, modules)`)
  for (const [name, c] of Object.entries(hooks.collect ?? {})) {
    if (!ID.test(name)) throw new PluginError(`module ${id}: invalid source name "${name}"`)
    if (!(Number.isInteger(c?.periodSec) && c.periodSec >= 10) || typeof c.fn !== 'function') throw new PluginError(`module ${id}: source ${name}: periodSec (>= 10) and fn expected`)
    if (c.timeoutSec != null && !(Number.isInteger(c.timeoutSec) && c.timeoutSec >= 1)) throw new PluginError(`module ${id} : source ${name} : timeoutSec entier >= 1`)
  }
  for (const [r, v] of Object.entries(hooks.labels ?? {})) {
    const ok = typeof v === 'string' || (v && typeof v === 'object' && Object.keys(v).length > 0 && Object.entries(v).every(([l, x]) => LOCALES.includes(l) && typeof x === 'string'))
    if (!ok) throw new PluginError(`module ${id}: label of rule ${r}: string or { ${LOCALES.join(', ')} } expected`)
  }
  if (hooks.signals && !Array.isArray(hooks.rules)) throw new PluginError(`module ${id}: rules (emitted rule types) expected with signals`)
  for (const r of hooks.rules ?? []) {
    if (!RULE.test(String(r))) throw new PluginError(`module ${id}: invalid rule type "${String(r).slice(0, 48)}"`)
    if (RESERVED_RULES.has(r)) throw new PluginError(`module ${id}: rule type ${r} reserved for the host`)
  }
}

// config block of a plugin: plugins.<id>, or a declared legacy root key (configKeys)
function pluginConfig(def, cfg) {
  const keys = def.configKeys ?? [`plugins.${def.id}`]
  for (const k of keys) {
    const v = k.startsWith('plugins.') ? cfg.plugins?.[k.slice(8)] : cfg[k]
    if (v !== undefined) return { key: k, value: v }
  }
  return { key: null, value: undefined }
}

// validation of the plugins.<id> blocks (check-config and startup): block of an unknown plugin refused
export function validatePluginConfig(cfg, plugins) {
  const errors = []
  const known = new Set(plugins.map(p => p.id))
  for (const id of Object.keys(cfg.plugins ?? {})) if (!known.has(id)) errors.push(`plugins.${id}: unknown plugin (known: ${[...known].join(', ') || 'none'})`)
  for (const def of plugins) {
    // a single block: plugins.<id> OR a legacy key, never both
    const present = (def.configKeys ?? [`plugins.${def.id}`]).filter(k => (k.startsWith('plugins.') ? cfg.plugins?.[k.slice(8)] : cfg[k]) !== undefined)
    if (present.length > 1) errors.push(`${present.join(' and ')}: a single block for plugin ${def.id} (keep ${present[0]})`)
    const { key, value } = pluginConfig(def, cfg)
    if (value === undefined || !def.configSchema) continue
    const r = def.configSchema.safeParse(value)
    if (!r.success) for (const i of r.error.issues) errors.push(`${key}${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`)
  }
  return errors
}

// coreRules: core rule types (createRules, CORE_RULES), which no module may declare
// (except SHARED_RULES); http: client for plugins (secret by default, lib/http.js)
// reservedRules: { <core module id>: [types] }, reserved before plugins are loaded
// (the core module, added later by addModule, takes them back)
// channelTimeoutMs: timeout of a send through a plugin's channel (tests; CHANNEL_TIMEOUT_MS by default)
// extensionErrors: Map(id → message) of refused extensions (registerExtensions), as plugin_error
// reservedIds: ids forbidden to plugins (RESERVED_PLUGIN_IDS: core sources and modules); a
// plugin using one is refused at load time: no id taken, no hook, plugin_error:refused/<id>
export function createHost({ cfg, env = {}, store = null, log = console, now = () => Date.now(), http = createHttp({ defaultSecret: true }), modules = [], plugins = [], coreRules = [], reservedRules = {}, reservedIds = [], extensionErrors = new Map(), channelTimeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  const core = new Set(coreRules)
  const ownedBy = new Map() // rule type → id of the module that declares it
  for (const [id, types] of Object.entries(reservedRules)) for (const r of types) if (!SHARED_RULES.includes(r)) ownedBy.set(r, id)
  const ids = new Set()
  const list = [] // { id, label, kind, hooks, configured }
  const errors = new Map() // id → Map(hook → { message, at })
  const lastSignals = new Map() // id → last successful signals
  const reserved = new Set(reservedIds)
  const refused = [] // plugins refused at load time (reserved id): { id, label, message, at }

  // values of the secrets declared by each plugin (def.secrets, read from env): masked in its messages
  const secretValues = new Map(plugins.map(def => [def.id, (def.secrets ?? []).map(n => env[n]).filter(v => typeof v === 'string')]))
  const fail = (id, hook, e) => {
    const message = brief(e, secretValues.get(id))
    if (!errors.has(id)) errors.set(id, new Map())
    errors.get(id).set(hook, { message, at: now() })
    log.error(`[${id}] ${hook}: ${message}`)
  }
  const ok = (id, hook) => errors.get(id)?.delete(hook)

  // declared types: never a core type (unless shared), never two modules for the same type
  function claim(entry) {
    for (const r of entry.hooks.rules ?? []) {
      if (SHARED_RULES.includes(r)) continue
      if (core.has(r)) throw new PluginError(`rule type ${r} already emitted by the core`)
      if (ownedBy.has(r) && ownedBy.get(r) !== entry.id) throw new PluginError(`rule type ${r} already declared by ${ownedBy.get(r)}${reservedRules[ownedBy.get(r)] ? ' (core module)' : ''}`)
    }
    for (const r of entry.hooks.rules ?? []) if (!SHARED_RULES.includes(r)) ownedBy.set(r, entry.id)
  }
  function add(entry) {
    if (ids.has(entry.id)) throw new PluginError(`module ${entry.id}: duplicate id`)
    ids.add(entry.id)
    // core modules first, then plugins (order of signals and digest lines)
    if (entry.kind === 'core') list.splice(list.filter(m => m.kind === 'core').length, 0, entry)
    else list.push(entry)
  }

  for (const m of modules) {
    claim(m)
    add({ ...m, configured: true })
  }
  let started = false
  for (const def of plugins) {
    if (reserved.has(def.id)) {
      const message = tr('plugins.err.reserved', { id: def.id })
      refused.push({ id: def.id, label: def.label ?? def.id, message, at: now() })
      log.error(`[${def.id}] load: ${message}`)
      continue
    }
    const { key: configKey, value } = pluginConfig(def, cfg)
    const parsed = def.configSchema && value !== undefined ? def.configSchema.parse(value) : value
    const configured = def.configured ? !!def.configured(parsed, env) : parsed !== undefined
    const entry = { id: def.id, label: def.label ?? def.id, kind: 'plugin', hooks: {}, configured }
    add(entry)
    // extensions refused at registration (registerExtensions): plugin_error, the rest continues
    if (extensionErrors.has(def.id)) fail(def.id, 'extensions', new PluginError(extensionErrors.get(def.id)))
    if (!configured) continue
    try {
      const kv = store ? { get: k => store.kv.get(`plugin.${def.id}.${k}`), set: (k, v) => store.kv.set(`plugin.${def.id}.${k}`, v) } : null
      const ctx = Object.freeze({
        // configKey: key read (plugins.<id>, or a legacy key declared in configKeys), null without a block
        id: def.id, config: parsed, configKey, now, http, kv,
        // translation through the plugin's catalog (def.locales), in the instance locale
        t: createI18n({ catalogs: def.locales ?? {} }),
        // a text in each locale of its catalog: { fr, en } (labels hook)
        tAll: key => Object.fromEntries(LOCALES.filter(l => def.locales?.[l]?.[key] != null).map(l => [l, createI18n({ catalogs: def.locales, getLocale: () => l })(key)])),
        log: { log: (...a) => log.log(`[${def.id}]`, ...a), warn: (...a) => log.warn(`[${def.id}]`, ...a), error: (...a) => log.error(`[${def.id}]`, ...a) },
        // declared secrets only (def.secrets), read from the process environment
        secret: name => ((def.secrets ?? []).includes(name) ? env[name] ?? null : null),
      })
      const hooks = def.setup(ctx) ?? {}
      checkHooks(def.id, hooks)
      claim({ id: def.id, hooks })
      entry.hooks = hooks
    } catch (e) {
      entry.hooks = {}
      entry.configured = false
      fail(def.id, 'setup', e)
    }
  }
  // disabling a plugin after an error (routes, start): no hook is called any more
  const disable = m => {
    if (m.kind === 'plugin') m.configured = false
  }

  const active = () => list.filter(m => m.configured)
  const display = m => tr(m.kind === 'plugin' ? 'plugins.kind.plugin' : 'plugins.kind.module', { label: labelOf(m) })

  return {
    get ids() { return list.map(m => m.id) },
    // core module created after the host (it depends on the collector, which depends on the
    // plugins' sources): added before start(), without a collection source
    addModule(m) {
      if (started) throw new PluginError(`module ${m.id}: added after startup`)
      if (m.hooks.collect) throw new PluginError(`module ${m.id}: added after the collector, without a collected source`)
      claim(m)
      add({ ...m, configured: true })
    },
    list: () => [
      ...list.map(m => ({ id: m.id, label: labelOf(m), kind: m.kind, configured: m.configured, errors: Object.fromEntries(errors.get(m.id) ?? []) })),
      ...refused.map(r => ({ id: r.id, label: r.label, kind: 'plugin', configured: false, refused: true, errors: { load: { message: r.message, at: r.at } } })),
    ],

    // host state for the Integrations page (/api/plugins): no secret, no config; state
    // "error" (a failing hook, with its short message and date; plugin refused at load time:
    // load hook), "not configured" (plugin without a block or that reports itself not configured
    // through status()), otherwise "active"
    view() {
      return {
        apiVersion: PLUGIN_API_VERSION,
        modules: list.map(m => {
          let configured = m.configured
          if (configured && typeof m.hooks.status === 'function') {
            try {
              configured = m.hooks.status()?.configured !== false
            } catch {
              configured = true
            }
          }
          const errs = [...(errors.get(m.id) ?? [])].map(([hook, e]) => ({ hook, message: e.message, at: new Date(e.at).toISOString() }))
          return { id: m.id, label: labelOf(m), kind: m.kind, state: errs.length ? 'error' : configured ? 'active' : 'unconfigured', errors: errs }
        }).concat(
          // plugins refused at load time (id reserved for the core): in error, "load" hook
          refused.map(r => ({ id: r.id, label: r.label, kind: 'plugin', state: 'error', errors: [{ hook: 'load', message: r.message, at: new Date(r.at).toISOString() }] })),
        ),
      }
    },

    // module sources for the shared collector: { name, periodSec, fn, configured }
    collectors() {
      const out = []
      for (const m of list) {
        for (const [name, c] of Object.entries(m.hooks.collect ?? {})) {
          // a plugin disabled afterwards (routes, start) is no longer read
          const fn = () => (m.configured ? c.fn() : Promise.reject(new Error(tr('plugins.disabled'))))
          out.push({ name, periodSec: c.periodSec, timeoutSec: collectTimeoutSec(c), fn, configured: m.configured && c.configured !== false, module: m.id })
        }
      }
      return out
    },

    // rule labels of the modules (refuses to overwrite an existing label)
    labels(base = {}) {
      const out = {}
      for (const m of list) {
        for (const [rule, raw] of Object.entries(m.hooks.labels ?? {})) {
          const label = labelIn(raw)
          if (base[rule] && base[rule] !== label) throw new PluginError(`module ${m.id}: label of rule ${rule} already defined`)
          out[rule] = label
        }
      }
      return out
    },

    // module signals by slot: { ci, end } (plugin_error in end); helpers.taken: keys
    // already emitted in this pass (by the core), refused to modules
    evaluate(snap, t, { taken = new Set(), ...helpers } = {}) {
      const out = { ci: [], end: [] }
      const seen = new Set(taken)
      for (const m of active()) {
        if (typeof m.hooks.signals !== 'function') continue
        const slot = out[m.hooks.signalsAt ?? 'end']
        try {
          const s = m.hooks.signals(snap, t, helpers)
          if (!Array.isArray(s)) throw new PluginError(tr('plugins.err.signals_array'))
          const own = new Set(m.hooks.rules ?? [])
          const sources = new Set(Object.keys(m.hooks.collect ?? {}))
          const accepted = []
          const refused = []
          for (const x of s) {
            const key = String(x?.key ?? '')
            const sub = key.slice(String(x?.rule).length + 1)
            const why = !own.has(x?.rule) ? tr('plugins.err.undeclared', { type: String(x?.rule).slice(0, 48) })
              : !key.startsWith(`${x.rule}:`) ? tr('plugins.err.outside_type', { type: x.rule })
                : x.rule === 'source_error' && !(sub === m.id || sub.startsWith(`${m.id}/`) || sources.has(sub)) ? tr('plugins.err.source_outside', { id: m.id })
                  : seen.has(key) ? tr('plugins.err.already_emitted') : null
            if (why) refused.push(`${key.slice(0, 80)} (${why})`)
            else {
              seen.add(key)
              accepted.push(x)
            }
          }
          lastSignals.set(m.id, accepted)
          slot.push(...accepted)
          if (refused.length) fail(m.id, 'signals', new PluginError(tr('plugins.err.signal_refused', { list: `${refused.slice(0, 3).join(', ')}${refused.length > 3 ? ` (+${refused.length - 3})` : ''}` })))
          else ok(m.id, 'signals')
        } catch (e) {
          fail(m.id, 'signals', e)
          // freeze: last known signals, without condition (neither firing nor resolution)
          slot.push(...(lastSignals.get(m.id) ?? []).filter(s => !seen.has(s.key)).map(s => (seen.add(s.key), { ...s, cond: null })))
        }
      }
      // one alert per module: raised while a hook is failing
      for (const m of list) {
        const errs = [...(errors.get(m.id) ?? [])]
        out.end.push({
          key: `plugin_error:${m.id}`, rule: 'plugin_error', entity: m.id, title: tr('plugins.error_title', { name: display(m) }), env: 'prod',
          cond: errs.length > 0, forSec: PLUGIN_ERROR_FOR_SEC, severity: 'warning',
          detail: errs.length ? errs.map(([hook, e]) => tr('plugins.hook_error', { hook, message: e.message })).join(' · ') : null,
          link: '/alerts', parents: [],
        })
      }
      // plugins refused at load time (reserved id): raised while they are in the list; separate key
      // ("refused/", outside the id format): never the one of the core module with the same name
      for (const r of refused) {
        out.end.push({
          key: `plugin_error:refused/${r.id}`, rule: 'plugin_error', entity: `refused/${r.id}`, title: tr('plugins.refused_title', { label: r.label }), env: 'prod',
          cond: true, forSec: PLUGIN_ERROR_FOR_SEC, severity: 'warning', detail: tr('plugins.refused_detail', { message: r.message }),
          link: '/alerts', parents: [],
        })
      }
      return out
    },
    // all module signals, ci slot then end
    signals(snap, t, helpers = {}) {
      const r = this.evaluate(snap, t, helpers)
      return [...r.ci, ...r.end]
    },

    // module items for the updates page (lib/updates); error: no item, plugin_error
    // notification channels of the plugins (channel hook), for the notifier. Hook:
    // { label?, send(list) (items: id, key, kind, severity, silent, text HTML, plain, incidentId,
    // createdAt), accepts?(item), maxBatch?, maxLen? }; an error with permanent: true is not
    // retried, retryAfter (s) sets the next attempt. Isolation: bounded send (CHANNEL_TIMEOUT_MS),
    // masked message (plugin's declared secrets, lib/redact.js); the failure stays channel data
    // (queue, retry, channel_error alert), not a plugin_error
    channels() {
      const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(Math.max(v, lo), hi) : d)
      return active().filter(m => m.kind === 'plugin' && m.hooks.channel && typeof m.hooks.channel.send === 'function').map(m => {
        const c = m.hooks.channel
        return {
          id: m.id,
          label: c.label ?? labelOf(m),
          configured: true,
          limits: { maxBatch: clamp(c.maxBatch, 1, 12, 12), maxLen: clamp(c.maxLen, 200, 3800, 3800) },
          accepts: typeof c.accepts === 'function' ? row => c.accepts(row) : null,
          async send(list) {
            let timer
            const deadline = new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error(tr('errors.timeout'))), channelTimeoutMs)
            })
            try {
              await Promise.race([Promise.resolve().then(() => c.send(list)), deadline])
            } catch (e) {
              const err = new Error(redact(String(e?.message || e).replace(/\s+/g, ' '), secretValues.get(m.id)).slice(0, ERROR_MAX))
              err.permanent = !!e?.permanent
              // capped at 15 min (like the notifier, RETRY_AFTER_MAX_SEC)
              err.retryAfter = Number.isFinite(e?.retryAfter) && e.retryAfter > 0 ? Math.min(e.retryAfter, 900) : null
              throw err
            } finally {
              clearTimeout(timer)
            }
          },
          classify: e => ({ permanent: !!e?.permanent, retryAfter: e?.retryAfter ?? null }),
        }
      })
    },

    components() {
      const out = []
      for (const m of active()) {
        if (typeof m.hooks.components !== 'function') continue
        try {
          const c = m.hooks.components()
          if (!Array.isArray(c)) throw new PluginError(tr('plugins.err.components_array'))
          ok(m.id, 'components')
          out.push(...c)
        } catch (e) {
          fail(m.id, 'components', e)
        }
      }
      return out
    },

    // module caches cleared before a "Refresh" (log only on error)
    invalidate() {
      for (const m of active()) {
        if (typeof m.hooks.invalidate !== 'function') continue
        try {
          m.hooks.invalidate()
        } catch (e) {
          log.error(`[${m.id}] invalidate: ${brief(e, secretValues.get(m.id))}`)
        }
      }
    },

    digestLines(slot, opts) {
      const out = []
      for (const m of active()) {
        if (m.hooks.digest?.slot !== slot) continue
        try {
          const l = m.hooks.digest.lines(opts)
          if (!Array.isArray(l)) throw new PluginError(tr('plugins.err.digest_array'))
          ok(m.id, 'digest')
          out.push(...l)
        } catch (e) {
          fail(m.id, 'digest', e)
          out.push(tr('plugins.unavailable', { label: labelOf(m) }))
        }
      }
      return out
    },

    summaries(opts) {
      const out = {}
      for (const m of active()) {
        if (!m.hooks.summary) continue
        try {
          const v = m.hooks.summary.value(opts)
          if (typeof v?.then === 'function') {
            Promise.resolve(v).catch(() => {})
            throw new PluginError(tr('plugins.err.summary_promise'))
          }
          out[m.hooks.summary.key] = v
          ok(m.id, 'summary')
        } catch (e) {
          fail(m.id, 'summary', e)
          out[m.hooks.summary.key] = null
        }
      }
      return out
    },

    // routes: one express.Router per module, mounted where the host is called (before
    // the /api/* catch-all); a route error goes through the final handler (500 JSON)
    mount(app, helpers, slot = 'modules') {
      for (const m of active()) {
        if (typeof m.hooks.routes !== 'function' || (m.hooks.routesAt ?? 'modules') !== slot) continue
        const router = express.Router()
        try {
          m.hooks.routes(router, helpers)
        } catch (e) {
          // router never mounted (no half-registered route); startup continues
          fail(m.id, 'routes', e)
          disable(m)
          continue
        }
        app.use(router)
      }
    },

    start() {
      started = true
      for (const m of active()) {
        if (typeof m.hooks.start !== 'function') continue
        const onError = e => {
          fail(m.id, 'start', e)
          disable(m)
        }
        try {
          const r = m.hooks.start()
          // asynchronous start: a rejection counts as an exception
          if (typeof r?.then === 'function') Promise.resolve(r).catch(onError)
        } catch (e) {
          onError(e)
        }
      }
    },

    // refresh: refresh in parallel with the other collections, then afterRefresh (after the
    // collector); log only on error
    refresh: () => active().filter(m => typeof m.hooks.refresh === 'function').map(m => Promise.resolve().then(() => m.hooks.refresh())),
    async afterRefresh() {
      for (const m of active()) {
        if (typeof m.hooks.afterRefresh !== 'function') continue
        await Promise.resolve().then(() => m.hooks.afterRefresh()).catch(e => log.error(`refresh: ${m.id}: ${e.message}`))
      }
    },

    purge() {
      for (const m of active()) {
        if (typeof m.hooks.purge !== 'function') continue
        try {
          m.hooks.purge()
        } catch (e) {
          log.error(`[${m.id}] purge: ${brief(e, secretValues.get(m.id))}`)
        }
      }
    },

    // shutdown steps [label, fn] for lib/shutdown.js
    stopSteps: () => active().filter(m => typeof m.hooks.stop === 'function').map(m => [labelOf(m), () => m.hooks.stop()]),
  }
}

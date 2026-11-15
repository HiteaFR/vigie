// extensions declared by plugins, registered in the registries (lib/registry.js) BEFORE the
// config is read: the config builds its unions from the registries, so a plugin's probe type
// must be known when config.json is validated. Static declaration, on the plugin definition
// (definePlugin({ extensions })), not in setup(ctx): setup runs after the config.
//
//   extensions.probes.<type> = { fields, run(check, { timeoutMs, now }), describe(check), intervalSec? }
//     fields: zod shape of its own fields (type, label and interval are added by the host)
//   extensions.widgetAuths.<type> = { fields, headers?(auth, { secret, url }), query?(auth, { secret }) }
//     at least one of the two; fields: its own fields (type added); secret(name) reads the environment
//   extensions.widgetFormats.<name> = { numeric, format(value) → text }
//   extensions.latestSources.<name> = { fields, latest(src, { current, upstream, releases, pick }), label?(src) }
//   extensions.currentSources.<name> = { fields, current(src, { hostId, agents, upstream, secretHeaders, pick }) }
//     fields: its own fields (from added); see lib/updates/source-types.js
//   extensions.serviceDefs = { attribution, defs }: service definitions for the network probe, in
//     the format of the shipped file (lib/network/probe.js, docs/network.md); validated here; an id already
//     defined is dropped when the probe loads (log, status), the rest continues
//
// A plugin with a refused extension (name taken, invalid shape) registers none of them: all or
// nothing; the error goes to the host (plugin_error:<id>, extensions hook) and to check-config (warning).
import { z } from 'zod'
import { duration } from '../config-types.js'
import { probeTypes, widgetAuths, widgetFormats, latestSources, currentSources, serviceDefSets, RegistryError } from '../registry.js'
import { parseDefs } from '../network/probe.js'
import { PluginError } from './host.js'

export const EXTENSION_KINDS = Object.freeze(['probes', 'widgetAuths', 'widgetFormats', 'latestSources', 'currentSources', 'serviceDefs'])
const RESERVED_PROBE_FIELDS = new Set(['type', 'label', 'interval'])

// shape check at definition time (definePlugin): known keys, functions present
export function checkExtensions(id, ext) {
  if (ext == null) return
  if (typeof ext !== 'object') throw new PluginError(`plugin ${id}: extensions must be an object`)
  for (const k of Object.keys(ext)) if (!EXTENSION_KINDS.includes(k)) throw new PluginError(`plugin ${id}: unknown extension "${k}" (${EXTENSION_KINDS.join(', ')})`)
  for (const [name, p] of Object.entries(ext.probes ?? {})) {
    if (!p || typeof p.run !== 'function' || typeof p.describe !== 'function') throw new PluginError(`plugin ${id}: probe ${name}: run and describe expected`)
    if (p.fields == null || typeof p.fields !== 'object') throw new PluginError(`plugin ${id}: probe ${name}: fields (zod shape) expected`)
    for (const f of Object.keys(p.fields)) if (RESERVED_PROBE_FIELDS.has(f)) throw new PluginError(`plugin ${id}: probe ${name}: field ${f} reserved`)
    if (p.intervalSec != null && !(Number.isInteger(p.intervalSec) && p.intervalSec >= 10)) throw new PluginError(`plugin ${id}: probe ${name}: intervalSec integer >= 10`)
  }
  for (const [name, a] of Object.entries(ext.widgetAuths ?? {})) {
    if (!a || (typeof a.headers !== 'function' && typeof a.query !== 'function')) throw new PluginError(`plugin ${id}: auth ${name}: headers or query expected`)
    if (a.fields == null || typeof a.fields !== 'object') throw new PluginError(`plugin ${id}: auth ${name}: fields (zod shape) expected`)
    if (Object.hasOwn(a.fields, 'type')) throw new PluginError(`plugin ${id}: auth ${name}: field type reserved`)
  }
  for (const [name, f] of Object.entries(ext.widgetFormats ?? {})) {
    if (!f || typeof f.format !== 'function' || typeof f.numeric !== 'boolean') throw new PluginError(`plugin ${id}: format ${name}: numeric (boolean) and format expected`)
  }
  for (const [kind, fn, what] of [['latestSources', 'latest', 'latest-version'], ['currentSources', 'current', 'installed-version']]) {
    for (const [name, x] of Object.entries(ext[kind] ?? {})) {
      if (!x || typeof x[fn] !== 'function') throw new PluginError(`plugin ${id}: ${what} source ${name}: ${fn} expected`)
      if (x.fields == null || typeof x.fields !== 'object') throw new PluginError(`plugin ${id}: ${what} source ${name}: fields (zod shape) expected`)
      if (Object.hasOwn(x.fields, 'from')) throw new PluginError(`plugin ${id}: ${what} source ${name}: field from reserved`)
      if (x.label != null && typeof x.label !== 'function') throw new PluginError(`plugin ${id}: ${what} source ${name}: label must be a function`)
    }
  }
  if (ext.serviceDefs != null && (typeof ext.serviceDefs !== 'object' || !Array.isArray(ext.serviceDefs.defs))) throw new PluginError(`plugin ${id}: serviceDefs: { attribution, defs } expected`)
}

// entries of a plugin → [[registry, name, entry]]; each entry carries secretValues, the values of the
// secrets declared by the plugin (def.secrets read from env), masked in its error messages
function entriesOf(def, env) {
  const secretValues = Object.freeze((def.secrets ?? []).map(n => env[n]).filter(v => typeof v === 'string'))
  const out = []
  for (const [name, p] of Object.entries(def.extensions?.probes ?? {})) {
    const schema = z.object({ type: z.literal(name), label: z.string().optional(), interval: duration.optional(), ...p.fields }).strict()
    out.push([probeTypes, name, { secretValues, schema, run: p.run, describe: p.describe, intervalSec: p.intervalSec ?? 60 }])
  }
  for (const [name, a] of Object.entries(def.extensions?.widgetAuths ?? {})) {
    const schema = z.object({ type: z.literal(name), ...a.fields }).strict()
    out.push([widgetAuths, name, { secretValues, schema, ...(a.headers ? { headers: a.headers } : {}), ...(a.query ? { query: a.query } : {}) }])
  }
  for (const [name, f] of Object.entries(def.extensions?.widgetFormats ?? {})) out.push([widgetFormats, name, { secretValues, numeric: f.numeric, format: f.format }])
  for (const [name, x] of Object.entries(def.extensions?.latestSources ?? {})) {
    out.push([latestSources, name, { secretValues, schema: z.object({ from: z.literal(name), ...x.fields }).strict(), latest: x.latest, ...(x.label ? { label: x.label } : {}) }])
  }
  for (const [name, x] of Object.entries(def.extensions?.currentSources ?? {})) {
    out.push([currentSources, name, { secretValues, schema: z.object({ from: z.literal(name), ...x.fields }).strict(), current: x.current }])
  }
  if (def.extensions?.serviceDefs) {
    const r = parseDefs(JSON.stringify(def.extensions.serviceDefs))
    if (!r.ok) throw new PluginError(`serviceDefs : ${r.error}`)
    out.push([serviceDefsAdapter, `plugin ${def.id}`, def.extensions.serviceDefs])
  }
  return out
}

// service definitions form a list (lib/registry.js, serviceDefSets), not names
const serviceDefsAdapter = { add: (source, data, owner) => serviceDefSets.add(source, data, owner), removeOwner: owner => serviceDefSets.removeOwner(owner) }

const done = new Set() // plugins already registered (repeated call has no effect: server, check-config, tests)

// registration of the plugins' extensions → { errors: Map(id → message) }; reservedIds: plugins
// refused by the host (id reserved for the core), of which nothing is registered; env: where to read declared secrets
export function registerExtensions(plugins, { reservedIds = [], env = process.env } = {}) {
  const errors = new Map()
  for (const def of plugins) {
    if (done.has(def.id) || reservedIds.includes(def.id)) continue
    const added = []
    try {
      for (const [registry, name, entry] of entriesOf(def, env)) {
        registry.add(name, entry, def.id)
        added.push(registry)
      }
      done.add(def.id)
    } catch (e) {
      for (const r of added) r.removeOwner(def.id)
      errors.set(def.id, e instanceof RegistryError || e instanceof PluginError ? e.message : `extensions : ${String(e?.message || e)}`)
    }
  }
  return { errors }
}

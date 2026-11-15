// extension registries. Each registry maps a name (probe type, widget authentication
// type, widget format, version source) to its entry: the core registers its own when
// its module loads, plugins register theirs before the config is read
// (lib/plugins/extensions.js, static declarations of definePlugin). The config builds its unions
// from these registries; the core modules look the entry up there instead of a table or a switch.
// Order: registration order (core first), so the validation messages of a config without
// plugins stay the same.
import { z } from 'zod'

const NAME = /^[a-z][a-z0-9-]{0,31}$/

export class RegistryError extends Error {}

export function createRegistry(kind) {
  const entries = new Map()
  return {
    kind,
    // owner: 'core' or the plugin id; refuses an invalid or already taken name (core included)
    add(name, def, owner = 'core') {
      if (!NAME.test(String(name))) throw new RegistryError(`${kind}: invalid name (${String(name).slice(0, 40)})`)
      const cur = entries.get(name)
      if (cur) throw new RegistryError(`${kind} ${name} already declared by ${cur.owner === 'core' ? 'the core' : `plugin ${cur.owner}`}`)
      entries.set(name, Object.freeze({ ...def, name, owner }))
    },
    get: name => entries.get(name) ?? null,
    has: name => entries.has(name),
    names: () => [...entries.keys()],
    list: () => [...entries.values()],
    // tests only: removes the entries of a plugin
    removeOwner(owner) {
      for (const [k, v] of entries) if (v.owner === owner) entries.delete(k)
    },
  }
}

// discriminated union of a registry's schemas (key field, "type" or "from"), recomputed only
// when the registry changes; a single entry: its schema (zod requires two options)
const unions = new WeakMap()
export function unionOf(registry, key = 'type') {
  const names = registry.names().join(' ')
  const hit = unions.get(registry)
  if (hit && hit.names === names && hit.key === key) return hit.schema
  const list = registry.list().map(e => e.schema)
  const schema = list.length === 1 ? list[0] : z.discriminatedUnion(key, list)
  unions.set(registry, { names, key, schema })
  return schema
}

// enumeration of a registry's names (widget formats), recomputed when the registry changes
const enums = new WeakMap()
export function enumOf(registry) {
  const names = registry.names()
  const hit = enums.get(registry)
  if (hit && hit.key === names.join(' ')) return hit.schema
  const schema = z.enum(names)
  enums.set(registry, { key: names.join(' '), schema })
  return schema
}

// v0 registries
export const probeTypes = createRegistry('probe type')
export const widgetAuths = createRegistry('widget auth')
export const widgetFormats = createRegistry('widget format')
export const latestSources = createRegistry('latest-version source')
export const currentSources = createRegistry('installed-version source')

// network probe service definitions provided by plugins (same format as the shipped
// file, lib/network/probe.js): a list, not names; duplicate ids are refused at load time
const defSets = []
export const serviceDefSets = {
  add(source, data, owner) { defSets.push(Object.freeze({ source, data, owner })) },
  list: () => [...defSets],
  removeOwner(owner) {
    for (let i = defSets.length - 1; i >= 0; i--) if (defSets[i].owner === owner) defSets.splice(i, 1)
  },
}

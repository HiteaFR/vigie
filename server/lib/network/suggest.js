// Grouping suggestions, pure functions. They only propose: a MAC family or a merge is only
// applied after validation by a human (POST /api/network/mac-rules or /devices/merge).
import { isGenericName, cleanName, bestAttr, lifeEndOf } from './merge.js'
import { t as tr } from '../i18n.js'

const prefixOf = mac => mac.slice(0, 8)
const eligible = d => d && !d.host_id

// merge key of a record = its DISCOVERED name (best name attribute excluding mdns), cleaned,
// not generic; only failing that, its displayed name, unless it comes from mDNS (no
// discovered name outside mdns, no manual entry). A single key per record: a rename by the
// admin changes neither the group nor the key (a dismissed suggestion stays dismissed)
function mergeKeyName(d, attrs) {
  const found = cleanName(bestAttr((attrs || []).filter(a => a.source !== 'mdns'), 'name')?.value)
  if (found && !isGenericName(found)) return found
  const fromMdns = d.name == null && (attrs || []).some(a => a.attr === 'name' && a.source === 'mdns')
  const shown = fromMdns ? null : cleanName(d.disp_name)
  return shown && !isGenericName(shown) ? shown : null
}
function mergeCandidates(state) {
  const macsBy = new Map()
  for (const m of state.macs.values()) {
    if (!macsBy.has(m.device_id)) macsBy.set(m.device_id, [])
    macsBy.get(m.device_id).push(m)
  }
  const out = []
  for (const d of state.devices.values()) {
    const ms = macsBy.get(d.id) || []
    if (!eligible(d) || !ms.length || !ms.every(m => m.grade === 'weak')) continue
    const name = mergeKeyName(d, state.attrs?.get(d.id))
    if (name) out.push({ d, ms, name })
  }
  return out
}
// lives [first_seen, end] of two records that overlap (same measure as disjoint() in
// merge.js, mode by mode); an unknown period does not make an overlap
const known = x => typeof x === 'number' && Number.isFinite(x)
function overlaps(a, b, seen, arpMode) {
  const life = m => [m.first_seen, lifeEndOf(m, seen, arpMode)]
  for (const ma of a) {
    const [a0, a1] = life(ma)
    if (!known(a0) || !known(a1)) continue
    for (const mb of b) {
      const [b0, b1] = life(mb)
      if (known(b0) && known(b1) && !(a1 < b0 || b1 < a0)) return true
    }
  }
  return false
}
const quote = n => `“${n}”`
const WARNING_TEXT = {
  names: names => tr('net.suggest.names', { names: names.map(quote).join(', ') }),
  overlap: () => tr('net.suggest.overlap'),
}

// family: at least 3 weak MACs, same 3-byte prefix and same DISCOVERED name, on one or more
// records: once merged, the rotating MACs still need to be covered. The discovered name is
// the one the rule compares: an entered name would give a rule that never applies.
// A family already validated is no longer proposed
export function suggestFamilies(state, { dismissed = [] } = {}) {
  const groups = new Map()
  for (const c of mergeCandidates(state)) {
    for (const p of new Set(c.ms.map(m => prefixOf(m.mac)))) {
      const k = `${p}|${c.name.toLowerCase()}`
      if (!groups.has(k)) groups.set(k, { prefix: p, name: c.name, devices: new Map(), macs: 0 })
      const g = groups.get(k)
      if (!g.devices.has(c.d.id)) g.devices.set(c.d.id, c.d)
      g.macs += c.ms.filter(m => prefixOf(m.mac) === p).length
    }
  }
  const skip = new Set(dismissed)
  const validated = g => (state.rules ?? []).some(r => r.action === 'attach' && r.prefix === g.prefix && (r.name ?? '').toLowerCase() === g.name.toLowerCase())
  return [...groups.values()]
    .filter(g => g.macs >= 3 && !validated(g))
    .map(g => ({
      kind: 'family', key: `family:${g.prefix}:${g.name.toLowerCase()}`, prefix: g.prefix, name: g.name, macs: g.macs,
      // first seen first: target proposed by default
      devices: [...g.devices.values()].sort((a, b) => (a.first_seen ?? Infinity) - (b.first_seen ?? Infinity) || a.id - b.id).map(d => d.id),
    }))
    .filter(s => !skip.has(s.key))
}

// merge: at least 2 candidate records with the same name (phone that changed its private
// MAC), outside the families already proposed.
// Grouped by DISCOVERED name; always proposed (nothing is ignored, the admin decides), with
// warnings: different entered names ('names'), overlapping lives ('overlap', measured like
// disjoint(): probe ≠ 'off' → presence from the probe)
export function suggestMerges(state, { dismissed = [], families = suggestFamilies(state), probe = 'off', seen = state.seen ?? new Map() } = {}) {
  // a family with a single record merges nothing: the record stays a candidate for a merge
  const inFamily = new Set(families.filter(f => f.devices.length > 1).flatMap(f => f.devices))
  const arpMode = probe !== 'off'
  const groups = new Map()
  for (const c of mergeCandidates(state)) {
    if (inFamily.has(c.d.id)) continue
    const k = c.name.toLowerCase()
    if (!groups.has(k)) groups.set(k, { name: c.name, list: [] })
    groups.get(k).list.push(c)
  }
  const skip = new Set(dismissed)
  return [...groups.values()].filter(g => g.list.length >= 2)
    .map(g => {
      const list = g.list.sort((a, b) => (a.d.first_seen ?? Infinity) - (b.d.first_seen ?? Infinity) || a.d.id - b.d.id)
      const entered = []
      for (const c of list) {
        const n = cleanName(c.d.name)
        if (n && !entered.some(x => x.toLowerCase() === n.toLowerCase())) entered.push(n)
      }
      const warnings = []
      if (entered.length >= 2) warnings.push({ kind: 'names', names: entered, text: WARNING_TEXT.names(entered) })
      if (list.some((a, i) => list.slice(i + 1).some(b => overlaps(a.ms, b.ms, seen, arpMode)))) warnings.push({ kind: 'overlap', text: WARNING_TEXT.overlap() })
      return {
        kind: 'merge', key: `merge:${g.name.toLowerCase()}`, name: g.name,
        devices: list.map(c => c.d.id),
        ...(warnings.length ? { warnings } : {}),
      }
    })
    .filter(s => !skip.has(s.key))
}

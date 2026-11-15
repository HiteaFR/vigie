// Human writes of the network module, on the model of updates/decisions.js: pure
// validations that throw { status: 400 }, then one transaction per write, a net_events
// event with the author, and an audit line, refusals included. Used identically by the
// routes and by the bot.
//
// Reason: mandatory (3 to 200 characters) for the actions of REASON_REQUIRED; descriptive
// editing takes none (it is still logged). There is no Ignore, Archive or Restore;
// Delete (single and bulk) and the links entered on the map.
import { normalizeMac, matchPrefix } from '../net/mac.js'
import { cleanName, isPending, bestAttr, plain, containerAssociations, agentOnly, liveIdentity, isIdentityMac } from './merge.js'
import { isIpv4, inCidr } from '../net/ip.js'
import { canonicalRef, effectiveParents, findCycle } from './topology.js'
import { probeable, excluded, needsForce } from './probe.js'
import { NET_VERB, NET_TARGET_ALL, netAction, targetDevices } from '../codes.js'
import { detachedDetail } from './events.js'
import { t as tr } from '../i18n.js'

// device types (same keys as client/src/lib/deviceTypes.js)
export const DEVICE_TYPES = ['router', 'switch', 'ap', 'hypervisor', 'server', 'nas', 'computer', 'laptop', 'phone',
  'tablet', 'tv', 'console', 'speaker', 'iot', 'camera', 'printer', 'other']

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

// actions that require a reason: switching an action to "no reason", or the reverse, is done
// here and only here. unwatch: unticking the offline alert of a device whose net_down is in
// progress (which suppresses an alert). delete (destroys), link and unlink (reassign the
// parent on the map)
export const REASON_REQUIRED = new Set(['ack', 'merge', 'detach', 'confirm', 'addRule', 'removeRule', 'dismiss', 'unwatch', 'delete', 'link', 'unlink'])
const LINK_KINDS = ['uplink', 'wifi', 'ethernet', 'other']
const EDIT_KEYS = new Set(['id', 'name', 'type', 'location', 'notes', 'hostId', 'profile', 'expectedIp', 'alertDown', 'alertSeverity', 'reason'])
const PROFILES = ['fixed', 'normal', 'sleepy']
const SEVERITIES = ['info', 'warning', 'critical']

// reason cleaned (control characters removed, surrounding spaces) BEFORE the length check;
// same rule for the UI and the bot
export function validateReason(r) {
  const s = String(r ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length < 3 || s.length > 200) throw bad(tr('api.reason_required'))
  return s
}
// reason of the action: validated if it requires one, ignored otherwise
const reasonFor = (action, r) => (REASON_REQUIRED.has(action) ? validateReason(r) : null)

const validateId = v => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0 || n > 1e10) throw bad(tr('api.net.bad_id'))
  return n
}

export function validateIds(ids, max = 200) {
  if (!Array.isArray(ids) || !ids.length || ids.length > max) throw bad(tr('api.net.bad_ids', { max }))
  return [...new Set(ids.map(validateId))]
}

export function validateMac(s) {
  const mac = normalizeMac(s)
  if (!mac) throw bad(tr('api.net.bad_mac'))
  return mac
}

// prefix of at least 3 bytes, or full MAC ("ae:00:53", "ae:00:53:*")
export function validatePrefix(p) {
  const s = String(p ?? '').trim().toLowerCase().replace(/:\*$/, '')
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){2,5}$/.test(s)) throw bad(tr('api.net.bad_prefix'))
  return s
}

// descriptive entry → net_devices columns; null clears it (discovery takes over again)
export function validateEdit(body, cfg) {
  const extra = Object.keys(body || {}).filter(k => !EDIT_KEYS.has(k))
  if (extra.length) throw bad(tr('api.unknown_field', { field: extra[0].slice(0, 30) }))
  const out = {}
  if ('name' in body) {
    if (body.name == null || body.name === '') out.name = null
    else if (!(out.name = cleanName(body.name))) throw bad(tr('api.net.bad_name'))
  }
  if ('type' in body) {
    if (body.type != null && !DEVICE_TYPES.includes(body.type)) throw bad(tr('api.net.bad_type'))
    out.type = body.type ?? null
  }
  for (const [k, max] of [['location', 64], ['notes', 500]]) {
    if (!(k in body)) continue
    const v = body[k] == null ? '' : String(body[k]).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
    if (v.length > max) throw bad(tr('api.too_long', { field: k, max }))
    out[k] = v || null
  }
  if ('hostId' in body) {
    if (body.hostId != null && !cfg.hosts.some(h => h.id === body.hostId)) throw bad(tr('api.unknown_host'))
    // manual association, or deliberate dissociation (host_id NULL): host_src "user" in both
    // cases, the poll no longer links the record automatically
    out.host_id = body.hostId ?? null
    out.host_src = 'user'
  }
  // presence: profile, expected IP (within a LAN subnet), offline alert
  if ('profile' in body) {
    if (body.profile != null && !PROFILES.includes(body.profile)) throw bad(tr('api.net.bad_profile'))
    out.profile = body.profile ?? null
  }
  if ('expectedIp' in body) {
    const ip = body.expectedIp == null || body.expectedIp === '' ? null : String(body.expectedIp).trim()
    if (ip != null && (!isIpv4(ip) || !cfg.network.subnets.some(s => inCidr(ip, s.cidr)))) throw bad(tr('api.net.bad_expected_ip'))
    out.expected_ip = ip
  }
  if ('alertDown' in body) {
    if (typeof body.alertDown !== 'boolean') throw bad(tr('api.net.bad_alert_down'))
    out.alert_down = body.alertDown ? 1 : 0
  }
  if ('alertSeverity' in body) {
    if (body.alertSeverity != null && !SEVERITIES.includes(body.alertSeverity)) throw bad(tr('api.net.bad_severity'))
    out.alert_severity = body.alertSeverity ?? null
  }
  if (!Object.keys(out).length) throw bad(tr('api.net.nothing'))
  return out
}

// identity MAC: read from the inside (Proxmox, config), never covered by a rule.
// A hypervisor MAC seen ONLY by the agent (container) is not one (predicate shared with
// forbidden() in merge.js); seen: "mac|source" views. ONE single formula, isIdentityMac
// from merge.js (static)
const isIdentity = isIdentityMac

// health: () => ({ pve: { ok, stale, partial, lastOkAt } | null }); by default, unknown state
// (no identity can be deleted as long as the Proxmox state is not provided)
const UNKNOWN_HEALTH = () => ({ pve: { ok: null, stale: true, partial: null, lastOkAt: null } })
// deletion, the only DYNAMIC check (all the others stay on isIdentity, static).
// → null (allowed) or { status, why }. Linked record: refused only if the host is still in
// the config; identity MAC: refused if still reported ('live') or if no conclusion can be
// drawn ('unknown', pve source in error, stale or partial)
export function deletionBlock(d, st, { cfg, now = Date.now(), health = UNKNOWN_HEALTH } = {}) {
  if (d.host_id && (cfg?.hosts ?? []).some(h => h.id === d.host_id)) return { status: 409, why: tr('api.net.linked_host', { host: d.host_id }) }
  const h = typeof health === 'function' ? health() : health
  const states = [...st.macs.values()].filter(m => m.device_id === d.id).map(m => liveIdentity(m, { seen: st.seen, cfg, health: h, now }))
  if (states.includes('live')) return { status: 409, why: tr('api.net.identity_live') }
  if (states.includes('unknown')) return { status: 409, why: tr('api.net.pve_unknown') }
  return null
}

// MAC rule (family): prefix, target and name; refused if it covers an identity or targets a
// linked record
export function validateRule(rule, state) {
  const prefix = validatePrefix(rule?.prefix)
  if (rule?.action !== 'attach') throw bad(tr('api.net.attach_only'))
  const name = rule.name == null || rule.name === '' ? null : cleanName(rule.name)
  if (rule.name && !name) throw bad(tr('api.net.bad_name'))
  const covered = [...state.macs.values()].filter(m => matchPrefix(m.mac, [prefix]))
  if (covered.some(m => isIdentity(m, state.seen))) throw bad(tr('api.net.prefix_identity'))
  // a family requires the DHCP name: a prefix alone (public in the inventory) would be enough for an intruder
  if (!name) throw bad(tr('api.net.family_name'))
  const deviceId = validateId(rule.deviceId)
  const d = state.devices.get(deviceId)
  if (!d) throw bad(tr('api.net.unknown_device'), 404)
  if (d.host_id) throw bad(tr('api.net.target_host'))
  return { prefix, action: 'attach', device_id: deviceId, name }
}

// merge: into ← from; refused if into ∈ from, different hosts, or an identity MAC that
// would change host
export function validateMerge(into, from, state) {
  const target = validateId(into)
  const list = validateIds(from, 50)
  if (list.includes(target)) throw bad(tr('api.net.merge_self'))
  const all = [target, ...list].map(id => state.devices.get(id))
  if (all.some(d => !d)) throw bad(tr('api.net.unknown_device'), 404)
  const hosts = new Set(all.map(d => d.host_id).filter(Boolean))
  if (hosts.size > 1) throw bad(tr('api.net.merge_hosts'))
  const into0 = all[0]
  for (const d of all.slice(1)) {
    const identity = [...state.macs.values()].some(m => m.device_id === d.id && isIdentity(m, state.seen))
    if (identity && (d.host_id ?? null) !== (into0.host_id ?? null)) throw bad(tr('api.net.merge_identity'))
  }
  return { into: target, from: list }
}

// createNetworkWrites: ns (network store), kv, audit; afterWrite: reload of the snapshot,
// then evaluation of the alerts (index.js)
// isFiring(key): alert in progress (engine), to require a reason from whoever suppresses it
// gatewayOf(): gateway of the probe (map: refusal of cycles on the effective parents)
export function createNetworkWrites({ ns, kv, cfg, audit, now = () => Date.now(), afterWrite = () => {}, isFiring = () => false, gatewayOf = () => null, probeRequest = null, probeAllRequest = null, health = UNKNOWN_HEALTH }) {
  // container associations excluding unconfirmed late ones, like the map
  const confirmedContainers = st => {
    let late
    try {
      late = new Set((JSON.parse(kv.get('network.agentLate') || '[]') || []).map(e => e?.device))
    } catch {
      late = new Set()
    }
    return new Map([...containerAssociations(st.attrs).byDevice].filter(([id]) => !late.has(id)))
  }
  // human decision (detach, merge, delete) → identity conflict lifted
  const clearAgentConflicts = ids => {
    let list
    try {
      list = JSON.parse(kv.get('network.agentConflicts') || '[]')
    } catch {
      list = []
    }
    if (!Array.isArray(list)) return
    const next = list.filter(e => !ids.includes(e?.device))
    if (next.length !== list.length) kv.set('network.agentConflicts', JSON.stringify(next))
  }
  const devices = () => ns.load().devices
  const device = id => {
    const d = ns.device(validateId(id))
    if (!d) throw bad(tr('api.net.unknown_device'), 404)
    return d
  }

  // one write: write and audit line in the same transaction (all or nothing); a refusal
  // rolls back the write and is logged separately; then reload
  function exec(verb, target, { by, source }, detail0, fn) {
    const detail = detail0 == null ? null : String(detail0).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    let r
    try {
      r = ns.transaction(() => {
        const res = fn()
        if (res?.audit !== false) audit.log({ actor: by, source, action: netAction(verb), target: typeof target === 'function' ? target(res) : target, detail })
        return res
      })
    } catch (e) {
      audit.log({ actor: by, source, action: netAction(verb), target: typeof target === 'function' ? null : target, detail: String(e.message || e).slice(0, 200), ok: false })
      throw e
    }
    // write done and logged: an error during the reload does not turn it into a refusal
    try {
      afterWrite()
    } catch (e) {
      console.error(`network: after write: ${e.message}`)
    }
    return r
  }
  const ctx = (by, source, extra = {}) => ({ actor: by, ts: now(), ...extra })
  // target of the audit line, readable even for an invalid entry (truncated, unchecked)
  const ref = (kind, v) => `${kind}:${String(v ?? '?').replace(/[\u0000-\u001f]/g, '').slice(0, 40)}`

  return {
    edit(body, who) {
      const keys = Object.keys(body || {}).filter(k => k !== 'id' && k !== 'reason').join(', ')
      const motif = body?.reason == null ? '' : ` · motif : ${String(body.reason).trim().slice(0, 200)}`
      return exec(NET_VERB.EDIT, ref('dev', body?.id), who, `${keys}${motif}`.slice(0, 300), () => {
        const id = validateId(body?.id)
        const fields = validateEdit(body, cfg)
        const d = device(id)
        // unticking the offline alert while it is in progress: reason mandatory
        const unwatch = fields.alert_down === 0 && !!d.alert_down && isFiring(`net_down:${id}`)
        const r = unwatch ? reasonFor('unwatch', body.reason) : null
        if (fields.host_id) {
          const other = [...devices().values()].find(x => x.host_id === fields.host_id && x.id !== id)
          if (other) {
            // explicit message; record name unchecked and bounded to 32 ("…"): the instruction
            // is never cut; safety bound of the message at 260
            const plainName = s => plain(s).trim()
            const hostName = plainName(cfg.hosts.find(h => h.id === fields.host_id)?.name ?? fields.host_id)
            const full = plainName(other.disp_name || other.vendor || other.primary_mac || tr('bot.device_n', { id: other.id }))
            const shown = full.length > 32 ? `${full.slice(0, 31)}…` : full
            const msg = tr('api.net.host_taken', { host: hostName, id: other.id, name: shown })
            throw bad(msg.slice(0, 260), 409)
          }
        }
        const before = Object.fromEntries(Object.keys(fields).map(k => [k, d[k] ?? null]))
        // display up to date right away: manual entry, otherwise best discovered value
        const attrs = ns.load().attrs.get(id) || []
        const shown = {}
        if ('name' in fields) shown.disp_name = fields.name ?? bestAttr(attrs, 'name')?.value ?? null
        if ('type' in fields) shown.disp_type = fields.type ?? bestAttr(attrs, 'type')?.value ?? null
        ns.setState(id, { ...fields, ...shown }, { type: 'edited', detail: JSON.stringify(r ? { ...before, motif: r } : before), ...ctx(who.by) })
        return { id }
      })
    },

    // "Known": new → known, to review → reviewed; already handled: counted, without audit
    ack({ ids, reason } = {}, who) {
      const target = Array.isArray(ids) && ids.length === 1 ? ref('dev', ids[0]) : targetDevices(Array.isArray(ids) ? ids.length : 0)
      return exec(NET_VERB.KNOWN, target, who, String(reason ?? '').trim().slice(0, 200), () => {
        const list = validateIds(ids)
        const r = reasonFor('ack', reason)
        const done = []
        const already = []
        const t = now()
        for (const id of list) {
          const d = device(id)
          if (d.state !== 'new' && !d.review) {
            already.push(id)
            continue
          }
          ns.setState(id, { state: d.state === 'new' ? 'known' : d.state, review: 0, acked_by: who.by, acked_at: t },
            { type: 'acked', detail: r, actor: who.by, ts: t })
          done.push(id)
        }
        return { done, already, audit: done.length > 0 }
      })
    },

    // Delete: batch of 1 to 200, reason mandatory, all or nothing; refusal (409) according
    // to deletionBlock: record linked to a host still in the config, identity MAC still
    // reported or unverifiable; one audit line PER record, within the transaction
    delete({ ids, reason } = {}, who) {
      const target = Array.isArray(ids) && ids.length === 1 ? ref('dev', ids[0]) : targetDevices(Array.isArray(ids) ? ids.length : 0)
      return exec(NET_VERB.DELETE, target, who, String(reason ?? '').trim().slice(0, 200), () => {
        const list = validateIds(ids, 200)
        const r = reasonFor('delete', reason)
        const st = ns.load()
        const missing = list.filter(id => !st.devices.has(id))
        if (missing.length) throw Object.assign(bad(tr('api.net.unknown_devices', { list: missing.slice(0, 10).join(', ') }), 404), { ids: missing })
        const t = now()
        const blocks = list.map(id => [id, deletionBlock(st.devices.get(id), st, { cfg, now: t, health })]).filter(([, b]) => b)
        if (blocks.length) {
          const refused = blocks.map(([id]) => id)
          throw Object.assign(bad(tr('api.net.delete_refused', { why: blocks[0][1].why, count: refused.length, list: refused.slice(0, 20).join(', ') }), blocks[0][1].status), { ids: refused })
        }
        const c = ctx(who.by)
        const macs = []
        clearAgentConflicts(list) // the association goes away with the record (attributes deleted)
        for (const id of list) {
          const res = ns.deleteDevice(id, { actor: who.by, ts: c.ts, reason: r })
          macs.push(...res.macs)
          audit.log({ actor: who.by, source: who.source, action: netAction(NET_VERB.DELETE), target: `dev:${id}`, detail: `${res.summary} — ${r}` })
        }
        return { deleted: list, macs, audit: false }
      })
    },

    // links entered on the map: reassignment of the parent, reason mandatory; refusals:
    // itself (400), unknown node or deleted record (404), active link already present for
    // this child (409), cycle (400)
    link(body = {}, who) {
      return exec(NET_VERB.LINK, ref('link', body?.child), who, `${String(body?.child ?? '').slice(0, 40)} → ${String(body?.parent ?? '').slice(0, 40)} · ${String(body?.reason ?? '').trim().slice(0, 200)}`, () => {
        reasonFor('link', body.reason)
        const extra = Object.keys(body || {}).filter(k => !['child', 'parent', 'kind', 'port', 'note', 'reason'].includes(k))
        if (extra.length) throw bad(tr('api.unknown_field', { field: extra[0].slice(0, 30) }))
        if (!LINK_KINDS.includes(body.kind)) throw bad(tr('api.net.link_kind', { kinds: LINK_KINDS.join(', ') }))
        const clean = (v, max, name) => {
          if (v == null || v === '') return null
          const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
          if (s.length > max) throw bad(tr('api.too_long', { field: name, max }))
          return s || null
        }
        const port = clean(body.port, 32, 'port')
        const note = clean(body.note, 200, 'note')
        const st = ns.load()
        const hostsById = new Map(cfg.hosts.map(h => [h.id, h]))
        const child = body.child === 'internet' ? null : canonicalRef(body.child, { devices: st.devices, hostsById })
        const parent = canonicalRef(body.parent, { devices: st.devices, hostsById })
        if (!child || !parent) throw bad(tr('api.net.unknown_node'), 404)
        if (child === parent) throw bad(tr('api.net.link_self'))
        const active = st.links.filter(l => canonicalRef(l.child, { devices: st.devices, hostsById }) === child)
        if (active.length) throw bad(tr('api.net.link_exists', { id: active[0].id }), 409)
        const { parents } = effectiveParents({ cfg, devices: st.devices, links: st.links, gateway: gatewayOf(), macs: st.macs, containerOf: confirmedContainers(st) })
        if (findCycle(parents, child, parent)) throw bad(tr('api.net.link_cycle'))
        const id = ns.insertLink({ child, parent, kind: body.kind, port, note }, ctx(who.by))
        return { id, child, parent }
      })
    },
    unlink({ id, reason } = {}, who) {
      return exec(NET_VERB.UNLINK, ref('link', id), who, String(reason ?? '').trim().slice(0, 200), () => {
        reasonFor('unlink', reason)
        const n = validateId(id)
        const l = ns.link(n)
        if (!l) throw bad(tr('api.net.unknown_link'), 404)
        if (l.removed_at) throw bad(tr('api.net.link_removed'), 409)
        ns.removeLink(n, ctx(who.by))
        return { id: n }
      })
    },

    merge({ into, from, reason } = {}, who) {
      return exec(NET_VERB.MERGE, ref('dev', into), who, String(reason ?? '').trim().slice(0, 200), () => {
        const r = reasonFor('merge', reason)
        const st = ns.load()
        const v = validateMerge(into, from, st)
        // a single topology link per record: two linked records do not merge (remove one first)
        if ([v.into, ...v.from].filter(id => ns.activeLink(id)).length > 1) throw bad(tr('api.net.merge_links'), 409)
        // the merge carries the container association; a target already associated with
        // ANOTHER identity → 409 (identity conflict, never two identities on one record)
        const assoc = containerAssociations(st.attrs).byDevice
        const keys = new Set([v.into, ...v.from].map(id => assoc.get(id)?.key).filter(Boolean))
        if (keys.size > 1) throw bad(tr('api.net.container_conflict', { list: [...keys].slice(0, 3).map(k => plain(k)).join(', ') }), 409)
        clearAgentConflicts([v.into, ...v.from])
        const target = st.devices.get(v.into)
        const t = now()
        const before = []
        const fill = {}
        let first = target.first_seen
        let last = target.last_seen
        for (const id of v.from) {
          const d = st.devices.get(id)
          const saisie = Object.fromEntries(['name', 'type', 'location', 'notes', 'host_id'].map(k => [k, d[k] ?? null]))
          before.push({ id, macs: [...st.macs.values()].filter(m => m.device_id === id).map(m => m.mac), saisie })
          for (const [k, val] of Object.entries(saisie)) if (val != null && target[k] == null && fill[k] == null) fill[k] = val
          if (d.host_id && !target.host_id) fill.host_src = d.host_src
          if (d.first_seen != null && (first == null || d.first_seen < first)) first = d.first_seen
          if (d.last_seen != null && (last == null || d.last_seen > last)) last = d.last_seen
          ns.mergeDevice(v.into, id, { actor: who.by, ts: t })
        }
        // the association of an absorbed record moves to the target (a "-" removal marker does not prevent it)
        const carried = v.from.map(id => assoc.get(id)?.key).find(Boolean)
        if (carried && assoc.get(v.into)?.key !== carried) ns.applyOps([{ op: 'upsertAttr', device: v.into, attr: 'container', source: 'agent', value: carried, rank: 7, seen_at: t }])
        ns.setState(v.into, { ...fill, first_seen: first, last_seen: last }, { type: 'merged', detail: JSON.stringify({ reason: r, from: before }), actor: who.by, ts: t })
        return { id: v.into, merged: v.from }
      })
    },

    confirmMac({ mac, reason } = {}, who) {
      return exec(NET_VERB.SAME_DEVICE, ref('mac', mac), who, String(reason ?? '').trim().slice(0, 200), () => {
        const m0 = validateMac(mac)
        const r = reasonFor('confirm', reason)
        const st = ns.load()
        const m = st.macs.get(m0)
        if (!m) throw bad(tr('api.net.unknown_mac'), 404)
        if (!isPending(m)) throw bad(tr('api.net.mac_confirmed'), 409)
        const t = now()
        ns.confirmMac(m0, { actor: who.by, ts: t })
        ns.event(m.device_id, 'mac_confirmed', `${m0} : ${r}`, who.by, t)
        // no pending MAC left on the record: it is no longer "to review"
        const others = [...st.macs.values()].filter(x => x.device_id === m.device_id && x.mac !== m0 && isPending(x))
        if (!others.length) ns.setState(m.device_id, { review: 0 }, { actor: who.by, ts: t })
        return { mac: m0, device: m.device_id }
      })
    },

    detachMac({ mac, reason } = {}, who) {
      return exec(NET_VERB.DETACH, ref('mac', mac), who, String(reason ?? '').trim().slice(0, 200), () => {
        const m0 = validateMac(mac)
        const r = reasonFor('detach', reason)
        const st = ns.load()
        const m = st.macs.get(m0)
        if (!m) throw bad(tr('api.net.unknown_mac'), 404)
        if (m.attach === 'detached') throw bad(tr('api.net.mac_detached'), 409)
        if (isIdentity(m, st.seen)) throw bad(tr('api.net.mac_identity'))
        if ([...st.macs.values()].filter(x => x.device_id === m.device_id).length < 2) throw bad(tr('api.net.mac_only'))
        const t = now()
        const id = ns.detachMac(m0, { actor: who.by, ts: t, fields: { first_seen: m.first_seen, last_seen: m.last_seen, last_ip: m.last_ip, primary_mac: m0 } })
        // detaching the MAC from the container REMOVES the record's association (value "-") and
        // lifts the conflict suspension; the next report does not silently re-attach it
        if (agentOnly(m, st.seen) && containerAssociations(st.attrs).byDevice.has(m.device_id)) {
          ns.applyOps([{ op: 'upsertAttr', device: m.device_id, attr: 'container', source: 'agent', value: '-', rank: 7, seen_at: t }])
        }
        clearAgentConflicts([m.device_id, id])
        ns.event(m.device_id, 'mac_detached', detachedDetail(m0, id, r), who.by, t)
        const others = [...st.macs.values()].filter(x => x.device_id === m.device_id && x.mac !== m0 && isPending(x))
        if (!others.length) ns.setState(m.device_id, { review: 0 }, { actor: who.by, ts: t })
        return { mac: m0, from: m.device_id, device: id }
      })
    },

    // MAC rule; with mergeDevices, validation of a suggested family (merge included)
    addRule(body, who) {
      return exec(NET_VERB.MAC_RULE, res => `rule:${res.id}`, who, `${String(body?.action).slice(0, 10)} ${String(body?.prefix).slice(0, 20)} : ${String(body?.reason ?? '').trim().slice(0, 150)}`, () => {
        const r = reasonFor('addRule', body?.reason)
        const st = ns.load()
        const rule = validateRule(body, st)
        const t = now()
        const id = ns.insertRule({ ...rule, reason: r }, { actor: who.by, ts: t })
        const others = (body.mergeDevices || []).map(Number).filter(x => x !== rule.device_id)
        if (rule.action === 'attach' && others.length) {
          const v = validateMerge(rule.device_id, others, st)
          for (const from of v.from) ns.mergeDevice(v.into, from, { actor: who.by, ts: t })
          ns.event(v.into, 'merged', JSON.stringify({ reason: r, rule: id, from: v.from }), who.by, t)
        }
        return { id, ...rule }
      })
    },

    removeRule({ id, reason } = {}, who) {
      return exec(NET_VERB.LIFT_RULE, ref('rule', id), who, String(reason ?? '').trim().slice(0, 200), () => {
        reasonFor('removeRule', reason)
        const n = validateId(id)
        if (!ns.removeRule(n, { actor: who.by, ts: now() })) throw bad(tr('api.net.unknown_rule'), 404)
        return { id: n }
      })
    },

    // on-demand probe; the body accepts NEITHER IP NOR port; exclusion ALWAYS checked again
    // and never forceable; sleepy, iot or camera only with force and a reason
    probe(body = {}, who) {
      const extra = Object.keys(body || {}).filter(k => !['id', 'reason', 'force'].includes(k))
      const force = body?.force === true
      const detail = `${force ? 'force · ' : ''}${String(body?.reason ?? '').trim().slice(0, 200)}`
      return exec(NET_VERB.PROBE, ref('dev', body?.id), who, detail, () => {
        if (extra.length) throw bad(tr('api.net.field_no_ip', { field: extra[0].slice(0, 30) }))
        if (body.force != null && typeof body.force !== 'boolean') throw bad(tr('api.net.bad_force'))
        const id = validateId(body.id)
        if (!probeRequest) throw bad(tr('api.net.probe_unavailable'), 503)
        const st = ns.load()
        const d = st.devices.get(id)
        if (!d) throw bad(tr('api.net.unknown_device'), 404)
        if (d.state !== 'known') throw bad(tr('api.net.probe_unknown'), 409)
        if (excluded(d, cfg)) throw bad(tr('api.net.probe_excluded'), 409)
        if (!probeable(d.last_ip, cfg)) throw bad(tr('api.net.probe_address'), 400)
        if (needsForce(d, st.attrs.get(id) ?? [])) {
          if (!force) throw bad(tr('api.net.probe_force'), 409)
          validateReason(body.reason)
        }
        const r = probeRequest(id)
        if (!r.ok) throw Object.assign(bad(r.error, r.status), { retryAfter: r.retryAfter })
        return { queued: true }
      })
    },

    // "Probe all": the Sunday pass, by hand (admin); optional reason
    probeAll(body = {}, who) {
      const extra = Object.keys(body || {}).filter(k => k !== 'reason')
      return exec(NET_VERB.PROBE_ALL, NET_TARGET_ALL, who, String(body?.reason ?? '').trim().slice(0, 200), () => {
        if (extra.length) throw bad(tr('api.field_refused', { field: extra[0].slice(0, 30) }))
        if (!probeAllRequest) throw bad(tr('api.net.probe_unavailable'), 503)
        const r = probeAllRequest()
        if (!r.ok) throw Object.assign(bad(r.error, r.status), { retryAfter: r.retryAfter })
        return { queued: true, targets: r.targets }
      })
    },

    dismiss({ key, reason } = {}, who) {
      const k = String(key ?? '')
      return exec(NET_VERB.DISMISS, k.slice(0, 120), who, String(reason ?? '').trim().slice(0, 200), () => {
        if (!/^(family|merge):[^\u0000-\u001f\u007f]{1,160}$/.test(k)) throw bad(tr('api.net.bad_suggestion'))
        reasonFor('dismiss', reason)
        const list = JSON.parse(kv.get('network.dismissed') || '[]')
        if (!list.includes(k)) kv.set('network.dismissed', JSON.stringify([...list, k].slice(-500)))
        return { key: k }
      })
    },
  }
}

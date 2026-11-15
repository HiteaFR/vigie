// Codes written to the database: audit (action, target, detail, actor), outbox.dropped,
// host_ports.known_by, kv keys of the network module, and the detail formats of net_events
// (lib/network/events.js builds them from the constants below). They are CODES: display goes
// through the catalogs, never through the stored value.
//
// The codes are in English. Databases written by earlier versions keep French codes, and no row
// is ever rewritten: each LEGACY_* table maps an old code to the current one, and every reader
// goes through the functions of this module, so an old row behaves exactly like a new one. A
// database may therefore be mixed.
import { t as tr } from './i18n.js'

// --- audit.action --------------------------------------------------------------------------------
export const AUDIT = Object.freeze({
  ACK: 'ack',
  UNACK: 'unack',
  SILENCE: 'silence',
  SILENCE_END: 'silence end',
  REFRESH: 'refresh',
  LOGIN: 'login',
  LOGOUT: 'logout',
  REFUSED: 'refused',
  POSTURE_ACCEPT: 'deviation accepted',
  POSTURE_UNACCEPT: 'acceptance withdrawn',
  PORT_KNOWN: 'port known',
  UPDATE_DECISION: 'update decision',
  UPDATE_DECISION_LIFT: 'update decision lifted',
})

// network module writes: "network: <verb>"
export const NET_PREFIX = 'network: '
export const NET_VERB = Object.freeze({
  EDIT: 'edit',
  KNOWN: 'known',
  DELETE: 'delete',
  LINK: 'link',
  UNLINK: 'unlink',
  MERGE: 'merge',
  SAME_DEVICE: 'same device',
  DETACH: 'detach',
  MAC_RULE: 'MAC rule',
  LIFT_RULE: 'lift rule',
  PROBE: 'probe',
  PROBE_ALL: 'probe all',
  DISMISS: 'dismiss suggestion',
  IGNORE: 'ignore',
  PURGE_R4: 'legacy states purge',
})
export const netAction = verb => `${NET_PREFIX}${verb}`

// former values (French), never written any more
const LEGACY_NET_PREFIX = 'réseau : '
const LEGACY_AUDIT = Object.freeze({
  'fin de silence': AUDIT.SILENCE_END,
  'rafraîchir': AUDIT.REFRESH,
  'connexion': AUDIT.LOGIN,
  'déconnexion': AUDIT.LOGOUT,
  'refusé': AUDIT.REFUSED,
  'écart accepté': AUDIT.POSTURE_ACCEPT,
  'acceptation retirée': AUDIT.POSTURE_UNACCEPT,
  'port connu': AUDIT.PORT_KNOWN,
  'décision MAJ': AUDIT.UPDATE_DECISION,
  'décision MAJ levée': AUDIT.UPDATE_DECISION_LIFT,
})
const LEGACY_NET_VERB = Object.freeze({
  'modifier': NET_VERB.EDIT,
  'connu': NET_VERB.KNOWN,
  'supprimer': NET_VERB.DELETE,
  'lier': NET_VERB.LINK,
  'délier': NET_VERB.UNLINK,
  'fusionner': NET_VERB.MERGE,
  'même appareil': NET_VERB.SAME_DEVICE,
  'détacher': NET_VERB.DETACH,
  'règle de MAC': NET_VERB.MAC_RULE,
  'lever la règle': NET_VERB.LIFT_RULE,
  'sonder': NET_VERB.PROBE,
  'sonder tout': NET_VERB.PROBE_ALL,
  'écarter une suggestion': NET_VERB.DISMISS,
  'ignorer': NET_VERB.IGNORE,
  'purge R4': NET_VERB.PURGE_R4,
})

// current value of an audit action, old or new; an unknown action (route refusal "GET /api/…",
// plugin action) is returned as is
export function auditAction(action) {
  const a = String(action ?? '')
  if (Object.hasOwn(LEGACY_AUDIT, a)) return LEGACY_AUDIT[a]
  if (a.startsWith(LEGACY_NET_PREFIX)) {
    const v = a.slice(LEGACY_NET_PREFIX.length)
    if (Object.hasOwn(LEGACY_NET_VERB, v)) return netAction(LEGACY_NET_VERB[v])
  }
  return a
}
// every stored value of an action (current first, then the former ones): for SQL lookups
export const auditActionValues = action => [action,
  ...Object.keys(LEGACY_AUDIT).filter(k => LEGACY_AUDIT[k] === action),
  ...Object.keys(LEGACY_NET_VERB).filter(k => netAction(LEGACY_NET_VERB[k]) === action).map(k => `${LEGACY_NET_PREFIX}${k}`)]

const keyOf = (table, value) => Object.keys(table).find(k => table[k] === value)

// label of an audit action (old or new code) in the instance locale
export function auditLabel(action) {
  const a = auditAction(action)
  const k = keyOf(AUDIT, a)
  if (k) return tr(`audit.${k.toLowerCase()}`)
  if (a.startsWith(NET_PREFIX)) {
    const v = keyOf(NET_VERB, a.slice(NET_PREFIX.length))
    if (v) return tr('audit.network', { verb: tr(`audit.net.${v.toLowerCase()}`) })
  }
  return a
}

// --- audit.target, audit.detail, audit.actor -----------------------------------------------------
// target of "probe all" (write on the whole network); several records; one typed link
export const NET_TARGET_ALL = 'network'
export const targetDevices = n => `${n} devices`
export const targetLink = id => `link:${id}`
// details written by the code
export const AUDIT_DETAIL = Object.freeze({
  ALREADY: 'already handled',
  RETIRED_R4: 'action retired',
  UNAUTHORIZED: 'account or chat not authorized',
})
// detail of a silence that was set: reason, then ISO end or "no end"
export const silenceDetail = (reason, endsAt) => `${reason} (${endsAt ? `until ${new Date(endsAt).toISOString()}` : 'no end'})`
// actor of the one-off purge of the removed device states (archived, ignored)
export const MIGRATION_ACTOR = 'migration:legacy-states'
// identity of a proxied request without a readable client IP (lock key, audit actor)
export const PROXY_NO_XFF = 'proxy-no-xff'

const LEGACY_DETAIL = Object.freeze({
  'déjà traité': AUDIT_DETAIL.ALREADY,
  'action retirée (R4)': AUDIT_DETAIL.RETIRED_R4,
  'compte ou chat non autorisé': AUDIT_DETAIL.UNAUTHORIZED,
})
const LEGACY_ACTOR = Object.freeze({ 'migration:r4': MIGRATION_ACTOR, 'proxy-sans-xff': PROXY_NO_XFF })

export const auditActor = actor => (actor != null && Object.hasOwn(LEGACY_ACTOR, actor) ? LEGACY_ACTOR[actor] : actor)
export function auditTarget(target) {
  if (target == null) return target
  const s = String(target)
  if (s === 'réseau') return NET_TARGET_ALL
  let m
  if ((m = /^(\d+) appareils$/.exec(s))) return targetDevices(m[1])
  if (s.startsWith('lien:')) return targetLink(s.slice(5))
  return s
}
export function auditDetail(detail) {
  if (detail == null) return detail
  const s = String(detail)
  if (Object.hasOwn(LEGACY_DETAIL, s)) return LEGACY_DETAIL[s]
  let m
  if ((m = /^([\s\S]*) \(jusqu'à (\d{4}-\d\d-\d\dT[\d:.]+Z)\)$/.exec(s))) return `${m[1]} (until ${m[2]})`
  if ((m = /^([\s\S]*) \(sans fin\)$/.exec(s))) return `${m[1]} (no end)`
  return s
}
// an audit row with its codes at their current value (old rows included)
export const auditRow = r => ({ ...r, action: auditAction(r.action), target: auditTarget(r.target), detail: auditDetail(r.detail), actor: auditActor(r.actor) })

// --- outbox.dropped and outbox_delivery.dropped --------------------------------------------------
// why a queued message was dropped. Readers only test IS NULL and DRY_RUN, whose value never
// changed; droppedCode is the reference for any future reader
export const DROPPED = Object.freeze({ EXPIRED: 'expired', REJECTED: 'rejected', FILTERED: 'filtered', DRY_RUN: 'dry-run' })
const LEGACY_DROPPED = Object.freeze({ 'expiré': DROPPED.EXPIRED, 'rejeté': DROPPED.REJECTED, 'filtré': DROPPED.FILTERED })
export const droppedCode = v => (v != null && Object.hasOwn(LEGACY_DROPPED, v) ? LEGACY_DROPPED[v] : v)

// --- host_ports.known_by -------------------------------------------------------------------------
// ports present at the first v8 report: known from the start, by this pseudo-author
export const KNOWN_BY_BOOTSTRAP = 'bootstrap'
const LEGACY_KNOWN_BY = Object.freeze({ 'amorçage': KNOWN_BY_BOOTSTRAP })
export const knownBy = v => (v != null && Object.hasOwn(LEGACY_KNOWN_BY, v) ? LEGACY_KNOWN_BY[v] : v)

// --- kv keys -------------------------------------------------------------------------------------
export const KV = Object.freeze({
  IP_HANDOVER: 'network.ipHandover', // registry of IP-handover attachments (JSON)
  LEGACY_PURGE: 'network.legacyPurge', // the purge of removed states ran (JSON: at, n, ids)
  LEGACY_PURGE_DIGESTED: 'network.legacyPurgeDigested', // its digest line was sent
})
const LEGACY_KV = Object.freeze({
  [KV.IP_HANDOVER]: 'network.l1',
  [KV.LEGACY_PURGE]: 'network.purgeR4',
  [KV.LEGACY_PURGE_DIGESTED]: 'network.purgeR4Digested',
})
// value of a kv key, read under its former name when the current one is absent (writes always
// use the current name; the former row stays as it is)
export function kvGet(kv, key) {
  const v = kv.get(key)
  return v == null && Object.hasOwn(LEGACY_KV, key) ? kv.get(LEGACY_KV[key]) : v
}

// --- net_events.detail ---------------------------------------------------------------------------
// separators and markers of the detail formats (lib/network/events.js builds and parses them)
export const EV = Object.freeze({
  SEP: ': ',
  MAC: 'MAC ', // ARP conflict on a MAC
  IP: 'IP ', // ARP conflict on an IP
  IP_HANDOVER: 'IP handover: ', // attachment by IP handover (mac_added)
  PENDING: ', pending',
  BOOTSTRAP: ', bootstrap', // record born during the probe bootstrap (new)
  ADMIN: 'admin', // probe run requested by an admin (probed)
})

const MAC_RE = '(?:[0-9a-f]{2}:){5}[0-9a-f]{2}'
function legacyWhy(why) {
  let m
  if ((m = /^([\s\S]*), en attente$/.exec(why))) return `${legacyWhy(m[1])}${EV.PENDING}`
  if ((m = /^L1 : même IP (\S+) \(plage macvlan, passation au balayage\)$/.exec(why))) return `${EV.IP_HANDOVER}same IP ${m[1]} (macvlan range, handover at scan)`
  if ((m = /^même IP (\S+) \(plage macvlan\)$/.exec(why))) return `same IP ${m[1]} (macvlan range)`
  if ((m = /^même nom « ([\s\S]*) »$/.exec(why))) return `same name "${m[1]}"`
  if ((m = /^famille (\S+) « ([\s\S]*) »$/.exec(why))) return `family ${m[1]} "${m[2]}"`
  if ((m = /^famille (\S+)$/.exec(why))) return `family ${m[1]}`
  if ((m = /^agent : conteneur (\S+) sur (\S+) \(réseau (\S+)\)$/.exec(why))) return `agent: container ${m[1]} on ${m[2]} (network ${m[3]})`
  return why
}
// detail of an event at its current format: a detail written in a former (French) format is
// rewritten in memory, never in the database; any other shape is returned as is
export function eventDetail(type, detail) {
  if (detail == null) return detail
  const s = String(detail)
  let m
  switch (type) {
    case 'arp_conflict':
      if ((m = new RegExp(`^MAC (${MAC_RE}) : en-tête Ethernet (${MAC_RE})$`).exec(s))) return `${EV.MAC}${m[1]}${EV.SEP}Ethernet header ${m[2]}`
      if ((m = new RegExp(`^MAC (${MAC_RE}) : (\\d+) réponses? en double$`).exec(s))) return `${EV.MAC}${m[1]}${EV.SEP}${m[2]} duplicate repl${m[2] === '1' ? 'y' : 'ies'}`
      if ((m = new RegExp(`^IP (\\S+) : (\\d+) MAC \\(((?:${MAC_RE})(?:, ${MAC_RE})*)\\)$`).exec(s))) return `${EV.IP}${m[1]}${EV.SEP}${m[2]} MAC (${m[3]})`
      if ((m = new RegExp(`^MAC (${MAC_RE}) : répond pour (\\d+) IP$`).exec(s))) return `${EV.MAC}${m[1]}${EV.SEP}answers for ${m[2]} IP`
      // any other former conflict text: its key separator only
      if ((m = /^((?:MAC|IP) \S+) : ([\s\S]*)$/.exec(s))) return `${m[1]}${EV.SEP}${m[2]}`
      return s
    case 'mac_added':
      return (m = new RegExp(`^(${MAC_RE}) : ([\\s\\S]+)$`).exec(s)) ? `${m[1]}${EV.SEP}${legacyWhy(m[2])}` : s
    case 'returned':
      return (m = new RegExp(`^(${MAC_RE}) revenue après suppression du (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d) : ([\\s\\S]*)$`).exec(s)) ? `${m[1]} returned after deletion on ${m[2]}${EV.SEP}${m[3]}` : s
    case 'mac_detached':
      return (m = new RegExp(`^(${MAC_RE}) → fiche (\\d+) : ([\\s\\S]*)$`).exec(s)) ? `${m[1]} → record ${m[2]}${EV.SEP}${m[3]}` : s
    case 'probed':
      return (m = /^([\s\S]*?) · (\d+) ports? ouverts? · HTTP : (\d+) requêtes?, (\d+) en 4xx · (\d+) ms$/.exec(s))
        ? `${m[1]} · ${m[2]} open port${m[2] === '1' ? '' : 's'} · HTTP: ${m[3]} request${m[3] === '1' ? '' : 's'}, ${m[4]} 4xx · ${m[5]} ms` : s
    case 'agent_conflict':
      if ((m = /^conteneur (\S+) : déjà associé à la fiche (\d+) ; rattachement par identité suspendu$/.exec(s))) return `container ${m[1]}${EV.SEP}already linked to record ${m[2]}; identity attachment suspended`
      return (m = /^conteneur (\S+) : fiche déjà associée à (\S+) ; rattachement par identité suspendu$/.exec(s)) ? `container ${m[1]}${EV.SEP}record already linked to ${m[2]}; identity attachment suspended` : s
    case 'new':
      return (m = /^([\s\S]*), amorçage$/.exec(s)) ? `${m[1]}${EV.BOOTSTRAP}` : s
    default:
      return s
  }
}
// actor of a net_events row, at its current value
export const eventActor = auditActor

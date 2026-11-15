// Alert signals of the network module, a pure function injected into alerts/rules.js. The
// engine silently forgets a signal absent for 10 min (FORGET_AFTER): every signal is
// therefore ALWAYS emitted, with cond: false outside the condition, and cond: null when the
// data is missing.
//
// No notification at deployment: net_new only targets "new" records born from an
// observation (origin scan) AFTER alertsSince, set when the module starts; "to review" is
// never a condition; MACs older than attachment tracking have attach NULL.
// net_down (opt-in) is only true for a device that went offline after having been seen
// since the first sweep (a record never seen never alerts), except with a silent or
// failing probe (null); net_ip_changed; source_error arp.
import { isPending, plain, deviceLabel } from './merge.js'
import { localeTag, t as tr } from '../i18n.js'

const MIN = 60_000
const DAY = 86400_000
const DOUBLE_VIEW_MS = 2 * MIN // a second view, 2 min after creation, rules out passing MACs
const SOURCE_NAMES = ['pihole', 'dhcp', 'neigh', 'pve', 'arp']
// label of a source: net.source.<name>
const SEVERITIES = new Set(['info', 'warning', 'critical'])

// "2 h ago" (net_down detail, notification text)
function ago(ms) {
  const min = Math.max(1, Math.round(ms / MIN))
  if (min < 60) return tr('time.minutes', { n: min })
  if (min < 48 * 60) return tr('time.hours', { h: Math.round(min / 60) })
  return tr('time.days', { d: Math.round(min / 1440) })
}

const fmtDate = (ms, tz) => new Date(ms).toLocaleDateString(localeTag(), { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' })

// state: { devices, macs, seen } (snapshot, as Maps); sources: view of the sources (stale,
// ok); flood: flooding state; alertsSince: ms; severity: severity of net_new
// retired: alert keys that became pointless (merged record, merged MAC), emitted one last
// time as false to be resolved right away (otherwise forgotten after 10 min)
// presence (null without a configured probe): { since, parentsOf, probe }; probe: 'off', 'on' or 'down'
// returned: ids of the records with a "returned" event since alertsSince
export function networkSignals({ devices, macs, seen, sources = {}, flood = null, retired = [], presence = null, l1Escalated = new Set(), agentConflicts = [], returned = new Set() }, { now = Date.now(), alertsSince, severity = 'warning', tz = 'Europe/Paris' }) {
  const out = []
  const byDevice = new Map()
  for (const m of macs.values()) {
    if (!byDevice.has(m.device_id)) byDevice.set(m.device_id, [])
    byDevice.get(m.device_id).push(m)
  }
  // double view of net_new: probe in service → its views only (arp, neigh REACHABLE, self;
  // never Pi-hole or a lease); otherwise all sources
  const VIEW_SOURCES = presence?.probe === 'on' ? ['arp', 'neigh', 'self'] : ['pihole', 'neigh', 'arp', 'agent', 'dhcp', 'self'] // without mdns
  const seenOf = mac => VIEW_SOURCES.map(s => seen.get(`${mac}|${s}`)).filter(Boolean)
  // stale Pi-hole: presence is unknown, net_new stays as it is (not forgotten)
  const piholeStale = !!sources.pihole && (sources.pihole.ok === null || sources.pihole.stale)

  for (const d of devices.values()) {
    const ms = (byDevice.get(d.id) || []).filter(m => !isPending(m))
    // a deleted MAC that comes back (pve or config with a host included) alerts like an ARP return
    const isNew = d.state === 'new' && (d.origin === 'scan' || returned.has(d.id)) && alertsSince != null && d.created_at >= alertsSince
    const twice = ms.some(m => flood?.confirmed?.has(m.mac) || seenOf(m.mac).some(r => r.last_seen >= d.created_at + DOUBLE_VIEW_MS))
    const primary = ms.find(m => m.mac === d.primary_mac) ?? ms[0]
    const label = deviceLabel(d)
    const early = d.first_seen != null && d.first_seen < d.created_at - DAY ? tr('net.rules.early', { date: fmtDate(d.first_seen, tz) }) : ''
    out.push({
      key: `net_new:${d.id}`, rule: 'net_new', entity: `dev:${d.id}`, env: 'prod', hostId: d.host_id ?? null, host: null,
      title: tr('net.rules.new_title', { label }),
      detail: [primary ? `${primary.mac}${primary.random ? tr('net.rules.private') : ''}` : null, plain(d.vendor)].filter(Boolean).join(' · ') + early || null,
      cond: !isNew ? false : piholeStale ? null : twice,
      severity, noRepeat: true, quietResolve: true, parents: ['source_error:network/pihole'],
      link: `/network?d=${Number(d.id)}`,
    })
  }

  // MAC attached automatically, awaiting confirmation (possible spoofing); attached by a
  // validated family: reported in the digest for 24 h (an intruder taking a known prefix
  // does not go unnoticed)
  for (const m of macs.values()) {
    if (!['name', 'ip', 'detached', 'rule', 'agent'].includes(m.attach)) continue
    const d = devices.get(m.device_id)
    const label = deviceLabel(d ?? { id: m.device_id })
    const how = m.attach === 'ip' ? tr('net.rules.how.ip') : m.attach === 'rule' ? tr('net.rules.how.rule')
      : m.attach === 'agent' ? tr('net.rules.how.agent') : tr('net.rules.how.name', { name: plain(d?.disp_name ?? '?') })
    out.push({
      key: `net_mac_added:${m.mac}`, rule: 'net_mac_added', entity: `mac:${m.mac}`, env: 'prod', hostId: null, host: null,
      title: tr('net.rules.mac_title', { label }),
      detail: tr('net.rules.mac_detail', { mac: m.mac, how }),
      // rule and agent: confirmed outright, visible 24 h in the digest (info)
      cond: m.attach === 'rule' || m.attach === 'agent' ? m.confirmed_at != null && now - m.confirmed_at < DAY : isPending(m),
      // escalated IP handover (another MAC answered on the IP): warning, the engine sends escalate
      severity: m.attach === 'name' || l1Escalated.has(m.mac) ? 'warning' : 'info', noRepeat: true, quietResolve: true, parents: [],
      link: `/network?d=${Number(m.device_id)}`,
    })
  }

  // container identity conflict (no automatic move): warning, until a human decision
  // (detach, merge, delete)
  for (const c of agentConflicts) {
    const d = devices.get(c.device)
    if (!d) continue
    out.push({
      key: `net_agent_conflict:${c.device}`, rule: 'net_agent_conflict', entity: `dev:${c.device}`, env: 'prod', hostId: null, host: null,
      title: tr('net.rules.conflict_title', { label: deviceLabel(d ?? { id: c.device }) }),
      detail: tr('net.rules.conflict_detail', { key: plain(c.key), what: c.other != null ? tr('net.rules.conflict_other', { id: Number(c.other) }) : tr('net.rules.conflict_current', { current: plain(c.current) }) }),
      cond: true, severity: 'warning', noRepeat: true, quietResolve: true, parents: [], link: `/network?d=${Number(c.device)}`,
    })
  }

  // MAC influx: a single incident per episode
  const ep = flood?.episode
  out.push({
    key: 'net_new_flood:lan', rule: 'net_new_flood', entity: 'lan', env: 'prod', hostId: null, host: null,
    title: tr('net.rules.flood_title'),
    detail: ep ? tr('net.rules.flood_detail', { count: flood.refused.size, time: new Date(ep.lastOver + 3600_000).toLocaleTimeString(localeTag(), { timeZone: tz, hour: '2-digit', minute: '2-digit' }) }) : null,
    cond: !!ep, severity: 'warning', noRepeat: true, parents: [], link: '/network',
  })

  // presence: emitted for every record, false outside the scope, null if unknown
  if (presence) {
    const arp = sources.arp
    // unknown presence: no valid sweep yet, silent or failing probe
    const unknown = presence.since == null || !arp || !arp.ok || !!arp.stale
    for (const d of devices.values()) {
      if (!d.primary_mac) continue
      const label = deviceLabel(d)
      const watched = !!d.alert_down
      // seen since the first sweep: only a 1 → 0 transition alerts, never null → 0
      const seenSince = d.last_present != null && presence.since != null && d.last_present >= presence.since
      out.push({
        key: `net_down:${d.id}`, rule: 'net_down', entity: `dev:${d.id}`, env: 'prod', hostId: d.host_id ?? null, host: null,
        title: tr('net.rules.down_title', { label }),
        detail: d.last_present != null ? tr('net.rules.down_detail', { duration: ago(now - d.last_present) }) : null,
        cond: !watched ? false : unknown || d.online == null ? null : d.online === 1 ? false : seenSince ? true : null,
        severity: SEVERITIES.has(d.alert_severity) ? d.alert_severity : 'warning', forSec: 0,
        parents: [...(d.host_id ? presence.parentsOf(d.host_id) : []), 'source_error:network/arp'],
        link: `/network?d=${Number(d.id)}`,
      })
      out.push({
        key: `net_ip_changed:${d.id}`, rule: 'net_ip_changed', entity: `dev:${d.id}`, env: 'prod', hostId: d.host_id ?? null, host: null,
        title: tr('net.rules.ip_title', { label }),
        detail: tr('net.rules.ip_detail'),
        cond: !d.expected_ip ? false
          : unknown || d.online !== 1 || !d.last_ip ? null : d.last_ip !== d.expected_ip,
        severity: 'warning', forSec: 600, parents: ['source_error:network/arp'],
        link: `/network?d=${Number(d.id)}`,
      })
    }
  }

  // module sources: failing or stale for 10 min; unknown before their first poll; the ARP
  // probe, before its first successful sweep (not installed)
  for (const name of SOURCE_NAMES) {
    const s = sources[name]
    if (!s) continue
    // before the first valid sweep: unknown (not installed), except an undeterminable gateway
    // on a present file, reported (a single alert, none per device)
    const before = name === 'arp' && presence?.since == null && !s.gatewayUnknown
    out.push({
      key: `source_error:network/${name}`, rule: 'source_error', entity: `network/${name}`, env: 'prod', hostId: null, host: null,
      title: tr('net.rules.source_title', { source: tr(`net.source.${name}`) }),
      detail: s.error ? String(s.error).slice(0, 200) : s.stale ? tr('net.rules.source_stale') : null,
      cond: before ? null : s.ok === null && name !== 'arp' ? null : !s.ok || !!s.stale, forSec: 600, severity: 'warning', parents: [], link: '/network',
    })
  }
  // retired keys (merged or deleted record, removed MAC): cond: false + quietResolve, the
  // engine resolves them without a message
  const emitted = new Set(out.map(s => s.key))
  for (const key of retired) {
    if (emitted.has(key)) continue
    const rule = key.split(':')[0]
    out.push({ key, rule, entity: key.slice(rule.length + 1), env: 'prod', hostId: null, host: null, title: tr('net.rules.retired'), cond: false, severity: 'info', quietResolve: true, parents: [], link: '/network' })
  }
  return out
}

// Daily digest (08:00 local time): active alerts, incidents of the
// last 24 h (including those of the night, postponed), backups, storages,
// certificates and CI. Caught up at startup if it was missed (until noon).
import { fmtDuration } from '../clock.js'
import { t, tHtml } from './format.js'
import { t as tr } from '../i18n.js'
import { backupStatus } from '../status.js'
import { RULE_LABEL } from '../alerts/rules.js'

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' }

// network alerts "to handle" (new device, MAC to confirm): grouped in the Network
// section, outside the general list (10 lines), so as not to drown the failures
export const NETWORK_TODO = new Set(['net_new', 'net_mac_added'])
// services to restart, grouped on their own line (updates.digestLines) rather than
// in the general list
const OWN_LINE = new Set(['restart_required'])

// alerts listed in full (beyond: "+N on the cockpit"), silences and incidents listed
const MAX_ALERTS = 12
const MAX_LIST = 6
const SEV = { critical: 0, warning: 1, info: 2 }
const SEPARATORS = new Set(['·', '—', '-', ':', '–'])

// names of the items of a group: the words common to all titles are removed when they are a
// prefix ending with a separator ("Reboot required · web" → "web") or a suffix without a
// separator ("VM 102 app undeclared" → "VM 102 app"); a qualifier such as "· web" stays.
// Names not distinct or empty: the full titles
export function itemNames(titles) {
  const toks = titles.map(s => String(s ?? '').split(' '))
  const minLen = Math.min(...toks.map(x => x.length))
  let p = 0
  while (p < minLen - 1 && toks.every(x => x[p] === toks[0][p])) p++
  while (p > 0 && !SEPARATORS.has(toks[0][p - 1])) p--
  let q = 0
  while (q < minLen - 1 - p && toks.every(x => x[x.length - 1 - q] === toks[0][toks[0].length - 1 - q])) q++
  if (toks[0].slice(toks[0].length - q).some(w => SEPARATORS.has(w))) q = 0
  const names = toks.map(x => x.slice(p, x.length - q).join(' '))
  return names.every(Boolean) && new Set(names).size === names.length ? names : titles.map(String)
}

// a block of a module: its headlines as they are, the indented lines that follow them in a quote
// (folded beyond 3 lines); lines in plain text, escaped here
export function renderBlock(lines) {
  const out = []
  let quote = []
  const close = () => {
    if (!quote.length) return
    out.push(`<blockquote${quote.length > 3 ? ' expandable' : ''}>${quote.join('\n')}</blockquote>`)
    quote = []
  }
  for (const l of lines) {
    if (/^\s/.test(l) && out.length) quote.push(t(l.trim()))
    else {
      close()
      out.push(t(l.trim()))
    }
  }
  close()
  return out.join('\n')
}

// host: lines of modules and plugins by slot ("ci" after the certificates, "end" at the
// end, one block per module), instead of calling updates.digestLines and network.digestLines directly.
// Layout: sections separated by a blank line, alerts by severity then age, alerts of the same
// rule grouped (one title, one line per item, the shared detail once)
export function buildDigest({ cfg, engine, snap, monitor, formatter, clock, updates = null, network = null, host = null, silences = null, mark = false, now = Date.now() }) {
  const sections = [tHtml('digest.title', { date: clock.local(now).dm })]
  const since = ms => tHtml('digest.since', { duration: fmtDuration(now - ms) })
  const ack = a => (a.ack ? tHtml('digest.acked', { by: a.ack.by, reason: a.ack.reason }) : null)

  const active = engine.active().filter(a => a.state === 'firing' && !NETWORK_TODO.has(a.rule) && !OWN_LINE.has(a.rule))
  const shown = active.filter(a => !a.suppressed).sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3) || a.since - b.since)
  if (!active.length) sections.push(tr('digest.no_alerts'))
  else {
    const blocks = [tr('digest.alerts', { count: active.length })
      + (active.length > shown.length ? tr('digest.alerts_masked', { count: active.length - shown.length }) : '')]
    const groups = new Map()
    for (const a of shown.slice(0, MAX_ALERTS)) {
      const k = `${a.rule}|${a.severity}`
      groups.set(k, [...(groups.get(k) ?? []), a])
    }
    for (const list of groups.values()) {
      const [a] = list
      if (list.length === 1) {
        blocks.push([`${ICON[a.severity]} <b>${t(a.title)}</b> · ${since(a.since)}`, a.detail && t(a.detail), ack(a)].filter(Boolean).join('\n'))
        continue
      }
      const label = RULE_LABEL[a.rule] || a.rule
      const names = itemNames(list.map(x => x.title))
      const shared = list.every(x => x.detail && x.detail === a.detail) ? a.detail : null
      blocks.push([
        `${ICON[a.severity]} <b>${t(label)}</b> · ${list.length}`,
        ...list.map((x, i) => [`• ${t(names[i])}${!shared && x.detail ? ` — ${t(x.detail)}` : ''} · ${since(x.since)}`, ack(x) && `   ${ack(x)}`].filter(Boolean).join('\n')),
        shared && `<i>${t(shared)}</i>`,
      ].filter(Boolean).join('\n'))
    }
    if (shown.length > MAX_ALERTS) blocks.push(tr('digest.more', { count: shown.length - MAX_ALERTS }))
    sections.push(blocks.join('\n\n'))
  }

  // active silences, with their reason (a silence with no end is reminded every day)
  const sil = silences?.active(now) || []
  if (sil.length) {
    sections.push([tr('digest.silences', { count: sil.length }),
      ...sil.slice(0, MAX_LIST).map(s => `• ${t(s.target)} — ${t(s.reason)} (${s.endsAt ? tHtml('digest.silence_until', { date: clock.local(s.endsAt).dm, time: clock.hm(s.endsAt) }) : tr('digest.silence_forever')})`),
      ...(sil.length > MAX_LIST ? [`• +${sil.length - MAX_LIST}`] : [])].join('\n'))
  }

  // incidents resolved in 24 h: their own section; none: one line of the state section
  const state = []
  const incidents = engine.incidents(now - 24 * 3600_000).filter(i => i.resolvedAt && !i.suppressed && !NETWORK_TODO.has(i.rule))
  if (incidents.length) {
    sections.push([tr('digest.incidents', { count: incidents.length }),
      ...incidents.slice(0, MAX_LIST).map(i => `• ${t(i.title)} (${fmtDuration(i.resolvedAt - i.startedAt)})`),
      ...(incidents.length > MAX_LIST ? [`• +${incidents.length - MAX_LIST}`] : [])].join('\n'))
  } else state.push(tr('digest.no_incidents'))

  // backups: declared guests up to date (last backup < threshold, no failure)
  const bk = backupStatus(cfg, snap, now).map(b => (b.error
    ? tHtml('digest.backup_unreadable', { node: b.node })
    : `${t(b.node)} ${b.ok}/${b.total}${b.ok < b.total ? ' ⚠️' : ''}`))
  // lists already escaped: tr (not tHtml, which would escape them twice)
  if (bk.length) state.push(tr('digest.backups', { list: bk.join(' · ') }))

  // storages: the three fullest (node name if the name exists on both Proxmox clusters)
  const st = []
  for (const c of snap.cluster?.data || []) {
    const node = cfg.hosts.find(h => h.kind === 'pve-node' && h.pve === c.id)?.name ?? c.id
    for (const s of c.storages || []) {
      if (!s.maxdisk) continue
      const pct = Math.round((s.disk / s.maxdisk) * 100)
      if (!st.some(x => x.name === s.name && x.pct === pct)) st.push({ name: s.name, node, pct })
    }
  }
  const dupName = n => st.filter(x => x.name === n).length > 1
  st.sort((a, b) => b.pct - a.pct)
  if (st.length) {
    state.push(tr('digest.storages', { list: st.slice(0, 3).map(s => `${t(s.name)}${dupName(s.name) ? ` (${t(s.node)})` : ''} ${s.pct} %${s.pct >= cfg.alerts.storage.warnPct ? ' ⚠️' : ''}`).join(' · ') }))
  }

  // certificates under the warning threshold
  const certs = []
  for (const c of monitor.checks.filter(c => c.type === 'tls')) {
    const d = monitor.result(c.id)?.tls?.daysLeft
    if (d != null && d < (c.warnDays ?? 21)) {
      const svc = cfg.services.find(s => s.id === c.serviceId)
      certs.push(`${t(svc?.name)} ${tr('time.days', { d })}`)
    }
  }
  state.push(tr('digest.certs', { list: certs.length ? certs.join(', ') : tr('digest.none') }))

  // "ci" slot of the modules ("⚙️ CI" line of the gitea plugin): end of the state section
  for (const l of host?.digestLines('ci', { snap, mark, now }) || []) state.push(t(l))
  sections.push(state.join('\n'))

  // "end" slot (versions, network, …): one section per module; without a host, updates then network
  // (versions: new versions announced only once, end of life; network: discovered names escaped)
  const blocks = host ? host.digestBlocks('end', { snap, mark, now })
    : [updates?.digestLines({ mark, now }), network?.digestLines?.({ mark, now })]
  for (const b of blocks) if (b?.length) sections.push(renderBlock(b))

  const link = formatter.link('/alerts', tr('digest.open_cockpit'))
  if (link) sections.push(`👉 ${link}`)
  return sections.join('\n\n')
}

export function createDigest({ cfg, store, notifier, clock, build, log = console }) {
  const [h, m] = cfg.alerts.digestAt.split(':').map(Number)
  const at = h * 60 + m
  return {
    // called every minute
    tick(now = Date.now()) {
      const l = clock.local(now)
      if (l.minutes < at || l.minutes > 12 * 60) return false
      if (store.kv.get('digest.last') === l.date) return false
      store.kv.set('digest.last', l.date)
      try {
        notifier.enqueueRaw('digest', build(now, { mark: true }), { silent: true, now })
        notifier.consumeDeferred(now)
      } catch (e) {
        log.error(`digest: ${e.message}`)
      }
      return true
    },
  }
}

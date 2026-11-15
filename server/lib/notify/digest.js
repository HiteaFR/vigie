// Daily digest (08:00 local time): active alerts, incidents of the
// last 24 h (including those of the night, postponed), backups, storages,
// certificates and CI. Caught up at startup if it was missed (until noon).
import { fmtDuration } from '../clock.js'
import { t, tHtml } from './format.js'
import { t as tr } from '../i18n.js'
import { backupStatus } from '../status.js'

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' }

// network alerts "to handle" (new device, MAC to confirm): grouped in the Network
// section, outside the general list (10 lines), so as not to drown the failures
export const NETWORK_TODO = new Set(['net_new', 'net_mac_added'])
// services to restart, grouped on their own line (updates.digestLines) rather than
// in the general list
const OWN_LINE = new Set(['restart_required'])

// host: lines of modules and plugins by slot ("ci" after the certificates, "end" at the
// end), instead of calling updates.digestLines and network.digestLines directly
export function buildDigest({ cfg, engine, snap, monitor, formatter, clock, updates = null, network = null, host = null, silences = null, mark = false, now = Date.now() }) {
  const out = [tHtml('digest.title', { date: clock.local(now).dm })]

  const active = engine.active().filter(a => a.state === 'firing' && !NETWORK_TODO.has(a.rule) && !OWN_LINE.has(a.rule))
  const shown = active.filter(a => !a.suppressed)
  if (!active.length) out.push(tr('digest.no_alerts'))
  else {
    out.push(tr('digest.alerts', { count: active.length })
      + (active.length > shown.length ? tr('digest.alerts_masked', { count: active.length - shown.length }) : ''))
    for (const a of shown.slice(0, 10)) {
      out.push(`  ${ICON[a.severity]} ${t(a.title)}${a.detail ? ` — ${t(a.detail)}` : ''} (${tHtml('digest.since', { duration: fmtDuration(now - a.since) })})`
        + (a.ack ? `\n     ${tHtml('digest.acked', { by: a.ack.by, reason: a.ack.reason })}` : ''))
    }
  }

  // active silences, with their reason (a silence with no end is reminded every day)
  const sil = silences?.active(now) || []
  if (sil.length) {
    out.push(`${tr('digest.silences', { count: sil.length })} : ${sil.slice(0, 6).map(s =>
      `${t(s.target)} — ${t(s.reason)} (${s.endsAt ? tHtml('digest.silence_until', { date: clock.local(s.endsAt).dm, time: clock.hm(s.endsAt) }) : tr('digest.silence_forever')})`).join(' · ')}${sil.length > 6 ? '…' : ''}`)
  }

  const incidents = engine.incidents(now - 24 * 3600_000).filter(i => i.resolvedAt && !i.suppressed && !NETWORK_TODO.has(i.rule))
  if (incidents.length) {
    const list = incidents.slice(0, 6).map(i => `${t(i.title)} ${fmtDuration(i.resolvedAt - i.startedAt)}`).join(', ')
    out.push(`${tr('digest.incidents', { count: incidents.length })} — ${list}${incidents.length > 6 ? '…' : ''}`)
  } else out.push(tr('digest.no_incidents'))

  // backups: declared guests up to date (last backup < threshold, no failure)
  const bk = backupStatus(cfg, snap, now).map(b => (b.error
    ? tHtml('digest.backup_unreadable', { node: b.node })
    : `${t(b.node)} ${b.ok}/${b.total}${b.ok < b.total ? ' ⚠️' : ''}`))
  // lists already escaped: tr (not tHtml, which would escape them twice)
  if (bk.length) out.push(tr('digest.backups', { list: bk.join(' · ') }))

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
    out.push(tr('digest.storages', { list: st.slice(0, 3).map(s => `${t(s.name)}${dupName(s.name) ? ` (${t(s.node)})` : ''} ${s.pct} %${s.pct >= cfg.alerts.storage.warnPct ? ' ⚠️' : ''}`).join(' · ') }))
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
  out.push(tr('digest.certs', { list: certs.length ? certs.join(', ') : tr('digest.none') }))

  // "ci" slot of the modules ("⚙️ CI" line of the gitea plugin), then "end" (versions, network, …)
  // versions: new versions announced only once, end of life
  for (const l of host?.digestLines('ci', { snap, mark, now }) || []) out.push(t(l))
  if (host) for (const l of host.digestLines('end', { snap, mark, now })) out.push(t(l))
  for (const l of (host ? null : updates?.digestLines({ mark, now })) || []) out.push(t(l))
  // network: devices, new ones, MACs to confirm, sources; discovered names escaped
  for (const l of (host ? null : network?.digestLines?.({ mark, now })) || []) out.push(t(l))

  const link = formatter.link('/alerts', tr('digest.open_cockpit'))
  if (link) out.push(link)
  return out.join('\n')
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

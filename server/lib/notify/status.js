// bot /status (index.js): one line per domain, in the instance locale (status.*). s: output
// of summary(); u: updates.counts(); silences: number of active silences. Free values (names
// of guests, nodes, sources) escaped by tHtml or t
import { t as tg, tHtml } from './format.js'
import { t as tr } from '../i18n.js'

export function statusLines({ s, u, silences }) {
  const icon = { ok: '🟢', warn: '🟠', crit: '🔴', unknown: '⚪' }[s.state]
  // headline, a blank line, then one line per area; stopped guests in a quote under their line
  const head = tr('status.infra', { icon, alerts: `${tr('status.critical', { count: s.alerts.critical })} · ${tr('status.warning', { count: s.alerts.warning })}`,
    masked: s.alerts.masked ? tr('status.masked', { count: s.alerts.masked }) : '' })
  return `${head}\n\n${[
    tr('status.services', { ok: s.services.ok, total: s.services.total, down: s.services.crit ? tr('status.services_down', { count: s.services.crit }) : '' }),
    tr('status.guests', { running: s.guests.running, total: s.guests.total })
      + (s.guests.stoppedDeclared.length ? `\n<blockquote>${tHtml('status.stopped', { list: s.guests.stoppedDeclared.join(', ') })}</blockquote>` : ''),
    ...(s.backups.length ? [tr('status.backups', { list: s.backups.map(b => (b.error ? tHtml('status.backup_unreadable', { node: b.node }) : `${tg(b.node)} ${b.ok}/${b.total}`)).join(' · ') })] : []),
    tr('status.updates', { total: u.total, security: u.security ? tr('status.updates_security', { count: u.security }) : '' }),
    tr('status.silences', { count: silences }),
    ...(s.sourcesDown.length ? [tHtml('status.sources', { list: s.sourcesDown.join(', ') })] : []),
  ].join('\n')}`
}


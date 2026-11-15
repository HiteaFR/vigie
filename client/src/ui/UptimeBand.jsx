import { localeTag, t, tLabels } from '../i18n/index.js'
// Status-page style uptime band: one cell per slot (30 min over 24 h, one day over 30/90 d).
// 'o' ok, 'w' degraded or partial failures, 'c' failing, '-' no measurement (hatched: history
// still young).
const CELL = {
  o: 'bg-ok',
  w: 'bg-warn',
  c: 'bg-crit',
  '-': 'bg-[repeating-linear-gradient(135deg,var(--surface-3)_0_2px,transparent_2px_4px)] border border-line',
}
const LABEL = tLabels('uptime', ['o', 'w', 'c', '-'])

function fmt(t, size) {
  const d = new Date(t)
  return size >= 86400_000
    ? d.toLocaleDateString(localeTag(), { day: '2-digit', month: '2-digit' })
    : d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
}

export default function UptimeBand({ band, start, size, height = 'h-4', className = '', label = t('uptime.label') }) {
  if (!band) return <div className={`${height} ${className} rounded-sm ${CELL['-']}`} aria-label={t('ui.no_history')} />
  const cells = [...band]
  const down = cells.filter(c => c === 'c').length
  const part = cells.filter(c => c === 'w').length
  const summary = t('uptime.summary', { label, ok: cells.length - down - part - cells.filter(c => c === '-').length, part, down })
  return (
    <div className={`flex gap-px ${height} ${className}`} role="img" aria-label={summary}>
      {cells.map((c, i) => (
        <span
          key={i}
          className={`flex-1 min-w-[2px] rounded-[1px] ${CELL[c] || CELL['-']}`}
          title={start != null && size ? `${fmt(start + i * size, size)} — ${LABEL[c]}` : LABEL[c]}
        />
      ))}
    </div>
  )
}

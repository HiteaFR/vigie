import { localeTag, t } from '../i18n/index.js'
// History chart in SVG (no library): one or two series on the same axis, average and peak
// values as text, time bounds under the chart.
const W = 100

function path(values, n, top, h) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null)
  if (pts.length < 2) return null
  const xy = ([i, v]) => `${((i / n) * W).toFixed(2)},${(h - 1 - (Math.min(v, top) / top) * (h - 2)).toFixed(2)}`
  return { line: pts.map(xy).join(' '), x0: ((pts[0][0] / n) * W).toFixed(2), x1: ((pts.at(-1)[0] / n) * W).toFixed(2) }
}

const stats = values => {
  const v = values.filter(x => x != null)
  return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), last: v.at(-1) } : null
}

export default function Chart({ title, series, times, max, format = v => `${Math.round(v)}`, height = 56 }) {
  const all = series.flatMap(s => s.values).filter(x => x != null)
  if (all.length < 2) {
    return (
      <div>
        <div className="mb-1 text-2xs text-muted">{title}</div>
        <div style={{ height }} className="flex items-center text-2xs text-subtle">{t('ui.no_data_yet')}</div>
      </div>
    )
  }
  const top = max ?? (Math.max(...all) || 1)
  const n = Math.max(1, (series[0]?.values.length ?? 1) - 1)
  const fmtT = t => new Date(t).toLocaleString(localeTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <figure>
      <figcaption className="mb-1 flex flex-wrap items-baseline gap-x-3 text-2xs text-muted">
        <span className="font-medium text-fg">{title}</span>
        {series.map(s => {
          const st = stats(s.values)
          return st && (
            <span key={s.label} className="tabular-nums">
              <span className={s.className}>●</span> {s.label ? `${s.label} ` : ''}{t('ui.chart_stats', { avg: format(st.avg), max: format(st.max) })}
            </span>
          )
        })}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img"
        aria-label={`${title} : ${series.map(s => `${s.label || ''} moyenne ${format(stats(s.values)?.avg ?? 0)}`).join(', ')}`}>
        <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
        {series.map((s, k) => {
          const p = path(s.values, n, top, height)
          return p && (
            <g key={s.label || k} className={s.className}>
              {k === 0 && <polygon points={`${p.x0},${height} ${p.line} ${p.x1},${height}`} fill="currentColor" opacity="0.12" />}
              <polyline points={p.line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          )
        })}
      </svg>
      {times?.length > 1 && (
        <div className="mt-0.5 flex justify-between text-2xs text-subtle tabular-nums">
          <span>{fmtT(times[0])}</span><span>{fmtT(times.at(-1))}</span>
        </div>
      )}
    </figure>
  )
}

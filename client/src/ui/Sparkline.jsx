import { t } from '../i18n/index.js'
// Minimal SVG chart (no library): values → polyline + area.
export default function Sparkline({ values, max, height = 32, className = 'text-accent', label, fill = true }) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null)
  if (pts.length < 2) return <div style={{ height }} className="text-2xs text-subtle flex items-center">{t('ui.no_data_yet')}</div>
  const n = values.length - 1 || 1
  const top = max ?? Math.max(...pts.map(([, v]) => v), 1)
  const W = 100
  const xy = ([i, v]) => [(i / n) * W, height - 1 - (Math.min(v, top) / top) * (height - 2)]
  const line = pts.map(p => xy(p).map(x => x.toFixed(2)).join(',')).join(' ')
  const [x0] = xy(pts[0])
  const [x1] = xy(pts[pts.length - 1])
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} style={{ height }} role="img" aria-label={label}>
      {label && <title>{label}</title>}
      {fill && <polygon points={`${x0},${height} ${line} ${x1},${height}`} fill="currentColor" opacity="0.12" />}
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

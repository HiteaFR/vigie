// linear gauge: state color from the thresholds, value also as text
import { t } from '../i18n/index.js'
export default function Gauge({ value, label, warn = 80, crit = 90 }) {
  const v = Math.max(0, Math.min(100, value || 0))
  const color = v >= crit ? 'bg-crit' : v >= warn ? 'bg-warn' : 'bg-accent'
  return (
    <div>
      {label !== undefined && (
        <div className="flex justify-between text-2xs text-muted mb-0.5">
          <span className="truncate">{label}</span><span className="tabular-nums">{v}%</span>
        </div>
      )}
      <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label || t('ui.usage')}>
        <div className={`h-full ${color} transition-all`} style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

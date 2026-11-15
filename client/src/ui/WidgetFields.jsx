import { AlertTriangle } from 'lucide-react'
import { t } from '../i18n/index.js'

// Values of a service widget (already formatted server side)
export default function WidgetFields({ widget, className = '' }) {
  if (!widget) return null
  const { fields = [], error, stale } = widget
  return (
    <div className={className}>
      {fields.length > 0 && (
        <dl className={`grid gap-1 grid-cols-[repeat(auto-fit,minmax(84px,1fr))] ${stale ? 'opacity-60' : ''}`}>
          {fields.map(f => (
            <div key={f.label} className="min-w-0 rounded-[var(--radius-chip)] bg-surface-2 border border-line px-1.5 py-1">
              <dt className="text-2xs text-subtle truncate">{f.label}</dt>
              <dd className="text-xs font-semibold text-fg tabular-nums truncate" title={f.value}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {error && (
        <p className="mt-1 flex items-center gap-1 text-2xs text-warn min-w-0" title={error}>
          <AlertTriangle size={11} className="shrink-0" aria-hidden />
          <span className="truncate">widget{stale ? t('ui.stale_values') : ''}{t('common.suffix', { v: error })}</span>
        </p>
      )}
    </div>
  )
}

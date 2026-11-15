import { RefreshCw } from 'lucide-react'
import TimeAgo from './TimeAgo.jsx'
import { t } from '../i18n/index.js'

// Widget container: title, freshness, loading / error / stale states
export default function Panel({ icon: Icon, title, query, right, skeleton, children }) {
  const hasData = query ? query.data !== undefined : true
  const stale = query && hasData && query.dataUpdatedAt && Date.now() - query.dataUpdatedAt > 3 * query.period
  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {Icon && <Icon size={16} className="text-accent" aria-hidden />}
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
        <div className="ml-auto flex items-center gap-3">
          {right}
          {query && (
            <button
              type="button"
              onClick={() => query.refetch()}
              title={query.error ? String(query.error.message || query.error) : t('ui.refresh')}
              className="flex items-center gap-1.5 text-2xs text-subtle hover:text-fg transition"
            >
              <RefreshCw size={12} className={query.isFetching ? 'animate-spin' : ''} aria-hidden />
              {query.error
                ? <span className="text-crit">{t('ui.error')}</span>
                : stale
                  ? <span className="text-warn">{t('ui.data')} <TimeAgo date={query.dataUpdatedAt} /></span>
                  : <TimeAgo date={query.dataUpdatedAt} />}
            </button>
          )}
        </div>
      </div>
      {query?.error && hasData && (
        <div className="mb-3 rounded-lg border border-line bg-unknown-bg px-3 py-2 text-xs text-unknown">
          {t('ui.stale_data')} {String(query.error.message || query.error)}
        </div>
      )}
      {!hasData && query?.error
        ? <ErrorBox msg={String(query.error.message || query.error)} />
        : !hasData
          ? (skeleton || <Skeleton />)
          : <div className={stale ? 'opacity-60' : ''}>{children}</div>}
    </section>
  )
}

export function ErrorBox({ msg, prefix = t('ui.source_unreachable') }) {
  return (
    <div className="rounded-lg border border-crit/40 bg-crit-bg px-4 py-3 text-sm text-crit break-words">
      {prefix}{t('common.suffix', { v: msg })}
    </div>
  )
}

export function Skeleton({ count = 3, h = 'h-16', cols = 'sm:grid-cols-3' }) {
  return (
    <div className={`grid gap-3 ${cols}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${h} rounded-[var(--radius-card)] border border-line bg-surface animate-pulse`} />
      ))}
    </div>
  )
}

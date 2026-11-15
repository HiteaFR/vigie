import { StatusDot } from '../../ui/Status.jsx'
import { t } from '../../i18n/index.js'

export default function Runners({ data }) {
  if (!data.length) return <div className="text-xs text-subtle">{t('gitea.no_runner')}</div>
  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))]">
      {data.map(r => {
        const online = r.status === 'online'
        return (
          <div key={r.id} className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusDot state={online ? 'ok' : 'crit'} size={13} label={online ? t('gitea.online') : t('gitea.offline')} />
              <span className="text-sm font-medium text-fg truncate">{r.name}</span>
              {r.busy && online && (
                <span className="text-2xs text-warn border border-warn/30 bg-warn-bg rounded px-1.5 py-0.5">{t('gitea.busy')}</span>
              )}
              <span className={`ml-auto text-2xs font-semibold uppercase ${online ? 'text-ok' : 'text-crit'}`}>
                {online ? t('gitea.runner_status.online') : t('gitea.runner_status.offline')}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {r.labels.filter(l => l.endsWith(':host') || !l.startsWith('ubuntu')).slice(0, 4).map(l => (
                <span key={l} className="text-2xs font-mono text-subtle border border-line rounded px-1.5 py-0.5">{l}</span>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

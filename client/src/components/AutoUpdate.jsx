// "Automatic updates" state of a host (unattended-upgrades: the OS patches, the agent watches),
// computed by the server (autoUpdateStatus): badge, detail and per-host summary.
// Shared by the Updates page and the host drawer.
import { ShieldCheck, ShieldOff, ShieldAlert, ShieldQuestion } from 'lucide-react'
import TimeAgo from '../ui/TimeAgo.jsx'
import { t } from '../i18n/index.js'

export const AUTO_STATE = {
  active: { get label() { return t('auto.active') }, get short() { return t('auto.active_short') }, cls: 'text-ok', Icon: ShieldCheck },
  off: { get label() { return t('auto.off') }, get short() { return t('auto.off_short') }, cls: 'text-warn', Icon: ShieldOff },
  failed: { get label() { return t('auto.failed') }, get short() { return t('auto.failed_short') }, cls: 'text-warn', Icon: ShieldAlert },
  unknown: { get label() { return t('auto.unknown') }, get short() { return t('auto.unknown_short') }, cls: 'text-subtle', Icon: ShieldQuestion },
}
const stateOf = s => AUTO_STATE[s?.state] ?? AUTO_STATE.unknown

export function AutoUpdateBadge({ s }) {
  const { label, cls, Icon } = stateOf(s)
  return (
    <span className={`inline-flex items-center gap-0.5 rounded border border-line px-1 text-2xs ${cls}`} title={s?.detail || label}>
      <Icon size={10} aria-hidden />{label}
    </span>
  )
}

// detail: state, reason, last run, applied packages (8 at most)
export function AutoUpdateInfo({ s }) {
  if (!s) return null
  const { label, cls } = stateOf(s)
  const applied = s.applied ?? []
  return (
    <div className="text-xs text-muted">
      <p><span className={cls}>{label}</span>{s.detail ? ` : ${s.detail}` : ''}.</p>
      {s.lastRunAt != null && (
        <p>{t('auto.last_run')} <TimeAgo date={s.lastRunAt * 1000} />{s.lastResult === 'failed' ? t('auto.run_failed') : s.lastResult === 'success' ? t('auto.run_ok') : ''}
          {applied.length ? ` : ${applied.slice(0, 8).map(p => p.name).join(', ')}${applied.length > 8 ? ` (+${applied.length - 8})` : ''}.` : t('auto.none_applied')}</p>
      )}
    </div>
  )
}

// Updates page summary: hosts grouped by state (problems first)
export function AutoUpdateSummary({ hosts, onHost }) {
  if (!hosts.length || hosts.every(h => h.s?.state === 'unknown' || !h.s)) return null
  const groups = ['failed', 'off', 'active', 'unknown'].map(k => [k, hosts.filter(h => (h.s?.state ?? 'unknown') === k)]).filter(([, l]) => l.length)
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className="text-subtle">{t('auto.summary')}</span>
      {groups.map(([k, l]) => {
        const { short, cls, Icon } = AUTO_STATE[k]
        return (
          <span key={k} className="inline-flex flex-wrap items-center gap-1">
            <Icon size={11} className={cls} aria-hidden /><span className={cls}>{short}</span>
            {l.map((h, i) => (
              <span key={h.id}>
                {onHost ? <button type="button" onClick={() => onHost(h.id)} className="hover:text-fg hover:underline" title={h.s?.detail || undefined}>{h.name}</button> : h.name}
                {i < l.length - 1 ? ',' : ''}
              </span>
            ))}
          </span>
        )
      })}
    </p>
  )
}

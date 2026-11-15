// Compact tile of a service (favorites of the Cockpit and of Services)
import { STATES } from '../lib/state.js'
import { StatusDot } from '../ui/Status.jsx'
import ServiceIcon from '../ui/ServiceIcon.jsx'

export default function CompactTile({ s }) {
  const inner = (
    <>
      <ServiceIcon name={s.name} iconUrl={s.iconUrl} iconUrlDark={s.iconUrlDark} size={22} />
      <span className="min-w-0 truncate text-sm font-medium text-fg">{s.name}</span>
      <StatusDot state={s.state} size={13} className="ml-auto" />
    </>
  )
  const cls = `flex items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2 transition hover:border-line-strong hover:bg-surface-2 ${s.state === 'crit' || s.state === 'warn' ? `border-l-[3px] ${STATES[s.state].border}` : ''}`
  return s.url
    ? <a href={s.url} target="_blank" rel="noreferrer" className={cls} title={STATES[s.state]?.label}>{inner}</a>
    : <div className={cls}>{inner}</div>
}

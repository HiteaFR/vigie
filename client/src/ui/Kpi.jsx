// Cockpit indicator tile, shared by the core and the plugins (e.g. the gitea plugin's CI tile);
// card: class of the cockpit cards.
import { Link } from 'wouter'
import { stateOf } from '../lib/state.js'
import { StatusDot } from './Status.jsx'

export const card = 'rounded-[var(--radius-card)] border border-line bg-surface'

// tri: three-number tile. The tile is a container (@container): the value, on one line, gets a
// size that depends on the tile width AND on its length (--kpi-em, computed by kpi.js):
// clamp(12 px, 100cqw / em, 24 px; 30 px on the wall display); the legend wraps on two lines at
// most, never truncated ("…"); the grid evens out the heights
const TRI_VALUE = 'whitespace-nowrap text-[length:clamp(0.75rem,calc(100cqw/var(--kpi-em,5)),1.5rem)]'
const TRI_VALUE_MURAL = 'whitespace-nowrap text-[length:clamp(0.75rem,calc(100cqw/var(--kpi-em,5)),1.875rem)]'
export default function Kpi({ icon: Icon, label, value, sub, state, href, mural, tri = false, em = null, className = '' }) {
  const st = stateOf(state)
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
        <Icon size={13} aria-hidden /> {label}
        <StatusDot state={state} size={12} className="ml-auto" />
      </div>
      <div className={`mt-1 ${tri ? (mural ? TRI_VALUE_MURAL : TRI_VALUE) : mural ? 'text-3xl' : 'text-2xl'} font-bold tabular-nums ${state === 'ok' ? 'text-fg' : st.text}`}
        style={tri && em ? { '--kpi-em': em } : undefined}>{value ?? '—'}</div>
      <div className={`mt-0.5 text-2xs text-subtle ${tri ? 'line-clamp-2' : 'truncate'}`} title={typeof sub === 'string' ? sub : undefined}>{sub}</div>
    </>
  )
  const cls = `${card} block px-3 py-2.5 ${tri ? '@container' : ''} transition hover:border-line-strong ${state === 'crit' || state === 'warn' ? `border-l-[3px] ${st.border}` : ''} ${className}`
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>
}


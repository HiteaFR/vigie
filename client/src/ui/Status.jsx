import { stateOf } from '../lib/state.js'

// One shape per state: the state reads without color
function Shape({ state }) {
  switch (state) {
    case 'ok':
      return (<>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>)
    case 'warn':
      return (<>
        <path d="M8 1.2l7 12.6H1z" fill="currentColor" strokeLinejoin="round" />
        <path d="M8 6v3.6" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.7" r="1" fill="var(--surface)" />
      </>)
    case 'crit':
      return (<>
        <path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="currentColor" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
      </>)
    case 'maint':
      return (<>
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path d="M10.6 3.6a2.6 2.6 0 00-3.3 3.3L3.8 10.4l1.8 1.8 3.5-3.5a2.6 2.6 0 003.3-3.3l-1.5 1.5-1.5-.3-.3-1.5z" fill="var(--surface)" />
      </>)
    case 'info':
      return (<>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M8 7.2v4" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="4.8" r="1" fill="var(--surface)" />
      </>)
    case 'none':
      return (<>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6.2 9.8l3.6-3.6M7 5.6l.8-.8a2 2 0 012.8 2.8l-.8.8M9 10.4l-.8.8a2 2 0 01-2.8-2.8l.8-.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </>)
    default: // unknown
      return (<>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2" />
        <path d="M6.3 6.2a1.8 1.8 0 113 1.4c-.6.4-1.3.8-1.3 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r=".9" fill="currentColor" />
      </>)
  }
}

export function StatusDot({ state, size = 14, label, className = '' }) {
  const s = stateOf(state)
  return (
    <svg
      viewBox="0 0 16 16" width={size} height={size}
      className={`shrink-0 ${s.text} ${className}`}
      role="img" aria-label={label || s.label}
    >
      <title>{label || s.label}</title>
      <Shape state={state} />
    </svg>
  )
}

export function StatusBadge({ state, children, className = '' }) {
  const s = stateOf(state)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[var(--radius-chip)] px-1.5 py-0.5 text-2xs font-semibold ${s.bg} ${s.text} ${className}`}>
      <StatusDot state={state} size={12} label="" />
      {children ?? s.label}
    </span>
  )
}

// Version gap badge (Updates and the Cockpit tile)
import { ShieldAlert, Hourglass } from 'lucide-react'
import { displayGap } from '../lib/updates.js'
import { t } from '../i18n/index.js'

// displayed gap: patch neutral, minor blue, major amber, security / EOL red
const GAPS = {
  security: { get label() { return t('gap.security') }, Icon: ShieldAlert, cls: 'bg-crit-bg text-crit' },
  eol: { get label() { return t('gap.eol') }, Icon: Hourglass, cls: 'bg-crit-bg text-crit' },
  major: { get label() { return t('gap.major') }, sym: '▲', cls: 'bg-warn-bg text-warn' },
  minor: { get label() { return t('gap.minor') }, sym: '◆', cls: 'bg-info-bg text-info' },
  patch: { get label() { return t('gap.patch') }, sym: '●', cls: 'bg-surface-3 text-muted' },
  digest: { get label() { return t('gap.digest') }, sym: '◆', cls: 'bg-info-bg text-info' },
  deploy: { get label() { return t('gap.deploy') }, sym: '▲', cls: 'bg-warn-bg text-warn' },
  unknown: { get label() { return t('gap.unknown') }, sym: '?', cls: 'bg-unknown-bg text-unknown' },
  ahead: { get label() { return t('gap.ahead') }, sym: '↑', cls: 'bg-surface-3 text-muted' },
  same: { get label() { return t('gap.same') }, sym: '✓', cls: 'bg-ok-bg text-ok' },
  ignored: { get label() { return t('gap.ignored') }, sym: '–', cls: 'bg-surface-3 text-subtle' },
  error: { get label() { return t('gap.error') }, sym: '!', cls: 'bg-unknown-bg text-unknown' },
}

export default function GapBadge({ c, gap = displayGap(c) }) {
  const g = GAPS[gap] || GAPS.unknown
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-chip)] px-1.5 py-0.5 text-2xs font-semibold ${g.cls}`}>
      {g.Icon ? <g.Icon size={11} aria-hidden /> : <span aria-hidden>{g.sym}</span>}{g.label}
    </span>
  )
}

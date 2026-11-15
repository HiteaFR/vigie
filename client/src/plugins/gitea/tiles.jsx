// gitea plugin, cockpit tiles: CI indicator (indicator row) and "CI and runners" card (card
// row, not on the wall display).
import { GitBranch } from 'lucide-react'
import { useSource } from '../../api.js'
import { withEnv } from '../../nav.js'
import { StatusDot } from '../../ui/Status.jsx'
import Panel from '../../ui/Panel.jsx'
import TimeAgo from '../../ui/TimeAgo.jsx'
import Kpi, { card } from '../../ui/Kpi.jsx'
import { t } from '../../i18n/index.js'

// CI indicator: ci block of /api/summary (gitea plugin, server side); net: network tile present
export function CiKpi({ s, env, mural, net }) {
  const ci = s.ci
  return (
    // Gitea not configured → "not configured", neutral state (neither alert nor unknown)
    <Kpi mural={mural} icon={GitBranch} label="CI" value={ci.configured !== false && ci.runnersTotal != null ? `${ci.runnersOnline}/${ci.runnersTotal}` : '—'}
      sub={ci.configured === false ? t('gitea.tile_off') : ci.failing.length ? t('gitea.tile_failing', { list: ci.failing.map(f => f.name).join(', ') }) : ci.running ? t('gitea.tile_running', { count: ci.running }) : t('gitea.tile_ok')}
      state={ci.configured === false ? 'none' : ci.error ? 'unknown' : ci.runnersOnline < ci.runnersTotal ? 'crit' : ci.failing.length ? 'warn' : 'ok'} href={withEnv('/ci', env)}
      className={net ? '' : 'col-span-2 md:col-span-1'} />
  )
}

// CI: runners and latest runs
export function CiCard() {
  const runners = useSource('runners')
  const gitea = useSource('gitea')
  // Gitea not configured → the card says so instead of showing an empty list
  if (gitea.data?.configured === false) {
    return (
      <Panel icon={GitBranch} title={t('gitea.card_title')}>
        <div className={`${card} p-4 text-xs text-subtle`}>{t('gitea.off')}</div>
      </Panel>
    )
  }
  const runs = (Array.isArray(gitea.data) ? gitea.data : []).filter(r => r.lastRun).sort((a, b) => new Date(b.lastRun.date) - new Date(a.lastRun.date)).slice(0, 5)
  const RUN = { success: 'ok', failure: 'crit', cancelled: 'unknown', running: 'info', waiting: 'info' }
  return (
    <Panel icon={GitBranch} title={t('gitea.card_title')}>
      <div className={`${card} p-4`}>
        <div className="flex flex-wrap gap-1.5">
          {(Array.isArray(runners.data) ? runners.data : []).map(r => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-muted" title={r.busy ? t('gitea.busy') : r.status}>
              <StatusDot state={r.status === 'online' ? (r.busy ? 'info' : 'ok') : 'crit'} size={10} />
              {r.name.replace(/-runner$/, '')}
            </span>
          ))}
          {runners.error && <span className="text-2xs text-crit">{t('gitea.runners_unreadable')}</span>}
        </div>
        <ul className="mt-3 space-y-1">
          {runs.map(r => (
            <li key={r.name} className="flex items-center gap-2 text-xs">
              <StatusDot state={RUN[r.lastRun.status] || 'unknown'} size={11} label={r.lastRun.status} />
              <a href={r.lastRun.url} target="_blank" rel="noreferrer" className="truncate text-fg hover:underline">{r.name} #{r.lastRun.number}</a>
              <span className="ml-auto shrink-0 text-2xs text-subtle"><TimeAgo date={r.lastRun.date} /></span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

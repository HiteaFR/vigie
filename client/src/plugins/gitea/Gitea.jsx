import { GitCommitHorizontal, GitPullRequest } from 'lucide-react'
import { ago } from '../../lib/format.js'
import { StatusDot } from '../../ui/Status.jsx'
import { t } from '../../i18n/index.js'

export default function Gitea({ data }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.map(r => (
        <a
          key={r.name}
          href={r.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-4 hover:border-line-strong hover:bg-surface-2 transition"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="font-medium text-sm text-fg truncate min-w-0">{r.name}</span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              {r.lastRun && <CiBadge run={r.lastRun} />}
              {r.openPRs > 0 && (
                <span className="flex items-center gap-1 text-2xs text-warn border border-warn/30 bg-warn-bg rounded px-1.5 py-0.5">
                  <GitPullRequest size={11} aria-hidden /> {r.openPRs} PR
                </span>
              )}
            </div>
          </div>
          {r.error ? (
            <div className="text-xs text-subtle">{t('gitea.unavailable')}</div>
          ) : r.lastCommit ? (
            <div className="flex items-start gap-2 text-xs text-muted">
              <GitCommitHorizontal size={14} className="text-subtle mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0">
                <div className="text-fg/80 truncate">{r.lastCommit.message}</div>
                <div className="text-subtle truncate">
                  <span className="font-mono">{r.lastCommit.sha}</span> · {r.lastCommit.author} · {ago(r.lastCommit.date)}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-subtle">{t('gitea.no_commit')}</div>
          )}
        </a>
      ))}
    </div>
  )
}

const RUN = {
  success: ['ok', 'text-ok', ''],
  failure: ['crit', 'text-crit', ''],
  running: ['warn', 'text-warn', 'animate-pulse'],
  waiting: ['warn', 'text-warn', 'animate-pulse'],
}

function CiBadge({ run }) {
  const [state, txt, anim] = RUN[run.status] || ['unknown', 'text-subtle', '']
  return (
    <span
      title={`CI run #${run.number} · ${run.status}${run.title ? ' · ' + run.title : ''}${run.date ? ' · ' + ago(run.date) : ''}`}
      className={`flex items-center gap-1 text-2xs ${txt}`}
    >
      <StatusDot state={state} size={11} label={`CI ${run.status}`} className={anim} /> CI #{run.number}
    </span>
  )
}

import { useState } from 'react'
import { PackageCheck, Search, X, ExternalLink, ChevronRight, Bot, ShieldAlert, AlertTriangle } from 'lucide-react'
import { useSource } from '../api.js'
import { useAdmin, Modal, ReasonForm, field, btnGhost } from '../admin.jsx'
import { useEnv, matchEnv, useUrlParam } from '../hooks/useUrlState.js'
import Panel, { Skeleton } from '../ui/Panel.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import TimeAgo from '../ui/TimeAgo.jsx'
// pure rules in lib/updates.js
import { displayGap, actionable } from '../lib/updates.js'
import GapBadge from '../components/GapBadge.jsx'
import { AutoUpdateBadge, AutoUpdateInfo, AutoUpdateSummary } from '../components/AutoUpdate.jsx'
import { localeTag, t, tLabels } from '../i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'

const KIND = tLabels('updates.kind', ['app', 'docker', 'os', 'pve', 'ha', 'runtime', 'apt', 'deploy'])

// filters (chips): a component may belong to several
// label updates.filter.<id>, read at render time
const FILTERS = ['security', 'major', 'minor', 'patch', 'digest', 'deploy', 'auto', 'ignored', 'same', 'error'].map(k => [k])
function inFilter(c, f) {
  const g = displayGap(c)
  switch (f) {
    case 'security': return !c.ignored && (g === 'security' || g === 'eol' || c.eol?.soon)
    case 'auto': return c.auto && c.gap !== 'same'
    case 'ignored': return !!c.ignored
    case 'error': return !!c.error
    case 'same': return !c.ignored && c.gap === 'same' && !c.eol?.passed && !c.error
    default: return !c.ignored && c.gap === f
  }
}
// default view: everything that needs an action (neither up to date nor ignored)

const fmtDate = d => new Date(d).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' })

// release notes: 30 lines, keywords highlighted
function Notes({ text }) {
  const lines = text.split('\n').slice(0, 30)
  const hl = l => l.split(/(\bBREAKING\b|\bbreaking\b|\bsecurity\b|\bSecurity\b|\bCVE-\d{4}-\d+|\bGHSA-[\w-]+)/).map((p, i) => (i % 2
    ? <mark key={i} className={`rounded px-0.5 ${/break/i.test(p) ? 'bg-warn-bg text-warn' : 'bg-crit-bg text-crit'}`}>{p}</mark>
    : p))
  return (
    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-2xs leading-relaxed text-muted">
      {lines.map((l, i) => <span key={i}>{hl(l)}{'\n'}</span>)}
      {text.split('\n').length > 30 && <span className="text-subtle">…</span>}
    </pre>
  )
}

function Versions({ c }) {
  if (c.kind === 'apt') return <span className="font-mono text-xs text-fg">{c.current}</span>
  const cur = c.kind === 'deploy' ? `run ${c.current}` : c.current
  const lat = c.kind === 'deploy' ? `HEAD ${c.latest}` : c.latest
  const showLatest = c.latest && c.latest !== c.current && c.gap !== 'same'
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-xs">
      <span className="text-muted truncate" title={c.current}>{cur ?? '—'}</span>
      {showLatest && <>
        <span className="text-subtle" aria-hidden>→</span>
        {c.url
          ? <a href={c.url} target="_blank" rel="noreferrer" className="truncate font-semibold text-fg hover:underline" title={t('updates.notes_of', { v: c.latest })}>{lat}</a>
          : <span className="truncate font-semibold text-fg">{lat}</span>}
      </>}
    </span>
  )
}

// decisions from the UI (reason required); those from config.json stay read only
const MODE_LABEL = tLabels('updates.mode', ['version', 'until', 'pin', 'all'])

function Decisions({ c }) {
  const { act, isAdmin, requireLogin } = useAdmin()
  const [mode, setMode] = useState(null)
  const [date, setDate] = useState(() => new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10))
  const guard = fn => () => (isAdmin ? fn() : requireLogin(fn))
  const d = c.ignored || c.pinned
  if (d?.source === 'config') return <p className="mt-2 text-2xs text-subtle">{t('updates.decision_config_json_updates')}</p>
  if (d?.source === 'ui' && d.decisionId) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-subtle">
        <span>{t('updates.ui_decision')}{d.reason ? t('common.suffix', { v: d.reason }) : ''}</span>
        <button type="button" className={btnGhost} onClick={guard(() => act('/api/updates/decisions/remove', { decisionId: d.decisionId }, { invalidate: ['updates'], success: t('updates.decision_lifted') }))}>{t('updates.lift')}</button>
      </div>
    )
  }
  // apt packages of a host: only postpone or ignore (no single version)
  const modes = c.kind === 'apt' ? ['until', 'all'] : [
    ...(c.latest && c.gap !== 'same' ? ['version'] : []),
    'until',
    ...(c.gap === 'major' && c.latestSameMajor !== undefined ? ['pin'] : []),
    'all',
  ]
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {modes.map(m => (
        <button key={m} type="button" className={btnGhost} onClick={guard(() => setMode(m))}>
          {m === 'version' ? t('updates.ignore_v', { v: c.latest }) : MODE_LABEL[m]}
        </button>
      ))}
      <Modal open={!!mode} onClose={() => setMode(null)} title={`${mode ? MODE_LABEL[mode] : ''} · ${c.name}`}>
        <ReasonForm submitLabel={t('updates.save')} onCancel={() => setMode(null)} placeholder={t('updates.example_wait_first_fix')} onSubmit={async reason => {
          await act('/api/updates/decisions', { compId: c.id, mode, version: c.latest, until: date, reason }, { invalidate: ['updates'], success: t('updates.decision_saved') })
          setMode(null)
        }}>
          {mode === 'version' && <p className="text-xs text-muted">{t('updates.version_hint', { v: c.latest })}</p>}
          {mode === 'pin' && <p className="text-xs text-muted">{t('updates.only_versions_same_major')}</p>}
          {mode === 'all' && <p className="text-xs text-warn">{c.kind === 'apt' ? t('updates.packages_host_no_longer') : t('updates.component_no_longer_reported')}</p>}
          {mode === 'until' && c.kind === 'apt' && <p className="text-xs text-muted">{t('updates.host_packages_security')}</p>}
          {mode === 'until' && (
            <label className="block text-xs text-muted">{t('updates.until')}
              <input type="date" value={date} min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)} onChange={e => setDate(e.target.value)} className={`${field} mt-1`} />
            </label>
          )}
        </ReasonForm>
      </Modal>
    </div>
  )
}

function Row({ c, onHost }) {
  const [open, setOpen] = useState(false)
  const g = displayGap(c)
  const flags = []
  // state of the host's automatic security updates
  if (c.kind === 'apt' && c.apt?.autoUpdate) flags.push(<AutoUpdateBadge key="au" s={c.apt.autoUpdate} />)
  if (c.auto) flags.push(<span key="auto" className="inline-flex items-center gap-0.5 rounded border border-line px-1 text-2xs text-subtle" title={t('updates.updates_itself_automatically_config')}><Bot size={10} aria-hidden />{t('updates.auto_flag')}</span>)
  if (c.skipped > 1) flags.push(<span key="sk" className="text-2xs text-subtle">{t('updates.skipped', { count: c.skipped })}{c.breaking ? t('updates.breaking', { count: c.breaking }) : ''}</span>)
  if (c.eol?.date) flags.push(<span key="eol" className={`text-2xs ${c.eol.passed ? 'text-crit' : c.eol.soon ? 'text-warn' : 'text-subtle'}`}>{t(c.eol.passed ? 'updates.eol_since' : 'updates.eol_on', { date: fmtDate(c.eol.date) })}</span>)
  if (c.nextMajor) flags.push(<span key="nm" className="text-2xs text-subtle">{t('updates.next_major', { v: c.kind === 'os' ? `${c.name} ${c.nextMajor}` : c.nextMajor })}</span>)
  if (c.pinned) flags.push(<span key="pin" className="text-2xs text-subtle" title={c.pinned.reason || ''}>{c.pinned.hidden != null ? t('updates.pinned', { major: c.pinned.hidden }) : t('updates.pinned_unknown')}</span>)
  if (c.ignored) flags.push(<span key="ign" className="text-2xs text-subtle" title={c.ignored.reason || ''}>{t('updates.ignored')}{c.ignored.until ? t('updates.until_suffix', { date: fmtDate(c.ignored.until) }) : ''}{c.ignored.reason ? ` · ${c.ignored.reason}` : ''}</span>)
  const expandable = c.notes || c.detail || c.error || c.security || c.kind === 'apt' || actionable(c) || c.ignored || c.pinned
  return (
    <li className={`${card} ${g === 'security' || g === 'eol' ? 'border-l-[3px] border-l-crit' : g === 'major' || g === 'deploy' ? 'border-l-[3px] border-l-warn' : ''}`}>
      <div className="flex flex-col gap-1.5 px-3 py-2.5 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.8fr)_7rem] md:items-center md:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={() => setOpen(o => !o)} disabled={!expandable} aria-expanded={open} aria-label={t('infra.detail_of', { name: c.name })}
            className={`shrink-0 rounded p-0.5 text-subtle ${expandable ? 'hover:bg-surface-3 hover:text-fg' : 'invisible'}`}>
            <ChevronRight size={14} className={`transition ${open ? 'rotate-90' : ''}`} aria-hidden />
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg" title={c.name}>{c.name}</div>
            <div className="text-2xs text-subtle">{KIND[c.kind] || c.kind}{c.env === 'dev' ? ' · dev' : ''}</div>
          </div>
        </div>
        <div className="min-w-0 pl-7 text-xs text-muted md:pl-0">
          {onHost ? <button type="button" onClick={onHost} className="truncate text-left hover:text-fg hover:underline" title={t('updates.host_details')}>{c.where}</button> : <span className="truncate">{c.where || '—'}</span>}
        </div>
        <div className="min-w-0 pl-7 md:pl-0">
          <Versions c={c} />
          {flags.length > 0 && <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">{flags}</div>}
        </div>
        <div className="flex items-center gap-2 pl-7 md:flex-col md:items-end md:gap-0.5 md:pl-0">
          <GapBadge c={c} gap={g} />
          {c.publishedAt && c.gap !== 'same' && <span className="text-2xs text-subtle"><TimeAgo date={c.publishedAt} /></span>}
        </div>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-2.5 text-xs text-muted">
          {c.error && <p className="text-unknown">{t('updates.read_error', { err: c.error })}</p>}
          {c.security && c.kind !== 'apt' && <p className="text-crit">{t('updates.security_fix')}{c.cve ? t('common.suffix', { v: c.cve }) : ''}{c.securityIn ? t('updates.security_in', { v: c.securityIn }) : ''}</p>}
          {c.detail && <p>{c.detail}</p>}
          {c.kind === 'apt' && c.apt?.autoUpdate && <div className="my-1"><AutoUpdateInfo s={c.apt.autoUpdate} /></div>}
          {c.kind === 'apt' && onHost && <p><button type="button" onClick={onHost} className="text-accent hover:underline">{t('updates.see_host_packages')}</button></p>}
          {c.notes && <Notes text={c.notes} />}
          {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">{t('updates.release_notes')} <ExternalLink size={11} aria-hidden /></a>}
          {c.kind !== 'deploy' && (c.kind !== 'apt' || c.gap !== 'same' || c.ignored) && <Decisions c={c} />}
        </div>
      )}
    </li>
  )
}

export default function Updates() {
  const q = useSource('updates')
  const agents = useSource('agents')
  const [env] = useEnv()
  const [text, setText] = useUrlParam('q')
  const [f, setF] = useUrlParam('f')
  const [, setHost] = useUrlParam('h')
  const all = (q.data?.components || []).filter(c => matchEnv(env, c.env))
  const agentHosts = new Set((agents.data?.hosts || []).filter(h => h.agent).map(h => h.id))
  const onHost = c => (c.host && agentHosts.has(c.host) ? () => setHost(c.host) : null)
  const needle = text.trim().toLowerCase()
  const list = all
    .filter(c => (f ? inFilter(c, f) : actionable(c)))
    .filter(c => !needle || [c.name, c.where, c.current, c.latest, c.id, KIND[c.kind]].some(x => String(x ?? '').toLowerCase().includes(needle)))
  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, all.filter(c => inFilter(c, k)).length]))
  const st = q.data?.stats
  const failing = q.data?.sources || []
  // one "automatic updates" state per host with an agent (apt packages), up to date included
  const names = new Map((agents.data?.hosts || []).map(h => [h.id, h.name]))
  const autoHosts = all.filter(c => c.kind === 'apt').map(c => ({ id: c.host, name: names.get(c.host) ?? c.where ?? c.host, s: c.apt?.autoUpdate ?? null }))

  return (
    <Panel icon={PackageCheck} title={t('updates.updates')} query={q} skeleton={<Skeleton count={6} h="h-14" cols="" />}
      right={q.data?.checkedAt && <span className="text-2xs text-subtle">{t('updates.checked')} <TimeAgo date={q.data.checkedAt} /></span>}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] max-w-sm flex-1">
          <span className="sr-only">{t('updates.filter_components')}</span>
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
          <input value={text} onChange={e => setText(e.target.value)} placeholder={t('updates.filter_name_host_version')}
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-8 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none" />
          {text && (
            <button type="button" onClick={() => setText('')} aria-label={t('updates.clear_filter')} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
              <X size={14} aria-hidden />
            </button>
          )}
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('updates.filter_gap')}>
          {FILTERS.filter(([k]) => counts[k] || f === k || ['security', 'major', 'minor', 'patch'].includes(k)).map(([k]) => (
            <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(f === k ? '' : k)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${f === k ? 'border-accent bg-surface-3 text-fg' : 'border-line text-muted hover:border-line-strong'}`}>
              {t(`updates.filter.${k}`)}<span className="tabular-nums opacity-80">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {failing.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-warn-bg px-3 py-2 text-xs text-warn">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>{t('updates.sources_failing', { list: failing.map(s => `${s.source} — ${s.msg}`).join(' · ') })}</span>
        </div>
      )}

      <AutoUpdateSummary hosts={autoHosts} onHost={id => (agentHosts.has(id) ? setHost(id) : null)} />

      {list.length === 0
        ? (f || needle
          ? <EmptyState icon={Search} title={t('updates.no_components_match_filter')} />
          : <EmptyState icon={PackageCheck} title={t('updates.everything_up_date')} hint={q.data?.checkedAt ? t('updates.tracked', { count: all.length }) : t('updates.first_check')} />)
        : (
          <>
            <div className="mb-1.5 hidden px-3 text-2xs font-medium uppercase tracking-wider text-subtle md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.8fr)_7rem] md:gap-3">
              <span className="pl-7">{t('updates.component')}</span><span>{t('updates.where')}</span><span>{t('updates.installed_latest')}</span><span className="text-right">{t('updates.gap')}</span>
            </div>
            <ul className="space-y-1.5">{list.map(c => <Row key={c.id} c={c} onHost={onHost(c)} />)}</ul>
          </>
        )}

      {st && (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
          <span><ShieldAlert size={11} className="mr-1 inline" aria-hidden />{t('updates.info_only')}</span>
          <span>{t('updates.stats', { count: all.length, req: st.requests, nm: st.notModified, gh: st.githubAuth ? t('updates.gh_token') : t('updates.gh_no_token') })}</span>
        </p>
      )}
    </Panel>
  )
}

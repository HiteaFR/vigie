import { CalendarClock, Ghost, ShieldOff } from 'lucide-react'
import { ago, bytes } from '../lib/format.js'
import { StatusDot } from '../ui/Status.jsx'
import { ErrorBox, Skeleton } from '../ui/Panel.jsx'
import { localeTag, t, tLabels } from '../i18n/index.js'

// Job schedule (/cluster/backup), guests × 7 days matrix built from the vzdump logs, guests
// outside any job, orphaned backups.
const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
const DAYS = 7
const MOBILE_HIDDEN = 3 // oldest days hidden under 640 px
const dayCls = i => (i < MOBILE_HIDDEN ? 'hidden sm:table-cell' : '')

// ok < 36 h, degraded < 72 h, critical beyond; unknown if there is no backup
function freshness(last) {
  if (!last) return { state: 'unknown', label: t('backups.none') }
  const h = (Date.now() - last * 1000) / 3600000
  const state = h < 36 ? 'ok' : h < 72 ? 'warn' : 'crit'
  return { state, label: ago(last * 1000) }
}

const TEXT = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit', unknown: 'text-subtle' }

const SOURCE = tLabels('backups.source', ['storage', 'tasks'])

const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const hm = ts => new Date(ts * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })

// "tonight 21:00", "tomorrow 21:00", otherwise the date
function when(ts) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86400_000)
  if (dayKey(d) === dayKey(today)) return t(d.getHours() >= 18 ? 'backups.tonight' : 'backups.today', { time: hm(ts) })
  if (dayKey(d) === dayKey(tomorrow)) return t('backups.tomorrow', { time: hm(ts) })
  return d.toLocaleString(localeTag(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function Jobs({ jobs, guests }) {
  if (jobs === null) return <p className="text-2xs text-subtle">{t('backups.schedule_unreadable_sys_audit')}</p>
  if (!jobs.length) return <p className="text-xs text-warn">{t('backups.no_backup_job_scheduled')}</p>
  const name = id => guests.find(g => g.vmid === id)?.name ?? id
  return (
    <ul className="space-y-1">
      {jobs.map(j => (
        <li key={j.id} className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs ${j.enabled ? 'text-muted' : 'text-subtle line-through'}`}>
          <CalendarClock size={13} className="text-accent" aria-hidden />
          <span className="font-medium text-fg">{j.schedule}</span>
          <span>{j.all ? t('backups.all_guests') : t('backups.some_guests', { count: j.vmid.length, list: j.vmid.map(name).join(', ') })}{j.exclude.length ? t('backups.except', { list: j.exclude.map(name).join(', ') }) : ''}</span>
          <span>→ <span className="font-mono">{j.storage}</span> · {j.mode}</span>
          {j.enabled && j.nextRun && <span className="text-fg">{t('backups.next_run', { when: when(j.nextRun) })}</span>}
          {!j.enabled && <span>{t('backups.disabled')}</span>}
        </li>
      ))}
    </ul>
  )
}

// a day's cell: last run of the day for this guest
function cellOf(runs, key) {
  const day = (runs || []).filter(r => dayKey(new Date(r.t * 1000)) === key).sort((a, b) => b.t - a.t)
  return day[0] ?? null
}

function Matrix({ entry, guests }) {
  const byVmid = new Map(entry.items.map(b => [b.vmid, b]))
  const cover = new Map((entry.coverage || []).map(c => [c.vmid, c]))
  const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.now() - (DAYS - 1 - i) * 86400_000))
  const next = (entry.jobs || []).filter(j => j.enabled && j.nextRun).map(j => j.nextRun).sort()[0]
  const todayPending = next && dayKey(new Date(next * 1000)) === dayKey(new Date())
  const rows = [...guests].sort((a, b) => a.vmid - b.vmid)
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className="w-full text-xs sm:min-w-[34rem]">
        <thead>
          <tr className="border-b border-line text-2xs text-subtle">
            <th className="px-3 py-2 text-left font-normal">{t('backups.guest')}</th>
            {days.map((d, i) => (
              <th key={i} className={`w-9 px-0.5 py-2 text-center font-normal tabular-nums ${dayCls(i)}`} title={d.toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })}>
                {i === DAYS - 1 ? t('backups.today_short') : d.toLocaleDateString(localeTag(), { weekday: 'narrow' }) + d.getDate()}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-normal">{t('backups.last')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(g => {
            const b = byVmid.get(g.vmid)
            const f = b?.failed ? { state: 'crit', label: t('backups.last_run_failed') } : freshness(b?.last)
            const c = cover.get(g.vmid)
            return (
              <tr key={`${g.type}-${g.vmid}`}>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-fg">{g.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-subtle">{g.type === 'lxc' ? 'CT' : 'VM'} {g.vmid}</span>
                    {c?.covered === false && <span className="shrink-0 rounded border border-warn px-1 text-2xs text-warn">{c.excluded ? t('backups.excluded') : t('backups.outside_job')}</span>}
                  </div>
                </td>
                {days.map((d, i) => {
                  const r = cellOf(entry.runs?.[g.vmid], dayKey(d))
                  const today = i === DAYS - 1
                  const state = r ? (r.ok ? 'ok' : 'crit') : today && todayPending ? 'pending' : 'none'
                  const label = r ? t(r.ok ? 'backups.cell_ok' : 'backups.cell_failed', { time: hm(r.t) }) : state === 'pending' ? t('backups.cell_planned', { when: when(next) }) : t('backups.cell_none')
                  return (
                    <td key={i} className={`px-0.5 py-1.5 text-center ${dayCls(i)}`}>
                      {state === 'ok' || state === 'crit'
                        ? <StatusDot state={state} size={13} label={label} className="mx-auto" />
                        : <span className={`mx-auto block h-3 w-3 rounded-full border ${state === 'pending' ? 'border-dashed border-accent' : 'border-line'}`} title={label} aria-label={label} role="img" />}
                    </td>
                  )
                })}
                <td className={`whitespace-nowrap px-3 py-1.5 text-right ${TEXT[f.state]}`}>
                  {f.label}{b?.count ? <span className="hidden text-2xs text-subtle sm:inline" title={entry.mode === 'storage' ? t('backups.archives_storage') : t('backups.successful_runs_logs')}> · {b.count}</span> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Orphans({ list, storage }) {
  if (list === null) return null
  if (!list.length) return <p className="text-2xs text-subtle">{t('backups.no_orphans', { storage })}</p>
  const total = list.reduce((a, o) => a + o.size, 0)
  return (
    <div>
      <div className="mb-2 flex gap-2 text-xs text-muted">
        <Ghost size={13} className="mt-0.5 shrink-0" aria-hidden />
        <div>
          <span className="text-warn">{t('backups.gone', { count: list.length })}</span>{t('backups.still_have', { count: list.length })}<span className="font-mono">{storage}</span>{t('common.suffix', { v: bytes(total) })}
          <div className="text-2xs text-subtle">{t('backups.never_pruned_job_retention')}</div>
        </div>
      </div>
      <ul className={`${card} divide-y divide-line`}>
        {list.map(o => (
          <li key={o.vmid} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs">
            <span className="font-mono text-subtle">{o.type === 'lxc' ? 'CT' : o.type === 'qemu' ? 'VM' : ''} {o.vmid}</span>
            <span className="text-fg">{o.name || t('backups.no_name')}</span>
            <span className="ml-auto text-muted">{t('backups.orphan_line', { count: o.count, size: bytes(o.size), ago: ago(o.last * 1000) })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function Backups({ data, clusters }) {
  return (
    <div className="space-y-8">
      {data.map(b => {
        const c = clusters?.find(x => x.id === b.id)
        const uncovered = (b.coverage || []).filter(x => x.covered === false)
        return (
          <div key={b.id} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-fg">{b.label}</h3>
              {b.mode && <span className="text-2xs text-subtle">{t('backups.source_line', { src: SOURCE[b.mode] || b.mode })}</span>}
            </div>
            {b.error ? <ErrorBox prefix={t('backups.backups_unreadable')} msg={b.error} />
              : !c?.guests ? (c?.error ? <ErrorBox prefix={t('backups.proxmox_unreachable')} msg={c.error} /> : <Skeleton />)
                : (
                  <>
                    <Jobs jobs={b.jobs} guests={c.guests} />
                    {uncovered.length > 0 && (
                      <p className="flex items-center gap-1.5 text-xs text-warn">
                        <ShieldOff size={13} aria-hidden />
                        {t('backups.uncovered', { list: uncovered.map(x => `${x.name} (${x.vmid})${x.excluded ? t('backups.excluded_suffix') : ''}`).join(', ') })}
                      </p>
                    )}
                    <Matrix entry={b} guests={c.guests} />
                    <Orphans list={b.orphans} storage={b.storage} />
                  </>
                )}
          </div>
        )
      })}
    </div>
  )
}

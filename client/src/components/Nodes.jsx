import { useState } from 'react'
import { HardDrive, ListX, BellRing, Cpu } from 'lucide-react'
import { pct, bytes, uptime } from '../lib/format.js'
import Gauge from '../ui/Gauge.jsx'
import { StatusDot } from '../ui/Status.jsx'
import { localeTag, numberFormat, t, tLabels } from '../i18n/index.js'

// Proxmox nodes (version, kernel, load, memory excluding cache, swap, rootfs), disks (SMART,
// wear), failed tasks and PVE notifications.
const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
const n0 = numberFormat({ maximumFractionDigits: 0 })
const n1 = numberFormat({ maximumFractionDigits: 1 })

const smartOk = h => h == null || /^(PASSED|OK)$/i.test(h)

function diskState(d) {
  if (!smartOk(d.health)) return 'crit'
  if ((d.wearout != null && d.wearout <= 10) || d.reallocated || d.pending || d.mediaErrors || d.criticalWarning) return 'warn'
  return d.health ? 'ok' : 'unknown'
}

function Node({ n, res }) {
  if (n.error) return <div className={`${card} px-4 py-3 text-xs text-crit`}>{n.node}{t('common.suffix', { v: n.error })}</div>
  const memUsed = n.mem.total ? n.mem.total - (n.mem.available ?? n.mem.total - n.mem.used) : 0
  return (
    <div className={`${card} p-4`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-semibold text-fg">{n.node}</span>
        <span className="text-2xs text-muted">{t('nodes.pve_kernel', { v: n.pveVersion, k: n.kernel })}</span>
        <span className="text-2xs text-subtle">uptime {uptime(n.uptime)}</span>
      </div>
      <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {res && <Gauge value={pct(res.cpu, 1)} label={t('nodes.cpu', { n: n.cpus, load: n.load.map(x => n1.format(x)).join(' ') })} />}
        <Gauge value={pct(memUsed, n.mem.total)} warn={90} crit={95} label={t('nodes.ram', { used: bytes(memUsed), total: bytes(n.mem.total) })} />
        {n.swap.total > 0 && <Gauge value={pct(n.swap.used, n.swap.total)} warn={50} crit={80} label={`Swap · ${bytes(n.swap.used)} / ${bytes(n.swap.total)}`} />}
        {n.rootfs.total > 0 && <Gauge value={pct(n.rootfs.used, n.rootfs.total)} warn={80} crit={90} label={t('nodes.rootfs', { used: bytes(n.rootfs.used), total: bytes(n.rootfs.total) })} />}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xs text-subtle">
        <Cpu size={11} aria-hidden /> {n.cpuModel}{n.iowait != null ? t('nodes.iowait', { v: n1.format(n.iowait * 100) }) : ''}
      </div>
    </div>
  )
}

function Disks({ list, error }) {
  if (error) return <p className="text-xs text-warn">{t('nodes.disks_error', { err: error })}</p>
  if (!list?.length) return null
  return (
    <ul className={`${card} divide-y divide-line`}>
      {list.map(d => {
        const st = diskState(d)
        const used = d.wearout != null ? 100 - d.wearout : null
        const notes = [
          d.temp != null ? `${d.temp} °C` : null,
          d.powerOnHours != null ? `${n0.format(d.powerOnHours)} h` : null,
          d.reallocated ? t('nodes.reallocated', { n: d.reallocated }) : null,
          d.pending ? t('nodes.pending', { n: d.pending }) : null,
          d.mediaErrors ? t('nodes.media_errors', { n: d.mediaErrors }) : null,
        ].filter(Boolean)
        return (
          <li key={`${d.node}${d.devpath}`} className="grid gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <div className="flex min-w-0 items-center gap-2.5">
              <StatusDot state={st} size={13} label={d.smartError ? t('nodes.smart_error', { err: d.smartError }) : `SMART ${d.health || t('nodes.unknown')}`} />
              <div className="min-w-0">
                <div className="truncate text-sm text-fg" title={d.model}>{d.model || d.devpath}</div>
                <div className="truncate text-2xs text-subtle">
                  <span className="font-mono">{d.devpath}</span> · {d.type?.toUpperCase()} · {bytes(d.size)}
                  {d.used ? ` · ${d.used}` : ''}{notes.length ? ` · ${notes.join(' · ')}` : ''}
                </div>
              </div>
            </div>
            <div className="self-center">
              {used != null
                ? <Gauge value={used} warn={80} crit={90} label={t('nodes.wear', { n: d.wearout })} />
                : <span className="text-2xs text-subtle">{d.type === 'hdd' ? t('nodes.hard_disk_no_wear') : t('nodes.wear_unknown')}</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const TASK_LABEL = tLabels('nodes.task', ['qmstart', 'qmstop', 'qmshutdown', 'qmreboot', 'vzstart', 'vzstop', 'vzdump', 'aptupdate', 'vzcreate', 'qmcreate'])

function Tasks({ list, days, error }) {
  const [open, setOpen] = useState(false)
  if (error) return <p className="text-xs text-warn">{t('nodes.tasks_error', { err: error })}</p>
  if (!list) return null
  const errors = list.filter(tk => tk.level === 'error').length
  return (
    <div className={`${card} px-3 py-2`}>
      <button type="button" onClick={() => setOpen(o => !o)} disabled={!list.length}
        className="flex w-full items-center gap-2 text-left text-xs text-muted disabled:cursor-default">
        <ListX size={13} aria-hidden />
        {list.length
          ? <span><span className={errors ? 'text-crit' : 'text-warn'}>{t('nodes.tasks_failing', { count: list.length })}</span>{t('nodes.over_days', { n: days })}{errors ? t('nodes.in_error', { count: errors }) : ''}</span>
          : <span>{t('nodes.no_task', { n: days })}</span>}
        {list.length > 0 && <span className="ml-auto text-2xs text-accent">{open ? t('nodes.hide') : t('nodes.show')}</span>}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-2xs">
          {list.map(tk => (
            <li key={`${tk.node}-${tk.start}-${tk.type}-${tk.id}`} className="flex gap-2">
              <StatusDot state={tk.level === 'error' ? 'crit' : 'warn'} size={11} />
              <span className="shrink-0 tabular-nums text-subtle">{new Date(tk.start * 1000).toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="shrink-0 text-fg">{TASK_LABEL[tk.type] || tk.type}{tk.id ? ` ${tk.id}` : ''}</span>
              <span className="truncate text-muted" title={tk.status}>{tk.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// where Proxmox's native notifications go (backup failure, SMART…)
function Notifications({ n, error }) {
  if (error) return <p className="text-2xs text-subtle">{t('nodes.notif_error', { err: error })}</p>
  if (!n) return null
  const active = n.targets.filter(t => !t.disabled)
  const onlyMail = active.length > 0 && active.every(tk => tk.type === 'sendmail')
  return (
    <p className="flex items-start gap-1.5 text-2xs text-muted">
      <BellRing size={12} className="mt-px shrink-0" aria-hidden />
      <span>
        {t('nodes.notif', { list: active.length ? active.map(tk => `${tk.name} (${tk.type})`).join(', ') : t('nodes.no_target') })}
        {onlyMail && <span className="text-subtle">{t('nodes.mail_hint')}</span>}
      </span>
    </p>
  )
}

export default function Nodes({ px, cluster }) {
  if (!px) return null
  return (
    <div className="mb-4 space-y-3">
      {px.nodesError
        ? <p className="text-xs text-warn">{t('nodes.nodes_error', { err: px.nodesError })}</p>
        : (px.nodes || []).map(n => <Node key={n.node} n={n} res={cluster?.nodes?.find(x => x.name === n.node)} />)}
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs text-muted"><HardDrive size={13} aria-hidden /> {t('nodes.disks')}</div>
        <Disks list={px.disks} error={px.disksError} />
      </div>
      <Tasks list={px.tasks} days={px.tasksDays} error={px.tasksError} />
      <Notifications n={px.notifications} error={px.notificationsError} />
    </div>
  )
}

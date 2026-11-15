import { Box, Container, HardDrive, Cog, Package, RotateCw } from 'lucide-react'
import { pct, bytes, uptime } from '../lib/format.js'
import Gauge from '../ui/Gauge.jsx'
import { StatusDot } from '../ui/Status.jsx'
import { ErrorBox } from '../ui/Panel.jsx'
import { useUrlParam } from '../hooks/useUrlState.js'
import { agentSummary, fsPct } from '../lib/agent.js'
import Nodes from './Nodes.jsx'
import { t } from '../i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'

// what the dash-report agent reports, as one row of badges
function AgentLine({ a }) {
  const s = agentSummary(a)
  if (s.state === 'none') return <div className="text-2xs text-subtle">{t('infra.not_instrumented')}</div>
  if (s.error) return <div className="text-2xs text-warn truncate" title={s.label}>{t('infra.agent', { label: s.label })}</div>
  const chip = 'inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5'
  return (
    <div className="flex flex-wrap gap-1.5 text-2xs text-muted">
      {s.containers && (
        <span className={`${chip} ${s.containers.unhealthy || s.containers.restarting ? 'border-crit text-crit' : ''}`} title={t('infra.running_containers_total')}>
          <Container size={11} aria-hidden /> {s.containers.running}/{s.containers.total}
          {s.containers.unhealthy ? t('infra.unhealthy', { count: s.containers.unhealthy }) : ''}
        </span>
      )}
      {s.failedUnits.length > 0 && (
        <span className={`${chip} border-warn text-warn`} title={s.failedUnits.join(', ')}><Cog size={11} aria-hidden /> {t('infra.units', { count: s.failedUnits.length })}</span>
      )}
      {s.apt && (
        <span className={`${chip} ${s.aptAgeDays > 7 ? 'border-warn text-warn' : ''}`} title={s.aptAgeDays > 7 ? t('infra.apt_age', { d: Math.floor(s.aptAgeDays) }) : t('infra.apt_updates')}>
          <Package size={11} aria-hidden /> {s.apt.upgradable}{s.apt.security ? t('infra.apt_security', { count: s.apt.security }) : ''}{s.aptAgeDays > 7 ? t('infra.apt_lists', { d: Math.floor(s.aptAgeDays) }) : ''}
        </span>
      )}
      {s.reboot && <span className={`${chip} text-info`} title={s.reboot}><RotateCw size={11} aria-hidden /> reboot</span>}
    </div>
  )
}

function Guest({ g, a }) {
  const up = g.status === 'running'
  const Icon = g.type === 'lxc' ? Container : Box
  const [, setHost] = useUrlParam('h')
  const root = a?.fast && a.ok ? a.fast.fs.find(f => f.mount === '/') : null
  const body = (
    <>
      <div className="flex items-center gap-2 mb-3">
        <StatusDot state={up ? 'ok' : 'unknown'} size={13} label={up ? t('infra.running') : t('infra.stopped')} />
        <Icon size={15} className="text-subtle" aria-hidden />
        <span className="font-medium text-sm text-fg truncate">{g.name}</span>
        <span className="ml-auto shrink-0 text-2xs font-mono uppercase text-subtle border border-line rounded px-1.5 py-0.5">
          {g.type === 'lxc' ? 'CT' : 'VM'} {g.vmid}
        </span>
      </div>
      {up ? (
        <div className="space-y-2">
          <Gauge value={pct(g.cpu, 1)} label={`CPU · ${g.maxcpu} vCPU`} />
          <Gauge value={pct(g.mem, g.maxmem)} label={`RAM · ${bytes(g.mem)} / ${bytes(g.maxmem)}`} />
          {g.disk > 0
            ? <Gauge value={pct(g.disk, g.maxdisk)} label={t('infra.disk', { used: bytes(g.disk), total: bytes(g.maxdisk) })} />
            : root
              ? <Gauge value={Math.round(fsPct(root))} warn={85} crit={95} label={t('infra.disk_root', { used: bytes(root.used), total: bytes(root.used + root.avail) })} />
              : <div className="text-2xs text-subtle">{t('infra.disk_noagent', { total: bytes(g.maxdisk) })}</div>}
          <div className="text-2xs text-subtle pt-1">uptime {uptime(g.uptime)} · {g.node}</div>
          {a && <AgentLine a={a} />}
        </div>
      ) : (
        <div className="text-xs text-subtle py-2">{t('infra.stopped_on', { node: g.node })}</div>
      )}
    </>
  )
  const cls = `${card} p-4 text-left ${up ? '' : 'opacity-70'}`
  // clickable card for every declared guest: Proxmox charts, plus the agent if there is one
  return a
    ? <button type="button" onClick={() => setHost(a.id)} className={`${cls} block w-full transition hover:border-line-strong`} aria-label={t('infra.detail_of', { name: g.name })}>{body}</button>
    : <div className={cls}>{body}</div>
}

function Storages({ list }) {
  if (!list || !list.length) return null
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2 text-xs text-muted">
        <HardDrive size={13} aria-hidden /> <span>{t('infra.proxmox_storages')}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map(s => (
          <div key={s.name} className={`${card} px-4 py-3`}>
            <div className="flex justify-between gap-2 text-xs mb-1.5">
              <span className="font-mono text-fg truncate">{s.name}</span>
              <span className="text-muted tabular-nums shrink-0">{bytes(s.disk)} / {bytes(s.maxdisk)} · {pct(s.disk, s.maxdisk)}%</span>
            </div>
            <Gauge value={pct(s.disk, s.maxdisk)} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Hypervisor header: name, host load, uptime
function NodeHeader({ cluster }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-3">
      <h3 className="text-sm font-semibold text-fg">{cluster.label}</h3>
      {(cluster.nodes || []).map(n => (
        <div key={n.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted">
          <span className="font-mono">{n.name}</span>
          <span className="w-28"><Gauge value={pct(n.cpu, 1)} label={`CPU · ${n.maxcpu}`} /></span>
          <span className="w-36"><Gauge value={pct(n.mem, n.maxmem)} label={`RAM · ${bytes(n.maxmem)}`} /></span>
          <span>uptime {uptime(n.uptime)}</span>
        </div>
      ))}
    </div>
  )
}

export default function Infra({ data, agents = [], proxmox }) {
  const agentOf = (c, g) => agents.find(a => a.pve === c.id && a.vmid === g.vmid)
  return (
    <div className="space-y-8">
      {data.map(c => {
        const px = proxmox?.find(x => x.id === c.id)
        return (
        <div key={c.id}>
          {px && !c.error
            ? <><h3 className="mb-3 text-sm font-semibold text-fg">{c.label}</h3><Nodes px={px} cluster={c} /></>
            : <NodeHeader cluster={c} />}
          {c.error ? <ErrorBox prefix={t('infra.proxmox_unreachable')} msg={c.error} /> : (
            <>
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))]">
                {c.guests.map(g => <Guest key={`${g.type}-${g.vmid}`} g={g} a={agentOf(c, g)} />)}
              </div>
              <Storages list={c.storages} />
            </>
          )}
        </div>
        )
      })}
    </div>
  )
}

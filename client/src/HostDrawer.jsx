import { useEffect, useRef, useState, useEffectEvent } from 'react'
import { useLocation } from 'wouter'
import { X, Container, HardDrive, Cog, Package, RotateCw, Activity, Network, ShieldCheck, Plug } from 'lucide-react'
import { useSource, useJson } from './api.js'
import Chart from './ui/Chart.jsx'
import { useUrlParam } from './hooks/useUrlState.js'
import { StatusDot } from './ui/Status.jsx'
import Gauge from './ui/Gauge.jsx'
import TimeAgo from './ui/TimeAgo.jsx'
import { bytes, uptime } from './lib/format.js'
import { agentSummary, fsPct, since } from './lib/agent.js'
import { freshnessText } from './lib/deviceTypes.js'
import { listenDrawerEscape } from './lib/escape.js'
import { holdInert } from './lib/inert.js'
import Section from './ui/Section.jsx'
import { AutoUpdateInfo } from './components/AutoUpdate.jsx'
import { PostureList, PortsList } from './components/AgentSecurity.jsx'
import { localeTag, numberFormat, t, tLabels } from './i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'

function containerState(c) {
  if (c.health === 'unhealthy' || c.state === 'restarting' || c.recentRestarts >= 3) return 'crit'
  if (c.state === 'running') return c.health === 'starting' ? 'warn' : 'ok'
  return c.exitCode ? 'warn' : 'unknown'
}

// labels read at render time (host.cstate.<state>)
const CONTAINER_STATE = tLabels('host.cstate', ['running', 'exited', 'restarting', 'paused', 'created', 'dead'])

function Containers({ list }) {
  const sorted = [...list].sort((a, b) => (a.compose || '').localeCompare(b.compose || '') || a.name.localeCompare(b.name))
  return (
    <ul className={`${card} divide-y divide-line`}>
      {sorted.map(c => (
        <li key={c.name} className="flex items-center gap-2.5 px-3 py-2">
          <StatusDot state={containerState(c)} size={13} label={CONTAINER_STATE[c.state] || c.state} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-fg">{c.name}</span>
            </div>
            <div className="truncate font-mono text-2xs text-subtle" title={c.image}>{c.image}</div>
          </div>
          <div className="shrink-0 text-right text-2xs leading-tight text-muted">
            <div>
              {c.state === 'running' ? t('host.since', { d: since(c.startedAt) }) : `${CONTAINER_STATE[c.state] || c.state}${c.exitCode ? t('host.exit_code', { code: c.exitCode }) : ''}`}
            </div>
            <div className={c.health === 'unhealthy' ? 'text-crit' : ''}>
              {c.health ? t('host.health', { h: c.health }) : ''}{c.restarts ? `${c.health ? ' · ' : ''}${t('host.restarts', { n: c.restarts })}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

const n1 = numberFormat({ maximumFractionDigits: 1 })
const rate = v => `${bytes(v)}/s`

// Proxmox charts: available for every guest, with or without an agent
function GuestCharts({ pve, vmid }) {
  const [tf, setTf] = useState('day')
  const q = useJson(pve && vmid ? `/api/rrd/${pve}/guest/${vmid}?timeframe=${tf}` : null, 60_000)
  const pts = q.data?.points || []
  const times = pts.map(p => p.t)
  const col = k => pts.map(p => p[k])
  const btn = on => `rounded px-1.5 py-0.5 ${on ? 'bg-surface-3 text-fg' : 'text-subtle hover:text-fg'}`
  const toggle = (
    <span className="inline-flex gap-1" role="group" aria-label={t('host.period')}>
      <button type="button" className={btn(tf === 'day')} aria-pressed={tf === 'day'} onClick={() => setTf('day')}>{t('range.24h')}</button>
      <button type="button" className={btn(tf === 'week')} aria-pressed={tf === 'week'} onClick={() => setTf('week')}>{t('range.7d')}</button>
    </span>
  )
  return (
    <Section icon={Activity} title={t('host.proxmox_history')} extra={toggle}>
      {q.error ? <p className="text-xs text-warn">{t('host.charts_error', { err: String(q.error.message || q.error) })}</p>
        : !q.data ? <div className={`${card} h-48 animate-pulse`} />
          : (
            <div className={`${card} grid gap-4 p-3`}>
              <Chart title={`CPU${q.data.maxcpu ? ` · ${q.data.maxcpu} vCPU` : ''}`} series={[{ values: col('cpu'), className: 'text-accent' }]} max={100} format={v => `${n1.format(v)} %`} times={times} />
              <Chart title={`RAM${q.data.maxmem ? ` · ${bytes(q.data.maxmem)}` : ''}`} series={[{ values: col('mem'), className: 'text-accent' }]} max={100} format={v => `${n1.format(v)} %`} times={times} />
              <Chart title={t('host.network')} series={[{ label: t('host.net_in'), values: col('netin'), className: 'text-accent' }, { label: t('host.net_out'), values: col('netout'), className: 'text-info' }]} format={rate} times={times} />
              <Chart title={t('host.disk')} series={[{ label: t('host.read'), values: col('diskread'), className: 'text-accent' }, { label: t('host.write'), values: col('diskwrite'), className: 'text-info' }]} format={rate} times={times} />
            </div>
          )}
    </Section>
  )
}

// network module: LAN device linked to this host (Proxmox MAC, config or IP)
function NetworkSection({ hostId }) {
  const net = useSource('network', { enabled: !!hostId })
  const [location, navigate] = useLocation()
  const d = net.data?.devices?.find(x => x.hostId === hostId)
  if (!d) return null
  const openDevice = () => {
    const p = new URLSearchParams(window.location.search)
    p.delete('h')
    p.set('d', String(d.id))
    navigate(`${location}?${p}`, { replace: true })
  }
  return (
    <Section icon={Network} title={t('host.network')} extra={<button type="button" onClick={openDevice} className="text-accent hover:underline">{t('host.device_record')}</button>}>
      <div className={`${card} flex flex-wrap gap-x-4 gap-y-1 p-3 text-xs text-muted`}>
        <span className="font-mono text-fg">{d.mac}</span>
        <span className="font-mono">{d.ip}</span>
        <span>{freshnessText(d)}{d.lastSeen && d.freshness !== 'idle' ? <>{t('dev.seen_sep')}<TimeAgo date={d.lastSeen} /></> : ''}</span>
        {d.macs > 1 && <span>{d.macs} MAC</span>}
      </div>
    </Section>
  )
}

// Detail drawer of a host running the agent (?h=<id>): file systems, containers, systemd units,
// packages. Same behavior as the service drawer.
export default function HostDrawer() {
  const [id, setId] = useUrlParam('h')
  const agents = useSource('agents', { enabled: !!id })
  const panel = useRef(null)
  const a = agents.data?.hosts.find(x => x.id === id)
  const close = () => setId('')

  // Escape calls the CURRENT close (useEffectEvent), even if the URL changed since opening; the
  // effect still runs only on opening (focus, inert background, listener)
  const onEscape = useEffectEvent(() => close())
  useEffect(() => {
    if (!id) return
    const prev = document.activeElement
    // inert background (Shell), focus inside the drawer; released BEFORE the focus is given back
    const release = holdInert(document)
    panel.current?.focus()
    // Escape: ignored when it is meant for the bell or for a modal
    const off = listenDrawerEscape(window, () => onEscape(), document)
    return () => {
      off()
      release()
      prev?.focus?.()
    }
  }, [id])

  if (!id) return null
  const sum = agentSummary(a)
  const f = a?.fast
  const fresh = f && !sum.error
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* backdrop clickable with the mouse, outside the tab order (Escape or "Close details" from the keyboard) */}
      <button type="button" aria-label={t('common.close')} tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={close} />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('host.detail_of', { name: a?.name || id })}
        className="relative h-full w-full max-w-lg overflow-y-auto border-l border-line bg-bg p-4 shadow-2xl focus:outline-none sm:p-5"
      >
        <div className="flex items-start gap-3">
          <StatusDot state={sum.state} size={22} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-fg">{a?.name || id}</h2>
            <p className="text-xs text-muted">
              {a ? `${a.kind === 'lxc' ? 'CT' : 'VM'} ${a.vmid} · PVE ${a.pve} · ${a.env}` : ''}
            </p>
            {f && <p className="mt-0.5 text-2xs text-subtle">{t('host.os_line', { os: f.os, kernel: f.kernel, up: uptime(f.uptimeSec) })}</p>}
          </div>
          <button type="button" onClick={close} className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg" aria-label={t('common.close_details')}>
            <X size={18} aria-hidden />
          </button>
        </div>

        {!agents.data && <div className="mt-4 h-40 animate-pulse rounded-[var(--radius-card)] border border-line bg-surface" />}
        {agents.data && !a?.agent && (
          <p className={`${card} mt-4 px-4 py-3 text-sm text-muted`}>
            {t('host.not_instrumented')}
          </p>
        )}
        {a?.agent && sum.error && (
          <p className={`${card} mt-4 border-l-[3px] border-l-warn px-4 py-3 text-sm text-muted`}>
            {t('host.agent_down', { err: a.error || t('agent.no_report') })}
            {a.at && <>{t('host.last_report')}<TimeAgo date={a.at} /></>}
          </p>
        )}

        <NetworkSection hostId={id} />

        {a?.pve && a?.vmid && <GuestCharts pve={a.pve} vmid={a.vmid} />}

        {fresh && (
          <>
            <p className="mt-3 text-2xs text-subtle">
              {t('host.report')} <TimeAgo date={a.at} />{t('host.ram_load', { used: bytes(f.mem.total - f.mem.available), total: bytes(f.mem.total), load: f.load.join(' ') })}
              {/* NTP clock (agent v8, slow report; v7 and earlier: unknown) */}
              {t('host.clock')}{a.slow?.time?.ntpSynced === true ? t('host.clock_ok') : a.slow?.time?.ntpSynced === false ? <span className="text-warn">{t('host.clock_bad')}</span> : t('host.clock_unknown')}
            </p>
            {sum.reboot && (
              <p className={`${card} mt-3 flex items-center gap-2 px-3 py-2 text-xs text-info`}>
                <RotateCw size={14} aria-hidden /> {t('host.reboot', { why: sum.reboot })}
              </p>
            )}
            {/* services to restart after an update (needrestart, agent v8) */}
            {sum.restart?.units.length > 0 && (
              <p className={`${card} mt-3 flex items-start gap-2 px-3 py-2 text-xs text-info`}>
                <RotateCw size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{t('host.restart')}<span className="font-mono">{sum.restart.units.slice(0, 8).join(', ')}{sum.restart.units.length > 8 ? ` (+${sum.restart.units.length - 8})` : ''}</span></span>
              </p>
            )}

            <Section icon={HardDrive} title={t('host.file_systems')}>
              <div className={`${card} space-y-2.5 p-3`}>
                {f.fs.map(x => (
                  <Gauge key={x.mount} value={Math.round(fsPct(x))} warn={85} crit={95}
                    label={`${x.mount} · ${bytes(x.used)} / ${bytes(x.used + x.avail)} · ${x.type}`} />
                ))}
                {/* inodes (agent v8); shown only when known */}
                {f.fs.some(x => x.inodes?.total) && (
                  <p className="text-2xs text-subtle">{t('host.inodes')}{f.fs.filter(x => x.inodes?.total).map(x => {
                    const p = Math.round((x.inodes.used / x.inodes.total) * 100)
                    return <span key={x.mount} className={`mr-2 ${p >= 95 ? 'text-crit' : p >= 85 ? 'text-warn' : ''}`}>{x.mount} {p} %</span>
                  })}</p>
                )}
              </div>
            </Section>

            {f.docker && (
              <Section icon={Container} title={t('host.containers')} extra={t('host.docker', { v: f.docker.version, run: sum.containers.running, total: sum.containers.total })}>
                {f.docker.containers.length ? <Containers list={f.docker.containers} /> : <p className="text-xs text-subtle">{t('host.no_containers')}</p>}
              </Section>
            )}

            {f.systemd && (
              <Section icon={Cog} title={t('host.systemd_units')}>
                <ul className={`${card} divide-y divide-line`}>
                  {f.systemd.failed.map(u => (
                    <li key={`f-${u}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <StatusDot state="crit" size={12} label={t('host.failed')} /><span className="font-mono text-fg">{u}</span><span className="ml-auto text-crit">failed</span>
                    </li>
                  ))}
                  {f.systemd.watched.filter(u => !f.systemd.failed.includes(u.unit)).map(u => (
                    <li key={u.unit} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <StatusDot state={u.active === 'active' ? 'ok' : 'warn'} size={12} />
                      <span className="font-mono text-fg">{u.unit}</span>
                      <span className="ml-auto text-muted">{u.active === 'missing' ? t('host.missing') : `${u.active} (${u.sub})`}</span>
                    </li>
                  ))}
                  {!f.systemd.failed.length && !f.systemd.watched.length && <li className="px-3 py-1.5 text-xs text-subtle">{t('host.no_failed_units')}</li>}
                </ul>
              </Section>
            )}

            {sum.apt && (
              <Section icon={Package} title={t('host.apt_packages')}
                extra={sum.aptAgeDays != null ? t('host.apt_lists', { date: new Date(sum.apt.listsAt * 1000).toLocaleDateString(localeTag()) }) : null}>
                <p className="mb-2 text-xs text-muted">
                  {sum.apt.upgradable ? t('host.apt_pending', { n: sum.apt.upgradable, s: sum.apt.security }) : t('host.apt_ok')}
                  {sum.apt.held ? t('host.apt_held', { n: sum.apt.held }) : ''}
                  {sum.aptAgeDays > 7 && <span className="text-warn">{t('host.apt_old', { d: Math.floor(sum.aptAgeDays) })}</span>}
                </p>
                {/* automatic security updates (the OS patches, the agent watches) */}
                {a.autoUpdate && <div className="mb-2"><AutoUpdateInfo s={a.autoUpdate} /></div>}
                {sum.apt.packages.length > 0 && (
                  <details className={`${card} px-3 py-2`}>
                    <summary className="cursor-pointer text-xs text-accent">{t('host.see_packages')}</summary>
                    <ul className="mt-2 space-y-0.5 font-mono text-2xs">
                      {sum.apt.packages.map(p => (
                        <li key={p.name} className="flex gap-2">
                          <span className={`truncate ${p.held ? 'text-subtle' : /-security/.test(p.suite) ? 'text-warn' : 'text-fg'}`}>{p.name}{p.held ? t('host.held_suffix') : ''}</span>
                          <span className="ml-auto shrink-0 text-subtle">{p.from} → {p.version}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Section>
            )}

            {/* SSH and firewall posture, listening ports (agent v8) */}
            <Section icon={ShieldCheck} title={t('host.ssh_firewall_posture')}>
              <div className={`${card} p-3`}><PostureList host={a} v8={a.v8} actions /></div>
            </Section>
            <Section icon={Plug} title={t('host.listening_ports')}>
              <div className={`${card} px-3 py-2`}><PortsList host={a} v8={a.v8} actions /></div>
            </Section>
          </>
        )}
      </section>
    </div>
  )
}

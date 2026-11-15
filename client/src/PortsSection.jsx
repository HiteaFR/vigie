import { useState } from 'react'
import { Radar } from 'lucide-react'
import { useAdmin, Modal, ReasonForm, btnGhost } from './admin.jsx'
import { netKeys } from './lib/netKeys.js'
import { useEnv } from './hooks/useUrlState.js'
import { withEnv } from './nav.js'
import Section from './ui/Section.jsx'
import { localeTag, t, tLabels } from './i18n/index.js'

// "Ports and services": services recognized by the probe (for everyone), raw ports and a
// "Probe" button (admin). The probe is never started by displaying: only the button requests
// it (POST). An excluded record has no button; IoT, camera or standby: explicit confirmation
// with a reason (force).
const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
// labels read at render time (ports.conf.<level>, ports.origin.<origin>)
const CONF = { high: 'text-ok border-ok/40', medium: 'text-warn border-warn/40', low: 'text-muted border-line' }
const ORIGIN = tLabels('ports.origin', ['planned', 'admin'])
const dt = iso => new Date(iso).toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function PortsSection({ d }) {
  const { isAdmin, act } = useAdmin()
  const [env] = useEnv()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState(null)
  const [asked, setAsked] = useState(false)
  const services = d.probeServices ?? []
  const ports = d.ports ?? []
  const p = d.probe
  if (!services.length && !d.lastProbe && !(isAdmin && p?.available)) return null

  const ask = async body => {
    setError(null)
    try {
      await act('/api/network/devices/probe', { id: d.id, ...body }, { invalidate: netKeys(d.id) })
      setAsked(true)
    } catch (e) {
      setError(e.message)
      throw e
    }
  }
  const open = ports.filter(x => x.open)
  const unattributed = open.filter(x => !x.service)

  return (
    <Section icon={Radar} title={t('ports.ports_services')}
      extra={d.lastProbe ? <>{t('ports.last_run', { date: dt(d.lastProbe.at) })}{ORIGIN[d.lastProbe.origin] ?? d.lastProbe.origin}</> : t('ports.never')}>
      {services.length > 0 && (
        <ul className={`${card} divide-y divide-line`}>
          {services.map(s => (
            <li key={`${s.id}-${s.port}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="truncate text-fg">{s.name}</span>
              {isAdmin && s.port && <span className="font-mono text-subtle">tcp/{s.port}</span>}
              <span className={`rounded-[var(--radius-chip)] border px-1.5 text-2xs ${CONF[s.confidence] ?? 'text-muted border-line'}`}>{CONF[s.confidence] ? t(`ports.conf.${s.confidence}`) : s.confidence}</span>
              {s.cfgService && <a className="ml-auto text-2xs text-accent hover:underline" href={withEnv(`/services?s=${encodeURIComponent(s.cfgService)}`, env)}>{t('ports.service_config')}</a>}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && open.length > 0 && (
        <div className="mt-2 text-xs">
          <div className="flex flex-wrap gap-1.5">
            {open.map(x => (
              <span key={`${x.proto}/${x.port}`} className="rounded-[var(--radius-chip)] border border-line px-1.5 font-mono text-2xs text-muted" title={t('ports.seen', { first: dt(x.firstSeen), last: dt(x.lastSeen) })}>
                {x.proto}/{x.port}{x.service ? ` · ${x.service}` : ''}
              </span>
            ))}
          </div>
          {unattributed.length > 0 && (
            <p className="mt-1 text-2xs text-subtle">{t('ports.unattributed', { list: unattributed.map(x => `${x.proto}/${x.port}`).join(', ') })}</p>
          )}
        </div>
      )}
      {isAdmin && ports.some(x => !x.open) && (
        <p className="mt-1 text-2xs text-subtle">
          {t('ports.closed', { list: ports.filter(x => !x.open).map(x => `${x.proto}/${x.port}`).join(', ') })}
        </p>
      )}

      {isAdmin && p && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {p.excluded ? (
            <span className="text-muted">{t('ports.excluded_probe')}</span>
          ) : !p.available ? (
            <span className="text-muted">{t('ports.probe_unavailable_invalid_definitions')}</span>
          ) : asked ? (
            <span className="text-muted">{t('ports.probe_requested')}</span>
          ) : (
            <button type="button" className={btnGhost} onClick={() => (p.needsForce ? setConfirm(true) : ask({}).catch(() => {}))}>{t('ports.probe')}</button>
          )}
          {error && <span className="text-crit">{error}</span>}
        </div>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title={t('ports.probe_iot_device_camera')}>
        <ReasonForm submitLabel={t('ports.probe_anyway')} onCancel={() => setConfirm(false)} placeholder={t('ports.example_check_service_after')}
          onSubmit={async reason => {
            await ask({ force: true, reason }).finally(() => setConfirm(false))
          }}>
          <p className="text-xs text-muted">{t('ports.device_never_probed_sundays')}</p>
        </ReasonForm>
      </Modal>
    </Section>
  )
}

// SSH and firewall posture compared with the standard, and listening ports (agent v8), from
// /api/agents (h.v8). Deviation: badge; accepted deviation: neutral, reason on hover; unknown
// (agent v7 or v6, missing field): said as such. Admin actions with a reason: accept a
// deviation, withdraw the acceptance, mark a port as "Known". Shared by the host drawer (actions)
// and the Network record of the linked device (read only).
import { useState } from 'react'
import { useAdmin, Modal, ReasonForm } from '../admin.jsx'
import { localeTag, t } from '../i18n/index.js'

// labels read at render time (sec.crit.<criterion>, sec.std.<criterion>, sec.state.<state>, sec.port.<status>)
const CRITERIA = ['ssh_root', 'ssh_password', 'firewall']
const STATE = {
  ok: 'text-ok',
  gap: 'rounded border border-warn/40 bg-warn-bg px-1 text-warn',
  accepted: 'rounded border border-line px-1 text-subtle',
  unknown: 'text-subtle',
}
const small = 'rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-line-strong hover:text-fg'
const fmt = ms => new Date(ms).toLocaleDateString(localeTag(), { day: '2-digit', month: '2-digit', year: 'numeric' })

function ReasonDialog({ dialog, onClose }) {
  const { act } = useAdmin()
  if (!dialog) return null
  return (
    <Modal open onClose={onClose} title={dialog.title}>
      <ReasonForm submitLabel={dialog.submit} onCancel={onClose} placeholder={dialog.placeholder} onSubmit={async reason => {
        await act(dialog.url, { ...dialog.body, reason }, { invalidate: ['agents', 'alerts'], success: dialog.success })
        onClose()
      }}>
        {dialog.text && <p className="text-xs text-muted">{dialog.text}</p>}
      </ReasonForm>
    </Modal>
  )
}

export function PostureList({ host, v8, actions = false }) {
  const { isAdmin, requireLogin } = useAdmin()
  const [dialog, setDialog] = useState(null)
  const guard = fn => () => (isAdmin ? fn() : requireLogin(fn))
  if (!v8?.known) return <p className="text-xs text-subtle">{t('sec.ssh_firewall_posture_unknown')}</p>
  if (v8.restricted) return <p className="text-xs text-subtle">{t('sec.ssh_firewall_posture_admin')}</p>
  if (!v8.posture) return <p className="text-xs text-subtle">{t('sec.ssh_firewall_posture_not')}</p>
  return (
    <>
      <ul className="space-y-1 text-xs">
        {CRITERIA.map(c => {
          const [label, std] = [t(`sec.crit.${c}`), t(`sec.std.${c}`)]
          const p = v8.posture[c] ?? { state: 'unknown' }
          const st = STATE[p.state] ? p.state : 'unknown'
          const [txt, cls] = [t(`sec.state.${st}`), STATE[st]]
          const title = p.state === 'accepted' ? t('sec.accepted_by', { by: p.accepted.by, date: fmt(p.accepted.at), reason: p.accepted.reason }) : t('sec.standard', { std })
          return (
            <li key={c} className="flex flex-wrap items-center gap-2">
              <span className="w-32 shrink-0 text-muted">{label}</span>
              <span className={cls} title={title}>{txt}</span>
              {p.regression && <span className="text-2xs text-warn">{t('sec.regression', { date: fmt(p.seenOk) })}</span>}
              {actions && p.state === 'gap' && <button type="button" className={small} onClick={guard(() => setDialog({
                title: t('sec.accept_title', { label, host: host.name }), submit: t('sec.accept'), success: t('sec.accepted_ok'),
                url: '/api/agents/posture/accept', body: { host: host.id, criterion: c }, placeholder: t('sec.accept_ph'),
                text: t('sec.accept_text'),
              }))}>{t('sec.accept_button')}</button>}
              {actions && p.state === 'accepted' && <button type="button" className={small} onClick={guard(() => setDialog({
                title: t('sec.unaccept_title', { label, host: host.name }), submit: t('sec.unaccept'), success: t('sec.unaccepted_ok'),
                url: '/api/agents/posture/unaccept', body: { host: host.id, criterion: c },
              }))}>{t('sec.unaccept_button')}</button>}
            </li>
          )
        })}
      </ul>
      <ReasonDialog dialog={dialog} onClose={() => setDialog(null)} />
    </>
  )
}

const PORT = { local: 'text-subtle', known: 'text-muted', new: 'rounded border border-warn/40 bg-warn-bg px-1 text-warn' }

export function PortsList({ host, v8, actions = false }) {
  const { isAdmin, requireLogin } = useAdmin()
  const [dialog, setDialog] = useState(null)
  const guard = fn => () => (isAdmin ? fn() : requireLogin(fn))
  if (!v8?.known) return <p className="text-xs text-subtle">{t('sec.listening_ports_unknown_agent')}</p>
  if (v8.restricted) return <p className="text-xs text-subtle">{t('sec.listening_ports_admin_only')}</p>
  if (!v8.ports) return <p className="text-xs text-subtle">{t('sec.listening_ports_not_reported')}</p>
  if (!v8.ports.length) return <p className="text-xs text-subtle">{t('sec.no_listening_ports_reported')}</p>
  return (
    <>
      <ul className="divide-y divide-line font-mono text-2xs">
        {v8.ports.map(p => {
          const ps = PORT[p.status] ? p.status : 'known'
          const [txt, cls] = [t(`sec.port.${ps}`), PORT[ps]]
          return (
            <li key={`${p.proto}/${p.port}`} className="flex flex-wrap items-center gap-2 py-1">
              <span className="w-20 shrink-0 text-fg">{p.proto}/{p.port}</span>
              <span className="min-w-0 flex-1 truncate text-muted" title={p.addrs.join(', ')}>{p.processes.join(', ') || '—'} · {p.addrs.join(', ')}</span>
              <span className={`font-sans ${cls}`} title={p.known && !p.known.bootstrap ? t('sec.known_by', { by: p.known.by, reason: p.known.reason }) : undefined}>{txt}</span>
              {actions && p.status === 'new' && <button type="button" className={`font-sans ${small}`} onClick={guard(() => setDialog({
                title: t('sec.port_title', { port: `${p.proto}/${p.port}`, host: host.name }), submit: t('net.bulk.ack'), success: t('sec.port_known'),
                url: '/api/agents/ports/known', body: { host: host.id, proto: p.proto, port: p.port }, placeholder: t('sec.port_ph'),
              }))}>{t('sec.known_button')}</button>}
            </li>
          )
        })}
      </ul>
      <ReasonDialog dialog={dialog} onClose={() => setDialog(null)} />
    </>
  )
}

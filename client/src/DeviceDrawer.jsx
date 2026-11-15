import { useEffect, useRef, useState, useEffectEvent } from 'react'
import { useLocation } from 'wouter'
import { X, Activity, Fingerprint, Cable, MapPin, LayoutGrid, ScrollText, Server, Layers } from 'lucide-react'
import { useJson, useSource } from './api.js'
import { useAdmin, Modal, ReasonForm, field, btnGhost } from './admin.jsx'
import DeviceForm, { ActionDialog } from './DeviceForm.jsx'
import { netKeys } from './lib/netKeys.js'
import { useUrlParam, useEnv } from './hooks/useUrlState.js'
import { withEnv } from './nav.js'
import Section from './ui/Section.jsx'
import MapParent from './MapParent.jsx'
import PortsSection from './PortsSection.jsx'
import { StatusDot } from './ui/Status.jsx'
import TimeAgo from './ui/TimeAgo.jsx'
import ServiceIcon from './ui/ServiceIcon.jsx'
import UptimeBand from './ui/UptimeBand.jsx'
import { typeOf, presenceState, presenceText, freshnessText, deviceName, SOURCE_LABEL } from './lib/deviceTypes.js'
import { listenDrawerEscape } from './lib/escape.js'
import { holdInert } from './lib/inert.js'
import { mergeChoice } from './lib/mergeChoice.js'
import { PortsList } from './components/AgentSecurity.jsx'
import { localeTag, t, tLabels } from './i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
// labels read at render time (catalog dev.*)
const GRADE = tLabels('dev.grade', ['strong', 'weak', 'hypervisor'])
const ATTACH = tLabels('dev.attach', ['name', 'ip', 'rule', 'merge', 'detached', 'pve', 'config', 'agent'])
// the server says whether the MAC is an identity (a MAC seen only by the agent is not one)
const isIdentity = m => m.identity ?? (m.grade === 'hypervisor' || m.attach === 'pve' || m.attach === 'config')
const ATTR = tLabels('dev.attr', ['name', 'hostname', 'vendor', 'type'])
const SAISIE = tLabels('dev.manual', ['name', 'type', 'location', 'notes'])
const EVENT = tLabels('dev.event', ['new', 'imported', 'ip_changed', 'mac_added', 'reappeared', 'merged', 'acked', 'edited', 'ignored', 'archived', 'restored', 'mac_confirmed', 'mac_detached', 'detached', 'arp_conflict', 'deleted', 'returned', 'probed', 'port_opened', 'port_closed'])
const PROFILE = tLabels('dev.profile', ['fixed', 'normal', 'sleepy'])
const HOUR = 3600_000
const DAY = 86400_000
// duration of a session: "3 h 12", "25 min"
const span = (a, b) => {
  const min = Math.max(1, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60_000))
  return min < 60 ? t('time.min', { n: min }) : t('time.h_mm', { h: Math.floor(min / 60), mm: String(min % 60).padStart(2, '0') })
}
const dt = v => (v ? new Date(v).toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

// Name announced over mDNS, informative, visible to everyone; TEXT NODES only (no injected
// HTML, no attribute built from the value), no action. "since", because seenAt is the date of
// the last CHANGE of this name, not that of the last announcement
export function MdnsName({ m }) {
  return (
    <p className="text-2xs text-subtle">
      {t('dev.mdns')}<span className="text-muted">{m.value}</span>{t('dev.mdns_since', { date: dt(m.seenAt) })}
      {m.conflict && t('dev.mdns_conflict')}
    </p>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex gap-3 px-3 py-1.5 text-xs">
      <span className="w-28 shrink-0 text-subtle">{label}</span>
      <span className="min-w-0 flex-1 break-words text-fg">{children}</span>
    </div>
  )
}

// "Merge with…" list and a plain reminder of the absorbed record. The displayed selection is
// the EFFECTIVE selection (mergeChoice): an empty, hidden and disabled option carries ''; no
// option is highlighted without a real choice. Pure component.
const pickLine = x => `#${x.id} ${deviceName(x)} · ${x.ip || '—'} · ${x.mac || '—'}`
export function MergePicker({ shown, chosenId, onChoose, into = null, total = shown.length }) {
  const choice = mergeChoice(shown, chosenId)
  return (
    <>
      <select value={choice ? String(choice.id) : ''} onChange={e => onChoose(Number(e.target.value))} aria-label={t('dev.device_merge')} className={field} size={6}>
        <option value="" hidden disabled>—</option>
        {shown.map(x => <option key={x.id} value={x.id}>{pickLine(x)}</option>)}
      </select>
      {total > shown.length && <p className="text-2xs text-subtle">{t('dev.first_n', { n: shown.length, total })}</p>}
      <p className="text-xs" aria-live="polite">
        {choice
          ? <>{t('dev.absorbed')}<strong>{pickLine(choice)}</strong>{into && <>{t('dev.absorbed_by')}<strong>{pickLine(into)}</strong></>}</>
          : t('dev.no_device_chosen')}
      </p>
    </>
  )
}

// admin actions: edit, validate, merge, delete; a reason is required except for editing.
// No more Ignore, Archive or Restore (nothing is ignored). Rendered only with a session (the
// server refuses anyway).
function Actions({ d, onDeleted, mode }) {
  const { act } = useAdmin()
  const net = useSource('network')
  const [dialog, setDialog] = useState(null)
  const [mergeWith, setMergeWith] = useState(null)
  const [q, setQ] = useState('')
  // choice and search reset on close
  const close = () => {
    setDialog(null)
    setMergeWith(null)
    setQ('')
  }
  const others = (net.data?.devices ?? []).filter(x => x.id !== d.id)
    .filter(x => !q || [x.name, x.ip, x.mac, x.vendor].some(v => v && String(v).toLowerCase().includes(q.toLowerCase())))
  const shown = others.slice(0, 100)
  const choice = mergeChoice(shown, mergeWith)
  const reasonDialog = (kind, title, label, url, body, success, placeholder) => (
    <ActionDialog open={dialog === kind} onClose={close} title={title} label={label} url={url} body={body} invalidate={netKeys(d.id)} success={success} placeholder={placeholder} />
  )
  return (
    <div className="mt-4 flex flex-wrap gap-2" role="toolbar" aria-label={t('dev.actions_device')}>
      <button type="button" className={btnGhost} onClick={() => setDialog('edit')}>{t('dev.edit')}</button>
      {(d.state === 'new' || d.review) && <button type="button" className={btnGhost} onClick={() => setDialog('ack')}>{t('dev.ack_button')}</button>}
      <button type="button" className={btnGhost} onClick={() => setDialog('merge')}>{t('dev.merge_with')}</button>
      {/* the server says whether deletion is allowed (deletionBlock); when refused, the reason as text */}
      {(d.deletion ? d.deletion.allowed : !d.hostId) && <button type="button" className={`${btnGhost} text-crit`} onClick={() => setDialog('delete')}>{t('dev.delete_button')}</button>}
      {d.deletion && !d.deletion.allowed && <p className="basis-full text-2xs text-muted">{t('dev.no_delete', { why: d.deletion.why })}</p>}
      <DeviceForm open={dialog === 'edit'} onClose={close} device={d} types={net.data?.types} />
      {reasonDialog('ack', t('dev.ack_title', { name: deviceName(d) }), t('net.bulk.ack'), '/api/network/devices/ack', { ids: [d.id] }, t('dev.acked'), t('dev.ack_ph'))}
      <Modal open={dialog === 'delete'} onClose={close} title={t('dev.delete_title', { name: deviceName(d) })}>
        <div className="mb-3 space-y-1.5 text-xs text-muted">
          <p>{t('dev.device_macs_sightings_addresses')}</p>
          {mode === 'arp' && d.online === 1 && <p className="text-warn">{t('dev.device_present_hint')}</p>}
          <p>{t('dev.reappears_as_new_hint')}</p>
        </div>
        <ReasonForm submitLabel={t('dev.delete')} onCancel={close} placeholder={t('dev.example_device_given_away')} onSubmit={async reason => {
          await act('/api/network/devices/delete', { ids: [d.id], reason }, { invalidate: netKeys(), success: t('dev.device_deleted') })
          close()
          onDeleted()
        }} />
      </Modal>
      <ActionDialog open={dialog === 'merge'} onClose={close} title={t('dev.merge_title', { name: deviceName(d) })} label={t('dev.merge')}
        url="/api/network/devices/merge" body={() => ({ into: d.id, from: [choice.id] })} invalidate={netKeys(d.id)} success={t('dev.devices_merged')}
        placeholder={t('dev.example_same_phone_new')} canSubmit={!!choice}>
        <p className="text-xs text-muted">{t('dev.macs_sightings_addresses_other')}</p>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('dev.search_device_name_ip')} aria-label={t('dev.search_device')} className={field} />
        <MergePicker shown={shown} chosenId={mergeWith} onChoose={setMergeWith} into={d} total={others.length} />
      </ActionDialog>
    </div>
  )
}

// MAC: confirm an automatic attachment, or detach (never an identity MAC nor the only one)
function MacActions({ d, m }) {
  const [dialog, setDialog] = useState(null)
  const close = () => setDialog(null)
  const canDetach = !isIdentity(m) && m.attach !== 'detached' && d.macs.length > 1
  return (
    <span className="ml-auto flex shrink-0 gap-1">
      {m.pending && <button type="button" className="rounded border border-line px-1.5 text-2xs text-ok hover:border-ok" onClick={() => setDialog('confirm')}>{t('dev.same_device')}</button>}
      {canDetach && <button type="button" className="rounded border border-line px-1.5 text-2xs text-muted hover:text-fg" onClick={() => setDialog('detach')}>{t('dev.detach')}</button>}
      <ActionDialog open={dialog === 'confirm'} onClose={close} title={t('dev.confirm_mac', { mac: m.mac })} label={t('dev.same_device_2')} url="/api/network/macs/confirm"
        body={{ mac: m.mac }} invalidate={netKeys(d.id)} success={t('dev.mac_confirmed')} placeholder={t('dev.example_same_tablet_private')} />
      <ActionDialog open={dialog === 'detach'} onClose={close} title={t('dev.detach_mac', { mac: m.mac })} label={t('dev.detach_2')} url="/api/network/macs/detach"
        body={{ mac: m.mac }} invalidate={netKeys(d.id)} success={t('dev.mac_detached_into_new')} placeholder={t('dev.example_another_device_that')} />
    </span>
  )
}

// one MAC of the record: grade, attachment, state; identity (static) MAC of a deletable record
// → "identity gone", never "identity" and "Delete" without an explanation
export function MacItem({ d, m, isAdmin }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <span className="font-mono text-fg">{m.mac}</span>
      <span className="text-2xs text-subtle">{GRADE[m.grade] || m.grade}{m.attach ? ` · ${ATTACH[m.attach] || m.attach}` : ''}</span>
      {isIdentity(m) && d.deletion?.allowed && <span className="text-2xs text-muted">{t('dev.identity_gone_no_longer')}</span>}
      {m.pending && <span className="rounded bg-warn-bg px-1 text-2xs font-semibold text-warn" title={t('dev.attached_automatically_does_not')}>{t('dev.pending')}</span>}
      <span className="text-2xs text-subtle">{m.lastIp}</span>
      {isAdmin && <MacActions d={d} m={m} />}
    </li>
  )
}

// lift a MAC rule: reason required
function RuleRemove({ d, r }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="ml-auto rounded border border-line px-1.5 text-2xs text-muted hover:text-fg" onClick={() => setOpen(true)}>{t('dev.lift')}</button>
      <ActionDialog open={open} onClose={() => setOpen(false)} title={t('dev.rule_remove_title', { prefix: r.prefix })} label={t('dev.lift_rule')} url="/api/network/mac-rules/remove"
        body={{ id: r.id }} invalidate={netKeys(d.id)} success={t('dev.rule_lifted')} placeholder={t('dev.example_wrong_family')} />
    </>
  )
}

// Detail drawer of a LAN device (?d=<id>): identity and origin of each value, freshness, last
// seen per source, MACs, addresses, services; admin actions.
// Listening ports of the linked host (agent v8), read only; the actions live in the host
// drawer
function HostListening({ hostId }) {
  const agents = useSource('agents')
  const h = agents.data?.hosts.find(x => x.id === hostId)
  if (!h?.agent) return null
  return (
    <Section icon={Server} title={t('dev.listening_ports_agent')}>
      <PortsList host={h} v8={h.v8} />
    </Section>
  )
}

export default function DeviceDrawer() {
  const [id, setId] = useUrlParam('d')
  const { isAdmin } = useAdmin()
  const [location, navigate] = useLocation()
  const [env] = useEnv()
  const q = useJson(id ? `/api/network/devices/${encodeURIComponent(id)}` : null, 30_000)
  const net = useSource('network', { enabled: !!id })
  const mode = net.data?.presence ?? 'passive'
  const panel = useRef(null)
  const d = q.data
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

  // switches to the linked host's drawer (one drawer open at a time)
  const openHost = hostId => {
    const p = new URLSearchParams(window.location.search)
    p.delete('d')
    p.set('h', hostId)
    navigate(`${location}?${p}`, { replace: true })
  }

  if (!id) return null
  const T = d ? typeOf(d.type) : null
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* backdrop clickable with the mouse, outside the tab order (Escape or "Close details" from the keyboard) */}
      <button type="button" aria-label={t('common.close')} tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={close} />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('dev.detail_of', { name: d ? deviceName(d) : id })}
        className="relative h-full w-full max-w-lg overflow-y-auto border-l border-line bg-bg p-4 shadow-2xl focus:outline-none sm:p-5"
      >
        <div className="flex items-start gap-3">
          <StatusDot state={d ? presenceState(d, mode) : 'unknown'} size={22} label={d ? (d.state === 'new' ? t('dev.new') : presenceText(d, mode)) : undefined} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-fg">{d ? deviceName(d) : t('dev.device_n', { id })}</h2>
            {d && <p className="text-xs text-muted">{[T.label, d.ip, d.mac].filter(Boolean).join(' · ')}</p>}
            {d?.mdnsName && <MdnsName m={d.mdnsName} />}
            {d && (
              <p className="mt-0.5 text-2xs text-subtle">
                {mode === 'arp' ? presenceText(d, mode) : <>{freshnessText(d)}{d.lastSeen && d.freshness !== 'idle' ? <>{t('dev.seen_sep')}<TimeAgo date={d.lastSeen} /></> : ''}</>}
                {d.state === 'new' ? t('dev.suffix_new') : d.review ? t('dev.suffix_review') : ''}
              </p>
            )}
          </div>
          <button type="button" onClick={close} className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg" aria-label={t('common.close_details')}>
            <X size={18} aria-hidden />
          </button>
        </div>

        {q.error && <p className={`${card} mt-4 px-4 py-3 text-sm text-muted`}>{t('dev.not_found', { err: String(q.error.message || q.error) })}</p>}
        {!d && !q.error && <div className={`${card} mt-4 h-40 animate-pulse`} />}

        {d && (
          <>
            {isAdmin && <Actions d={d} mode={mode} onDeleted={close} />}
            <button type="button" onClick={() => navigate(withEnv(`/network?tab=carte&n=${encodeURIComponent(d.hostId ? `host:${d.hostId}` : `dev:${d.id}`)}`, env))}
              className="mt-3 text-2xs text-accent hover:underline">{t('dev.see_map')}</button>
            {d.host && (
              <button type="button" onClick={() => openHost(d.host.id)} className={`${card} mt-4 flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:border-line-strong`}>
                <Server size={14} className="text-accent" aria-hidden />
                <span className="text-fg">{t('dev.is_host', { name: d.host.name })}</span>
                <span className="text-subtle">{t('dev.host_link', { kind: d.host.kind, env: d.host.env, how: d.hostSrc === 'pve' ? t('dev.by_pve_mac') : d.hostSrc === 'config' ? t('dev.by_config') : t('dev.by_ip') })}</span>
                <span className="ml-auto text-accent">{t('drawer.open')}</span>
              </button>
            )}

            <MapParent d={d} />

            {d.band24h != null && (
              <Section icon={Activity} title={t('dev.presence')} extra={PROFILE[d.profile] ?? d.profile}>
                <div className={`${card} space-y-3 px-3 py-3`}>
                  <div className="text-xs text-fg">
                    {presenceText(d, mode)}{d.online === 1 && d.onlineSince ? <>{t('dev.since_sep')}<TimeAgo date={d.onlineSince} /></> : ''}
                    {d.lastPresent && <span className="text-muted">{t('dev.last_answer', { date: dt(d.lastPresent) })}</span>}
                    {d.alertDown && <span className="ml-1.5 rounded border border-line px-1 text-2xs text-subtle">{t('dev.offline_alert')}</span>}
                  </div>
                  <div>
                    <div className="mb-1 text-2xs text-muted">24 h</div>
                    <UptimeBand band={d.band24h} start={Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR} size={HOUR} label={t('dev.presence_24')} />
                  </div>
                  {d.band30d && (
                    <div>
                      <div className="mb-1 text-2xs text-muted">{t('dev.30_days')}</div>
                      <UptimeBand band={d.band30d} start={Math.floor(Date.now() / DAY) * DAY - 29 * DAY} size={DAY} label={t('dev.presence_30')} />
                    </div>
                  )}
                  {d.expectedIp && <div className="text-2xs text-muted">{t('dev.expected_ip')}<span className="font-mono">{d.expectedIp}</span>{d.ip && d.ip !== d.expectedIp ? <span className="text-warn">{t('dev.seen_ip', { ip: d.ip })}</span> : ''}</div>}
                </div>
                {d.sessions?.length > 0 && (
                  <ul className={`${card} mt-2 max-h-48 divide-y divide-line overflow-y-auto text-xs`} aria-label={t('dev.sessions_30_days')}>
                    {d.sessions.map(s => (
                      <li key={s.start} className="flex gap-2 px-3 py-1.5">
                        <span className="text-fg">{dt(s.start)}</span>
                        <span className="text-subtle">→ {s.end ? dt(s.end) : t('dev.ongoing')}</span>
                        <span className="ml-auto tabular-nums text-muted">{span(s.start, s.end)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )}

            <Section icon={Activity} title={mode === 'arp' ? t('dev.freshness_pi_hole_neighbors') : t('dev.freshness')}>
              <div className={`${card} divide-y divide-line`}>
                <Row label={t('dev.state')}>{freshnessText(d)}</Row>
                <Row label={t('dev.last_seen')}>{d.lastSeen ? <>{dt(d.lastSeen)} (<TimeAgo date={d.lastSeen} />)</> : '—'}</Row>
                {d.lastDhcp && <Row label={t('dev.dhcp_lease')}>{t('dev.until', { date: dt(d.lastDhcp) })}</Row>}
                <Row label={t('dev.first_seen')}>{dt(d.firstSeen)}</Row>
                {d.seen.map(s => (
                  <Row key={`${s.mac}|${s.source}`} label={SOURCE_LABEL[s.source] || s.source}>
                    <TimeAgo date={s.lastSeen} />{s.lastIp ? <span className="ml-1.5 font-mono text-2xs text-subtle">{s.lastIp}</span> : null}
                    {d.macs.length > 1 && <span className="ml-1.5 font-mono text-2xs text-subtle">{s.mac}</span>}
                  </Row>
                ))}
              </div>
              <p className="mt-1.5 text-2xs text-subtle">
                {mode === 'arp' ? t('dev.secondary_information_pi_hole') : t('dev.passive_presence_silent_device')}
              </p>
            </Section>

            <Section icon={Fingerprint} title={t('dev.identity_origin')}>
              <div className={`${card} divide-y divide-line`}>
                {Object.entries(d.saisie).filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                  <Row key={k} label={t('dev.typed', { label: SAISIE[k] || k })}>{k === 'type' ? typeOf(v).label : String(v)}</Row>
                ))}
                {d.attrs.map(a => (
                  <Row key={`${a.attr}|${a.source}`} label={ATTR[a.attr] || a.attr}>
                    <span className={a.chosen ? 'font-medium' : 'text-muted'}>{a.attr === 'type' ? typeOf(a.value).label : a.value}</span>
                    <span className="ml-1.5 text-2xs text-subtle">{SOURCE_LABEL[a.source] || a.source}{a.chosen ? t('dev.chosen') : ''}</span>
                  </Row>
                ))}
                {d.location && <Row label={t('dev.location')}><MapPin size={11} className="mr-1 inline text-subtle" aria-hidden />{d.location}</Row>}
              </div>
            </Section>

            <Section icon={Cable} title={t('dev.macs_addresses')} extra={`${d.macs.length} MAC`}>
              <ul className={`${card} divide-y divide-line`}>
                {d.macs.map(m => <MacItem key={m.mac} d={d} m={m} isAdmin={isAdmin} />)}
              </ul>
              {d.addresses.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-2xs text-muted">
                  {d.addresses.map(a => (
                    <li key={`${a.mac}|${a.ip}`} className="flex gap-2">
                      <span className="w-28 shrink-0 font-mono text-fg">{a.ip}</span>
                      <span className="truncate">{dt(a.firstSeen)} → {dt(a.lastSeen)}</span>
                      <span className="ml-auto shrink-0 text-subtle">{SOURCE_LABEL[a.source] || a.source}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {d.rules?.length > 0 && (
              <Section icon={Layers} title={t('dev.mac_rules')}>
                <ul className={`${card} divide-y divide-line`}>
                  {d.rules.map(r => (
                    <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="font-mono text-fg">{r.prefix}:*</span>
                      <span className="text-muted">{t('dev.family')}{r.name ? t('dev.family_name', { name: r.name }) : ''}{r.reason ? ` — ${r.reason}` : ''}{r.createdBy ? ` (${r.createdBy})` : ''}</span>
                      {isAdmin && <RuleRemove d={d} r={r} />}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {d.services.length > 0 && (
              <Section icon={LayoutGrid} title={t('dev.hosted_services')}>
                <ul className={`${card} divide-y divide-line`}>
                  {d.services.map(s => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <ServiceIcon name={s.name} iconUrl={s.iconUrl} iconUrlDark={s.iconUrlDark} size={16} />
                      <span className="truncate text-fg">{s.name}</span>
                      <StatusDot state={s.state} size={12} className="ml-auto" />
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <PortsSection d={d} />
            {d.hostId && <HostListening hostId={d.hostId} />}

            {d.events.length > 0 && (
              <Section icon={ScrollText} title={t('dev.events')}>
                <ul className="space-y-1 text-xs">
                  {d.events.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-28 shrink-0 tabular-nums text-subtle">{dt(e.at)}</span>
                      <span className="text-fg">{EVENT[e.type] || e.type}</span>
                      {e.detail && <span className="truncate text-muted" title={e.detail}>{e.detail}</span>}
                      {e.actor && <span className="ml-auto shrink-0 text-2xs text-subtle">{e.actor}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </section>
    </div>
  )
}

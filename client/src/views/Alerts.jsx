import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { Bell, History, Send, BellOff, BellRing, CheckCheck, Plus } from 'lucide-react'
import { useSource } from '../api.js'
import { useAdmin, Modal, ReasonForm, field, btnGhost } from '../admin.jsx'
import { effective, toggle, prune, groups, allPorts, portOf, resultText } from '../lib/alertSelection.js'
import { useEnv, matchEnv } from '../hooks/useUrlState.js'
import { StatusDot, StatusBadge } from '../ui/Status.jsx'
import Panel, { Skeleton } from '../ui/Panel.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import TimeAgo from '../ui/TimeAgo.jsx'
import { RULE_LABEL } from '../lib/alerts.js'
import { duration } from '../lib/format.js'
import { withEnv } from '../nav.js'
import { localeTag, t, tLabels } from '../i18n/index.js'

const SEV_STATE = { critical: 'crit', warning: 'warn', info: 'info' }
const SEV_LABEL = tLabels('alerts.sev', ['critical', 'warning', 'info'])

const hm = ts => new Date(ts).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })
const dayHm = ts => new Date(ts).toLocaleString(localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// displayed state: a suppressed or pending alert must not shout like a notified outage
function displayState(a) {
  if (a.suppressed) return 'maint'
  if (a.state === 'pending') return 'unknown'
  return SEV_STATE[a.severity] || 'unknown'
}

// durations offered for a silence (null = no end, reminded in the digest); label alerts.dur.<id>
const DURATIONS = [['1h', 3600_000], ['4h', 4 * 3600_000], ['24h', 86400_000], ['7d', 7 * 86400_000], ['30d', 30 * 86400_000], ['forever', null]]
const until = ms => (ms == null ? t('alerts.dur.forever') : t('alerts.until', { date: dayHm(ms) }))

function SilenceFields({ targets, target, setTarget, dur, setDur }) {
  return (
    <>
      {targets.length > 1 && (
        <fieldset className="space-y-1 text-xs text-muted">
          <legend className="mb-1">{t('alerts.target')}</legend>
          {targets.map(([label], i) => (
            <label key={label} className="flex items-center gap-2">
              <input type="radio" name="target" checked={target === i} onChange={() => setTarget(i)} /> <span className="text-fg">{label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="block text-xs text-muted">
        {t('alerts.duration')}
        <select value={dur} onChange={e => setDur(Number(e.target.value))} className={`${field} mt-1`}>
          {DURATIONS.map(([id], i) => <option key={id} value={i}>{t(`alerts.dur.${id}`)}</option>)}
        </select>
      </label>
      {DURATIONS[dur][1] == null && <p className="text-2xs text-warn">{t('alerts.no_end_hint')}</p>}
    </>
  )
}

function SilenceDialog({ open, onClose, targets, title }) {
  const { act } = useAdmin()
  const [target, setTarget] = useState(0)
  const [dur, setDur] = useState(0)
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ReasonForm submitLabel={t('alerts.set_silence')} onCancel={onClose} placeholder={t('alerts.example_disk_migration')} onSubmit={async reason => {
        const ms = DURATIONS[dur][1]
        await act('/api/silences', { matcher: targets[target][1], reason, endsAt: ms == null ? null : Date.now() + ms }, { invalidate: ['alerts', 'silences'], success: t('alerts.silence_set') })
        onClose()
      }}>
        <SilenceFields targets={targets} target={target} setTarget={setTarget} dur={dur} setDur={setDur} />
      </ReasonForm>
    </Modal>
  )
}

// small action buttons (alert, selection groups)
const small = 'inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-line-strong hover:text-fg'

// ack: the same dialog for one alert and for a batch
function AckDialog({ open, onClose, title, onSubmit }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ReasonForm submitLabel={t('alerts.acknowledge')} onCancel={onClose} placeholder={t('alerts.example_on_it')} onSubmit={onSubmit}>
        <p className="text-xs text-muted">{t('alerts.stops_reminders_recovery_notified')}</p>
      </ReasonForm>
    </Modal>
  )
}

function AlertActions({ a }) {
  const { act, isAdmin, requireLogin } = useAdmin()
  const [dialog, setDialog] = useState(null)
  const guard = fn => () => (isAdmin ? fn() : requireLogin(fn))
  const targets = [
    [t('alerts.this_alert'), { key: a.key }],
    ...(a.hostId ? [[t('alerts.target_host', { host: a.hostId }), { host: a.hostId }]] : []),
    [t('alerts.target_rule', { rule: RULE_LABEL[a.rule] || a.rule }), { rule: a.rule }],
  ]
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {a.state === 'firing' && !a.ack && <button type="button" className={small} onClick={guard(() => setDialog('ack'))}><CheckCheck size={11} aria-hidden /> {t('alerts.acknowledge')}</button>}
      {a.ack && <button type="button" className={small} onClick={guard(() => act('/api/alerts/unack', { key: a.key }, { invalidate: ['alerts'], success: t('alerts.ack_removed') }))}>{t('alerts.remove_ack')}</button>}
      <button type="button" className={small} onClick={guard(() => setDialog('silence'))}><BellOff size={11} aria-hidden /> {t('alerts.silence_2')}</button>
      <AckDialog open={dialog === 'ack'} onClose={() => setDialog(null)} title={t('alerts.ack_title', { title: a.title })} onSubmit={async reason => {
        await act('/api/alerts/ack', { key: a.key, reason }, { invalidate: ['alerts'], success: t('alerts.alert_acknowledged_no_more') })
        setDialog(null)
      }} />
      <SilenceDialog open={dialog === 'silence'} onClose={() => setDialog(null)} targets={targets} title={t('alerts.silence_title', { title: a.title })} />
    </div>
  )
}

// select: { checked, onChange } with an admin session, otherwise null (no checkbox)
function AlertRow({ a, env, select = null }) {
  const st = displayState(a)
  return (
    <li className={`flex items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 ${a.state === 'firing' && !a.suppressed ? `border-l-[3px] ${st === 'crit' ? 'border-l-crit' : st === 'warn' ? 'border-l-warn' : 'border-l-info'}` : ''} ${select?.checked ? 'ring-1 ring-accent' : ''}`}>
      {select && <input type="checkbox" className="mt-1 shrink-0" aria-label={t('alerts.select_one', { title: a.title })} checked={select.checked} onChange={select.onChange} />}
      <StatusDot state={st} size={16} className="mt-0.5" label={a.suppressed ? t('alerts.hidden') : a.state === 'pending' ? t('alerts.pending') : SEV_LABEL[a.severity]} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {a.link
            ? <Link href={withEnv(a.link, env)} className="text-sm font-semibold text-fg hover:underline truncate">{a.title}</Link>
            : <span className="text-sm font-semibold text-fg truncate">{a.title}</span>}
          <span className="text-2xs text-muted">{RULE_LABEL[a.rule] || a.rule}</span>
          {a.state === 'pending' && <StatusBadge state="unknown">{t('alerts.pending')}</StatusBadge>}
          {a.flapping && <StatusBadge state="warn">{t('alerts.flapping')}</StatusBadge>}
          {a.suppressed && <StatusBadge state="maint">{t('alerts.hidden')}</StatusBadge>}
        </div>
        {a.detail && <p className="mt-0.5 text-xs text-muted break-words">{a.detail}</p>}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-subtle">
          {a.host && <span>{a.host}</span>}
          {a.suppressed && <span>{a.suppressed}</span>}
          {a.state === 'firing' && !a.suppressed && <span>{a.notified ? t('alerts.notified') : t('alerts.not_notified')}</span>}
        </div>
        {a.ack && (
          <p className="mt-1 flex items-center gap-1 text-2xs text-ok">
            <CheckCheck size={12} aria-hidden /> {t('alerts.acked_by', { by: a.ack.by })} <TimeAgo date={a.ack.at} />{t('common.colon')}<span className="text-fg">{a.ack.reason}</span>
          </p>
        )}
        <AlertActions a={a} />
      </div>
      <div className="shrink-0 text-right">
        <div className="text-2xs uppercase tracking-wide text-subtle">{a.env}</div>
        <div className="text-xs text-muted" title={new Date(a.since).toLocaleString(localeTag())}>
          {t('alerts.since', { d: duration(Date.now() - a.since) })}
        </div>
      </div>
    </li>
  )
}

// Bulk actions (admin). Select all (visible alerts, filter applied), one button per rule + host
// group of at least two alerts, an action bar on the selection. Acts only on the checked alerts
// that are STILL visible; the server answers alert by alert.
// children: the list, in the same container as the bar (otherwise "sticky" does not hold)
function BulkBar({ visible, selected, setSelected, children }) {
  const { act, notify } = useAdmin()
  const [dialog, setDialog] = useState(null)
  const keys = effective(selected, visible)
  const all = visible.map(a => a.key)
  const clear = () => setSelected(new Set())
  const close = () => setDialog(null)
  async function run(url, body, invalidate, done) {
    // selection gone while the dialog was open (alerts resolved in the meantime)
    if (!keys.length) {
      notify(t('alerts.no_selected_alert_active'))
      close()
      return clear()
    }
    const r = await act(url, body, { invalidate })
    notify(resultText(r, done), r.ok ? 'ok' : 'crit')
    close()
    clear()
  }
  const n = keys.length
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
        <label className="mr-1 inline-flex items-center gap-1.5">
          <input type="checkbox" checked={all.length > 0 && n === all.length} onChange={() => setSelected(toggle(new Set(keys), all))} /> {t('alerts.select_all', { n: all.length })}
        </label>
        {groups(visible).map(g => (
          <button key={g.id} type="button" className={`${small} aria-pressed:border-accent aria-pressed:text-accent`} aria-pressed={g.keys.every(k => selected.has(k))} onClick={() => setSelected(toggle(selected, g.keys))}>
            {g.label} ({g.keys.length})
          </button>
        ))}
      </div>
      {n > 0 && (
        <div className="sticky top-16 max-sm:top-26 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2 text-xs shadow-lg" role="toolbar" aria-label={t('alerts.actions_selection')}>
          <span className="text-fg">{t('alerts.selected', { count: n })}</span>
          <button type="button" className={btnGhost} onClick={() => setDialog('ack')}>{t('alerts.acknowledge_2')}</button>
          {allPorts(keys) && <button type="button" className={btnGhost} onClick={() => setDialog('known')}>{t('alerts.mark_known')}</button>}
          <button type="button" className="ml-auto text-subtle hover:text-fg" onClick={clear}>{t('alerts.deselect')}</button>
        </div>
      )}
      {children}
      <AckDialog open={dialog === 'ack'} onClose={close} title={t('alerts.ack_n', { count: n })}
        onSubmit={reason => run('/api/alerts/ack/bulk', { keys, reason }, ['alerts'], [t('sel.acked_one'), t('sel.acked_many')])} />
      <Modal open={dialog === 'known'} onClose={close} title={t('alerts.known_title', { count: n })}>
        <ReasonForm submitLabel={t('alerts.mark_known_2')} onCancel={close} placeholder={t('alerts.example_new_nfs_ports')}
          onSubmit={reason => run('/api/agents/ports/known/bulk', { items: keys.map(portOf).filter(Boolean), reason }, ['alerts', 'agents'], [t('alerts.known_one'), t('alerts.known_many')])}>
          <p className="text-xs text-muted">{t('alerts.alerts_resolve_known_port')}</p>
        </ReasonForm>
      </Modal>
    </div>
  )
}

function Incidents({ items }) {
  if (!items.length) return <EmptyState icon={History} title={t('alerts.no_incidents_7_days')} />
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-subtle">
            <th className="px-3 py-2 font-medium">{t('alerts.start')}</th>
            <th className="px-3 py-2 font-medium">{t('alerts.alert')}</th>
            <th className="px-3 py-2 font-medium hidden sm:table-cell">{t('alerts.type')}</th>
            <th className="px-3 py-2 font-medium text-right">{t('alerts.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map(i => (
            <tr key={i.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted">{dayHm(i.startedAt)}</td>
              {/* w-full + max-w-0: the cell takes the remaining space and truncates instead of overflowing */}
              <td className="px-3 py-2 w-full max-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot state={i.resolvedAt ? 'ok' : SEV_STATE[i.severity]} size={12} label={i.resolvedAt ? t('alerts.resolved') : t('alerts.ongoing')} />
                  <span className="text-fg truncate">{i.title}</span>
                  {i.env === 'dev' && <span className="text-2xs uppercase text-subtle">dev</span>}
                  {i.suppressed && <span className="text-2xs text-subtle" title={i.suppressed}>{t('alerts.hidden')}</span>}
                  {i.ack && <span className="text-2xs text-ok" title={t('alerts.ack_hint', { by: i.ack.by, reason: i.ack.reason })}>{t('alerts.acknowledged')}</span>}
                </div>
                {i.summary && <div className="text-2xs text-subtle truncate" title={i.summary}>{i.summary}</div>}
              </td>
              <td className="px-3 py-2 text-xs text-muted hidden sm:table-cell">{RULE_LABEL[i.rule] || i.rule}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap text-xs">
                {i.resolvedAt
                  ? <span className="text-muted" title={`${hm(i.startedAt)} → ${hm(i.resolvedAt)}`}>{duration(i.resolvedAt - i.startedAt)}</span>
                  : <span className="text-crit font-medium">{t('alerts.ongoing')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Channel({ n }) {
  const items = []
  if (n.dryRun) items.push(['warn', t('alerts.test_mode_notifications_logged')])
  else if (!n.telegram) items.push(['warn', t('alerts.telegram_not_configured_alerts')])
  else if (n.lastError) items.push(['crit', t('alerts.tg_error', { msg: n.lastError.message })])
  else items.push(['ok', t('alerts.telegram_connected')])
  if (n.heartbeat) {
    items.push(n.heartbeat.lastError
      ? ['crit', t('alerts.hc_error', { err: n.heartbeat.lastError })]
      : ['ok', t('alerts.healthchecks_io_pingue')])
  } else items.push(['unknown', t('alerts.no_dead_man_switch')])
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([st, text]) => (
        <div key={text} className="flex items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2.5 text-xs text-fg">
          <StatusDot state={st} size={14} />
          <span className="min-w-0">{text}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2.5 text-xs text-fg">
        <BellOff size={14} className="text-subtle shrink-0" aria-hidden />
        <span>
          {t('alerts.quiet', { start: n.quietHours.start, end: n.quietHours.end })}{n.quietNow ? t('alerts.quiet_now') : ''}{t('alerts.digest_at', { at: n.digestAt })}
          {n.deferred > 0 && t('alerts.deferred', { count: n.deferred })}
        </span>
      </div>
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-2.5 text-xs text-fg">
        <Send size={14} className="text-subtle shrink-0" aria-hidden />
        <span>
          {n.lastSentAt ? <>{t('alerts.last_sent')} <TimeAgo date={n.lastSentAt} /></> : t('alerts.nothing_sent')}
          {n.queued > 0 && t('alerts.queued', { count: n.queued })}
        </span>
      </div>
    </div>
  )
}

// active silences: target, reason, author, end; lifting and creation
function Silences() {
  const q = useSource('silences')
  const services = useSource('services')
  const { act, isAdmin, requireLogin } = useAdmin()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('host')
  const [value, setValue] = useState('')
  const list = q.data?.active ?? []
  const options = {
    host: (services.data?.hosts ?? []).map(h => [h.id, h.name]),
    service: (services.data?.services ?? []).map(s => [s.id, s.name]),
    rule: Object.entries(RULE_LABEL),
  }
  const guard = fn => () => (isAdmin ? fn() : requireLogin(fn))
  return (
    <Panel icon={BellRing} title={t('alerts.silences_2')} query={q} right={
      <button type="button" onClick={guard(() => setOpen(true))} className={`${btnGhost} inline-flex items-center gap-1`}><Plus size={12} aria-hidden /> {t('alerts.new')}</button>
    }>
      {list.length
        ? (
          <ul className="space-y-2">
            {list.map(s => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2.5 text-xs">
                <BellOff size={14} className="text-maint" aria-hidden />
                <span className="font-medium text-fg">{s.target}</span>
                <span className="text-muted">{s.reason}</span>
                <span className={s.endsAt ? 'text-subtle' : 'text-warn'}>{until(s.endsAt)}</span>
                <span className="text-subtle">{t('alerts.by', { by: s.createdBy, src: s.source === 'telegram' ? 'Telegram' : t('alerts.src_dashboard') })}</span>
                <button type="button" className={`${btnGhost} ml-auto`} onClick={guard(() => act('/api/silences/end', { id: s.id }, { invalidate: ['silences', 'alerts'], success: t('alerts.silence_lifted') }))}>{t('alerts.lift')}</button>
              </li>
            ))}
          </ul>
        )
        : <p className="text-xs text-subtle">{t('alerts.no_silence_a')}<code>/mute</code>{t('alerts.no_silence_b')}</p>}
      <SilenceDialog open={open && !!value} onClose={() => { setOpen(false); setValue('') }} targets={[[`${t(`alerts.kind.${kind}`)} ${value}`, { [kind]: value }]]} title={t('alerts.new_silence')} />
      <Modal open={open && !value} onClose={() => setOpen(false)} title={t('alerts.new_silence_target')}>
        <div className="space-y-3">
          <select value={kind} onChange={e => setKind(e.target.value)} className={field} aria-label={t('alerts.target_type')}>
            <option value="host">{t('alerts.kind.host')}</option><option value="service">{t('alerts.kind.service')}</option><option value="rule">{t('alerts.kind_rule_option')}</option>
          </select>
          <select defaultValue="" onChange={e => setValue(e.target.value)} className={field} aria-label={t('alerts.target')}>
            <option value="" disabled>{t('alerts.choose')}</option>
            {options[kind].map(([id, label]) => <option key={id} value={id}>{label}{label !== id ? ` (${id})` : ''}</option>)}
          </select>
        </div>
      </Modal>
    </Panel>
  )
}

export default function Alerts() {
  const query = useSource('alerts')
  const [env] = useEnv()
  const { isAdmin } = useAdmin()
  const [selected, setSelected] = useState(() => new Set())
  const d = query.data
  // on every update, the selection drops the alerts that are no longer active; a resolved alert
  // that comes back later with the same key does not reappear already checked
  useEffect(() => {
    if (d) setSelected(cur => prune(cur, d.active))
  }, [d])
  const active = d?.active.filter(a => matchEnv(env, a.env)) ?? []
  const incidents = d?.incidents.filter(i => matchEnv(env, i.env)) ?? []
  const grace = d && d.notifier.graceUntil > Date.now()
  const list = (
    <ul className="space-y-2">
      {active.map(a => (
        <AlertRow key={a.key} a={a} env={env}
          select={isAdmin ? { checked: selected.has(a.key), onChange: () => setSelected(cur => toggle(cur, [a.key])) } : null} />
      ))}
    </ul>
  )
  return (
    <>
      {/* Notifications first, then Active alerts, Silences, History */}
      {d && (
        <Panel icon={Send} title={t('alerts.notifications')}>
          <Channel n={d.notifier} />
        </Panel>
      )}
      <Panel icon={Bell} title={t('alerts.active_alerts')} query={query} skeleton={<Skeleton count={2} h="h-16" cols="" />}>
        {grace && (
          <p className="mb-3 text-xs text-muted">{t('alerts.grace', { s: Math.ceil((d.notifier.graceUntil - Date.now()) / 1000) })}</p>
        )}
        {/* selection and bulk actions, admin session only */}
        {active.length && isAdmin
          ? <BulkBar visible={active} selected={selected} setSelected={setSelected}>{list}</BulkBar>
          : active.length
            ? list
            : <EmptyState icon={Bell} title={t('alerts.no_active_alerts')} hint={t('alerts.services_proxmox_backups_storages')} />}
      </Panel>
      <Silences />
      {d && (
        <Panel icon={History} title={t('alerts.history_7_days')}>
          <Incidents items={incidents} />
        </Panel>
      )}
    </>
  )
}

import { useState } from 'react'
import { useAdmin, Modal, ReasonForm, field, btnGhost, btnPrimary } from './admin.jsx'
import { useSource } from './api.js'
import { typeOf, deviceName } from './lib/deviceTypes.js'
import { netKeys } from './lib/netKeys.js'
import { t, tLabels } from './i18n/index.js'

// query keys to invalidate after a network write (list, open record)
const UNLINK = '\u0000unlink' // value of the "unlink" choice (never a host id)
// labels read at render time (form.profile.<profile>)
const PROFILES = tLabels('form.profile', ['fixed', 'normal', 'sleepy'])

// Editing a device (descriptive input, no reason): name, type, location, notes, linked host;
// presence: profile, expected IP, offline alert and its severity. An empty value clears the
// input: the best discovered value takes over. Only case with a reason: unchecking the offline
// alert while it is firing (the server then requires it).
export default function DeviceForm({ open, onClose, device, types = [] }) {
  const { act } = useAdmin()
  const services = useSource('services', { enabled: open })
  const hosts = services.data?.hosts ?? []
  // hosts already linked to ANOTHER record (list already loaded by the view): grayed out, prevents the 409
  const net = useSource('network', { enabled: open })
  const takenBy = new Map((net.data?.devices ?? []).filter(x => x.hostId && x.id !== device?.id).map(x => [x.hostId, x]))
  const s = device?.saisie ?? {}
  const [form, setForm] = useState(null)
  const init = {
    name: s.name ?? '', type: s.type ?? '', location: s.location ?? '', notes: s.notes ?? '', hostId: device?.hostSrc === 'user' ? device.hostId ?? '' : '',
    profile: s.profile ?? '', expectedIp: s.expectedIp ?? '', alertDown: !!s.alertDown, alertSeverity: s.alertSeverity ?? '', reason: '',
  }
  const v = form ?? init
  const set = k => e => setForm({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const [busy, setBusy] = useState(false)
  const close = () => {
    setForm(null)
    onClose()
  }
  if (!device) return null
  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const body = { id: device.id, name: v.name.trim() || null, type: v.type || null, location: v.location.trim() || null, notes: v.notes.trim() || null }
      // linked host: sent only if it changed (a discovered link stays discovered)
      // "unlink": discovered link lifted, and blocked (no automatic link to this host)
      if ((device.hostSrc === 'user' ? device.hostId ?? '' : '') !== v.hostId) body.hostId = v.hostId === UNLINK ? null : v.hostId || null
      // presence: fields sent only if they change
      if (v.profile !== init.profile) body.profile = v.profile || null
      if (v.expectedIp.trim() !== init.expectedIp) body.expectedIp = v.expectedIp.trim() || null
      if (v.alertSeverity !== init.alertSeverity) body.alertSeverity = v.alertSeverity || null
      if (v.alertDown !== init.alertDown) {
        body.alertDown = v.alertDown
        if (!v.alertDown && v.reason.trim()) body.reason = v.reason.trim()
      }
      await act('/api/network/devices/edit', body, { invalidate: netKeys(device.id), success: t('form.device_edited') })
      close()
    } catch { /* message already shown */ } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={close} title={t('form.title', { name: device.name || device.mac })}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-muted">{t('form.name')}
          <input value={v.name} onChange={set('name')} maxLength={64} className={`${field} mt-1`} placeholder={device.name || t('form.discovered_name')} />
        </label>
        <label className="block text-xs text-muted">{t('form.type')}
          <select value={v.type} onChange={set('type')} className={`${field} mt-1`}>
            <option value="">{t('form.guessed_opt', { v: device.type ? t('common.suffix', { v: typeOf(device.type).label }) : '' })}</option>
            {types.map(ty => <option key={ty} value={ty}>{typeOf(ty).label}</option>)}
          </select>
        </label>
        <label className="block text-xs text-muted">{t('form.location')}
          <input value={v.location} onChange={set('location')} maxLength={64} className={`${field} mt-1`} />
        </label>
        <label className="block text-xs text-muted">{t('form.notes')}
          <textarea value={v.notes} onChange={set('notes')} maxLength={500} rows={3} className={`${field} mt-1`} />
        </label>
        <label className="block text-xs text-muted">{t('form.host')}
          <select value={v.hostId} onChange={set('hostId')} aria-describedby="host-identity-help" className={`${field} mt-1`}>
            <option value="">— {device.hostId && device.hostSrc !== 'user' ? t('form.discovered_host', { host: device.hostId }) : device.hostSrc === 'user' && !device.hostId ? t('form.none_unlinked') : t('form.none')} —</option>
            {device.hostId && <option value={UNLINK}>{t('form.unlink', { host: device.hostId })}</option>}
            {hosts.map(h => {
              const other = takenBy.get(h.id)
              return <option key={h.id} value={h.id} disabled={!!other}>{h.name} ({h.id}){other ? t('form.taken', { id: other.id, name: deviceName(other) }) : ''}</option>
            })}
          </select>
          <span id="host-identity-help" className="mt-1 block text-2xs text-subtle">
            {t('form.help_a')}<b>{t('form.help_is')}</b>{t('form.help_b')}<b>{t('form.help_under')}</b>{t('form.help_c')}
          </span>
        </label>
        <fieldset className="space-y-3 border-t border-line pt-3">
          <legend className="text-2xs font-semibold uppercase tracking-wider text-muted">{t('form.presence')}</legend>
          <label className="block text-xs text-muted">{t('form.profile_label')}
            <select value={v.profile} onChange={set('profile')} className={`${field} mt-1`}>
              <option value="">{t('form.guessed_opt', { v: device.profile && !device.profileSet ? t('common.suffix', { v: PROFILES[device.profile] ?? device.profile }) : '' })}</option>
              {Object.entries(PROFILES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="block text-xs text-muted">{t('form.expected_ip')}
            <input value={v.expectedIp} onChange={set('expectedIp')} maxLength={15} inputMode="decimal" className={`${field} mt-1 font-mono`} placeholder={device.ip || '10.0.0.x'} />
          </label>
          <label className="flex items-center gap-2 text-xs text-fg">
            <input type="checkbox" checked={v.alertDown} onChange={set('alertDown')} />
            {t('form.alert_when_device_goes')}
          </label>
          {v.alertDown && (
            <label className="block text-xs text-muted">{t('form.severity')}
              <select value={v.alertSeverity} onChange={set('alertSeverity')} className={`${field} mt-1`}>
                <option value="">{t('form.warning_default')}</option>
                <option value="info">{t('form.information')}</option>
                <option value="warning">{t('form.warning')}</option>
                <option value="critical">{t('form.critical')}</option>
              </select>
            </label>
          )}
          {init.alertDown && !v.alertDown && (
            <label className="block text-xs text-muted">{t('form.reason')}
              <input value={v.reason} onChange={set('reason')} maxLength={200} className={`${field} mt-1`} placeholder={t('form.example_device_unplugged_good')} />
            </label>
          )}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className={btnGhost}>{t('form.cancel')}</button>
          <button type="submit" disabled={busy} className={btnPrimary}>{t('form.save')}</button>
        </div>
      </form>
    </Modal>
  )
}

// network action that requires a reason: Known, Delete, Merge, Same device, Detach, MAC rule,
// dismiss a suggestion
export function ActionDialog({ open, onClose, title, label, url, body, invalidate, success, placeholder, canSubmit = true, children }) {
  const { act } = useAdmin()
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ReasonForm submitLabel={label} onCancel={onClose} placeholder={placeholder} canSubmit={canSubmit} onSubmit={async reason => {
        const b = typeof body === 'function' ? body() : body
        await act(url, { ...b, reason }, { invalidate, success })
        onClose()
      }}>
        {children}
      </ReasonForm>
    </Modal>
  )
}

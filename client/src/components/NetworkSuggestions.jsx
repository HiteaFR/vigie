import { useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { useAdmin, field, btnGhost, btnPrimary } from '../admin.jsx'
import { ActionDialog } from '../DeviceForm.jsx'
import { netKeys } from '../lib/netKeys.js'
import { deviceName } from '../lib/deviceTypes.js'
import { localeTag, t } from '../i18n/index.js'

const card = 'rounded-[var(--radius-card)] border border-line bg-surface'

// Warnings of a merge suggestion (different typed names, overlapping lifetimes), as text above
// the merge button; the server provides the text
function SuggestionWarnings({ s }) {
  if (!s.warnings?.length) return null
  return (
    <ul className="basis-full space-y-0.5 text-warn" aria-label={t('netsug.warnings')}>
      {s.warnings.map(w => <li key={w.kind}>⚠ {w.text}</li>)}
    </ul>
  )
}

// Grouping suggestions: families of rotating MACs (tablet) and records of the same device
// (phone that changed its private MAC). Nothing is applied without human validation, with a
// reason; "Dismiss" removes it for good.
export default function NetworkSuggestions({ suggestions = [], devices = [] }) {
  const { isAdmin } = useAdmin()
  const [dialog, setDialog] = useState(null) // { s, kind: 'apply' | 'dismiss', target }
  if (!isAdmin || !suggestions.length) return null
  const byId = new Map(devices.map(d => [d.id, d]))
  const close = () => setDialog(null)
  return (
    <section className="mb-4 space-y-2" aria-label={t('netsug.grouping_suggestions')}>
      {suggestions.map(s => {
        const list = s.devices.map(id => byId.get(id)).filter(Boolean)
        return (
          <div key={s.key} className={`${card} flex flex-wrap items-center gap-2 border-l-[3px] border-l-info px-3 py-2 text-xs`}>
            <Lightbulb size={14} className="shrink-0 text-info" aria-hidden />
            <span className="min-w-0 flex-1 text-fg">
              {s.kind === 'family'
                ? <>{t('netsug.family', { name: s.name, n: s.macs })}<span className="font-mono">{s.prefix}:*</span>{list.length > 1 ? t('netsug.family_many', { n: list.length }) : t('netsug.family_one')}</>
                : <>{t('netsug.same_device', { n: list.length, name: s.name })}</>}
            </span>
            <SuggestionWarnings s={s} />
            <button type="button" className={btnPrimary} onClick={() => setDialog({ s, kind: 'apply', target: s.devices[0] })}>{s.kind === 'family' ? t('netsug.confirm') : t('netsug.merge')}</button>
            <button type="button" className={btnGhost} onClick={() => setDialog({ s, kind: 'dismiss' })}>{t('netsug.dismiss')}</button>
          </div>
        )
      })}
      {dialog?.kind === 'apply' && (
        <ActionDialog open onClose={close} invalidate={netKeys()}
          title={dialog.s.kind === 'family' ? t('netsug.family_title', { name: dialog.s.name }) : t('netsug.merge_title', { name: dialog.s.name })}
          label={dialog.s.kind === 'family' ? t('netsug.confirm_family') : t('netsug.merge_2')}
          success={dialog.s.kind === 'family' ? t('netsug.family_confirmed') : t('netsug.devices_merged')}
          url={dialog.s.kind === 'family' ? '/api/network/mac-rules' : '/api/network/devices/merge'}
          body={() => (dialog.s.kind === 'family'
            ? { prefix: dialog.s.prefix, action: 'attach', name: dialog.s.name, deviceId: dialog.target, mergeDevices: dialog.s.devices }
            : { into: dialog.target, from: dialog.s.devices.filter(id => id !== dialog.target) })}
          placeholder={t('netsug.example_same_remote_rotating')}>
          <div className="text-xs"><SuggestionWarnings s={dialog.s} /></div>
          <label className="block text-xs text-muted">{t('netsug.device_kept')}
            <select value={dialog.target} onChange={e => setDialog({ ...dialog, target: Number(e.target.value) })} className={`${field} mt-1`}>
              {dialog.s.devices.map(id => byId.get(id)).filter(Boolean).map(d => (
                <option key={d.id} value={d.id}>#{d.id} {deviceName(d)}{d.firstSeen ? t('netsug.seen_on', { date: new Date(d.firstSeen).toLocaleDateString(localeTag()) }) : ''}</option>
              ))}
            </select>
          </label>
        </ActionDialog>
      )}
      {dialog?.kind === 'dismiss' && (
        <ActionDialog open onClose={close} invalidate={netKeys()} title={t('netsug.dismiss_suggestion')} label={t('netsug.dismiss_2')} success={t('netsug.suggestion_dismissed')}
          url="/api/network/suggestions/dismiss" body={{ key: dialog.s.key }} placeholder={t('netsug.example_two_distinct_devices')} />
      )}
    </section>
  )
}

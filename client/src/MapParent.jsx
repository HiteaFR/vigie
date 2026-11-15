import { useState } from 'react'
import { Network } from 'lucide-react'
import { useSource } from './api.js'
import { useAdmin, Modal, ReasonForm, field, btnGhost } from './admin.jsx'
import { netKeys } from './lib/netKeys.js'
import Section from './ui/Section.jsx'
import { deviceName } from './lib/deviceTypes.js'
import { t, tLabels } from './i18n/index.js'

// "Parent on the map": effective parent of the record (mapParent, same computation as the map)
// and its origin; admin: change the parent (typed link, link routes as they are) or remove the
// typed link. Replacing a typed link in one step: links/remove then links with the SAME reason;
// if the second call fails, the initial link is restored right away; the server error, shown by
// act() as text, is shown only once.
const TOPO_KEY = '/api/network/topology'
// labels read at render time (map.kind.<type>, map.origin.<origin>)
const KINDS = ['uplink', 'wifi', 'ethernet', 'other']
const KIND_LABEL = tLabels('map.kind', KINDS)
const ORIGIN = {
  manual: () => t('map.origin.manual'),
  config: () => t('map.origin.config'),
  pve: () => t('map.origin.pve'),
  agent: p => t('map.origin.agent', { container: p.originContainer }),
  service: p => t('map.origin.service', { service: p.originService }),
  external: () => t('map.origin.external'),
  default: () => t('map.origin.default'),
}
export const originText = p => (ORIGIN[p.origin] ?? (() => p.origin))(p)

export default function MapParent({ d }) {
  const { isAdmin, act, notify } = useAdmin()
  const [dialog, setDialog] = useState(null)
  const p = d.mapParent
  if (!p) return null
  const close = () => setDialog(null)
  const link = p.origin === 'manual' ? p.link : null
  return (
    <Section icon={Network} title={t('map.parent_map')}>
      <div className="flex flex-wrap items-baseline gap-x-2 px-3 py-2 text-xs">
        <span className="text-fg">{p.label}</span>
        {p.ip && <span className="font-mono text-subtle">{p.ip}</span>}
        <span className="text-muted">({originText(p)})</span>
        {link && <span className="text-subtle">· {KIND_LABEL[link.kind] ?? link.kind}{link.port ? t('map.port', { port: link.port }) : ''}{link.note ? ` · ${link.note}` : ''}</span>}
      </div>
      {isAdmin && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          <button type="button" className={btnGhost} onClick={() => setDialog('change')}>{t('map.change_parent')}</button>
          {link && <button type="button" className={btnGhost} onClick={() => setDialog('remove')}>{t('map.remove_typed_link')}</button>}
        </div>
      )}
      {dialog === 'change' && <ChangeParent d={d} p={p} link={link} act={act} notify={notify} onClose={close} />}
      <Modal open={dialog === 'remove'} onClose={close} title={t('map.remove_typed_link_2')}>
        {link && (
          <ReasonForm submitLabel={t('map.remove')} onCancel={close} placeholder={t('map.example_cable_unplugged')} onSubmit={async reason => {
            await act('/api/network/links/remove', { id: link.id, reason }, { invalidate: [...netKeys(d.id), TOPO_KEY], success: t('map.link_removed_deduced_parent') })
            close()
          }}>
            <p className="text-xs text-muted">{t('map.deduced_parent_config_proxmox')}</p>
          </ReasonForm>
        )}
      </Modal>
    </Section>
  )
}

// list of possible parents: internet, config hosts, unlinked records; neither the record itself
// nor gw: (the server remains the judge of cycles)
function ChangeParent({ d, p, link, act, notify, onClose }) {
  const services = useSource('services')
  const net = useSource('network')
  const [q, setQ] = useState('')
  const [parent, setParent] = useState('')
  const [kind, setKind] = useState('uplink')
  const self = d.hostId ? `host:${d.hostId}` : `dev:${d.id}`
  const options = [
    { ref: 'internet', label: 'Internet', ip: null, id: 'internet' },
    ...(services.data?.hosts ?? []).map(h => ({ ref: `host:${h.id}`, label: h.name, ip: h.ip ?? null, id: h.id })),
    ...(net.data?.devices ?? []).filter(x => !x.hostId).map(x => ({ ref: `dev:${x.id}`, label: deviceName(x), ip: x.ip ?? null, id: String(x.id) })),
  ].filter(o => o.ref !== self)
  const s = q.trim().toLowerCase()
  const shown = options.filter(o => !s || [o.label, o.id, o.ip].some(v => v && String(v).toLowerCase().includes(s))).slice(0, 100)
  const invalidate = [...netKeys(d.id), TOPO_KEY]

  async function submit(reason) {
    const body = { child: `dev:${d.id}`, parent, kind, reason }
    if (!link) {
      await act('/api/network/links', body, { invalidate, success: t('map.parent_typed') })
      return onClose()
    }
    // replacement in one step: removal, then set; restore if setting fails
    await act('/api/network/links/remove', { id: link.id, reason }, { invalidate })
    try {
      await act('/api/network/links', body, { invalidate, success: t('map.parent_replaced') })
      return onClose()
    } catch (e) {
      const initial = { child: `dev:${d.id}`, parent: p.ref, kind: link.kind, port: link.port, note: link.note, reason: `${reason}${t('map.restore_suffix')}`.slice(0, 200) }
      try {
        await act('/api/network/links', initial, { invalidate }) // no success shown: the error stays
      } catch {
        notify(t('map.restore_failed', { err: e.message, parent: p.label, kind: KIND_LABEL[link.kind] ?? link.kind }), 'crit')
      }
      throw e
    }
  }

  return (
    <Modal open onClose={onClose} title={t('map.change_title', { name: deviceName(d) })}>
      <ReasonForm submitLabel={link ? t('map.replace') : t('map.link')} onCancel={onClose} placeholder={t('map.example_plugged_office_switch')} onSubmit={async reason => {
        if (!parent) {
          notify(t('map.choose_parent'), 'crit')
          throw new Error(t('map.parent_missing'))
        }
        await submit(reason)
      }}>
        <p className="text-xs text-muted">{t('map.current', { label: p.label, origin: originText(p) })}{link ? t('map.replaced_hint') : t('map.priority_hint')}</p>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('map.search_parent_name_id')} aria-label={t('map.search_parent')} className={field} />
        <select value={parent} onChange={e => setParent(e.target.value)} required aria-label={t('map.parent')} className={field} size={6}>
          {shown.map(o => <option key={o.ref} value={o.ref}>{o.label}{o.ip ? ` · ${o.ip}` : ''} · {o.ref}</option>)}
        </select>
        <select value={kind} onChange={e => setKind(e.target.value)} aria-label={t('map.link_type')} className={field}>
          {KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </ReasonForm>
    </Modal>
  )
}

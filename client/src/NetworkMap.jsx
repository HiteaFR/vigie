import { useEffect, useMemo, useRef, useState } from 'react'
import { stratify, tree } from 'd3-hierarchy'
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom'
import { select } from 'd3-selection'
import { Search, Download, Pencil } from 'lucide-react'
import { useJson } from './api.js'
import { useAdmin, Modal, ReasonForm, field, btnGhost } from './admin.jsx'
import { useUrlParam } from './hooks/useUrlState.js'
import MapNode from './MapNode.jsx'
import { t } from './i18n/index.js'

// centers the view on a node (module function: the focus effect no longer depends on it)
function centerOn(zoomer, svgEl, layout, id) {
  const n = layout?.byId.get(id)
  if (n && zoomer) zoomer.translateTo(select(svgEl), n.y, n.x)
}

// Network map, loaded on demand (Map tab): horizontal tree Internet → gateway → hypervisors →
// guests, and devices. SVG rendered by React (escaped text, never HTML coming from the data);
// zoom and pan through d3-zoom; collapsible groups remembered in localStorage (try/catch).
// Edit mode (admin): click the child, then the parent, then give a reason; "Remove the typed
// link" on a node whose parent comes from a typed link.
const card = 'rounded-[var(--radius-card)] border border-line bg-surface'
const GROUPS_KEY = 'reseau.carte.groupes'
const TOPO_KEY = '/api/network/topology'
// link types, labels from map.kind.<type> (read at render time)
const KINDS = ['uplink', 'ethernet', 'wifi', 'other']

const readOpen = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'))
  } catch {
    return new Set()
  }
}
const saveOpen = set => {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([...set]))
  } catch { /* storage unavailable: the state stays in memory */ }
}
const linkPath = (s, t) => `M${s.y},${s.x}C${(s.y + t.y) / 2},${s.x} ${(s.y + t.y) / 2},${t.x} ${t.y},${t.x}`
const linkable = n => n.kind === 'device' || n.kind === 'host'

export default function NetworkMap() {
  const q = useJson(TOPO_KEY, 60_000)
  const topo = q.data
  const { isAdmin, act } = useAdmin()
  const [open, setOpen] = useState(readOpen)
  const [hover, setHover] = useState(null)
  const [, setD] = useUrlParam('d')
  const [, setH] = useUrlParam('h')
  const [focus] = useUrlParam('n')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(false)
  const [child, setChild] = useState(null)
  const [pair, setPair] = useState(null) // { child, parent } to confirm
  const [unlink, setUnlink] = useState(null) // node whose typed link is being removed
  const [form, setForm] = useState({ kind: 'uplink', port: '', note: '' })
  const svg = useRef(null)
  const zoomer = useRef(null)
  const [transform, setTransform] = useState(zoomIdentity)

  // visible nodes: a collapsed group replaces its members; expanded, it gives way to them
  const layout = useMemo(() => {
    if (!topo?.nodes?.length) return null
    const visible = topo.nodes
      .filter(n => (n.kind === 'group' ? !open.has(n.id) : !(n.group && !open.has(n.group))))
      .map(n => ({ ...n, collapsed: n.kind === 'group' }))
    try {
      const root = stratify().id(n => n.id).parentId(n => n.parent)(visible)
      tree().nodeSize([28, 230])(root)
      return { root, nodes: root.descendants(), links: root.links(), byId: new Map(root.descendants().map(d => [d.id, d])) }
    } catch {
      return null // inconsistent tree (should not happen: the server guarantees it, long cycles included, through the third pass of topology.js)
    }
  }, [topo, open])

  // zoom installed once the map exists (once the layout is ready)
  const hasLayout = layout != null
  useEffect(() => {
    if (!svg.current) return undefined
    const z = d3zoom().scaleExtent([0.2, 3]).on('zoom', e => setTransform(e.transform))
    zoomer.current = z
    const sel = select(svg.current)
    sel.call(z)
    z.translateTo(sel, 360, 0)
    return () => sel.on('.zoom', null)
  }, [hasLayout])

  const center = id => centerOn(zoomer.current, svg.current, layout, id)
  useEffect(() => {
    if (focus) centerOn(zoomer.current, svg.current, layout, focus)
  }, [focus, layout])

  if (q.isLoading) return <div className={`${card} h-96 animate-pulse`} />
  if (!layout) return <p className={`${card} px-4 py-3 text-sm text-muted`}>{t('netmap.unavailable')}{q.error ? t('common.suffix', { v: String(q.error.message || q.error) }) : ''}.</p>

  const path = hover ? new Set(layout.byId.get(hover)?.ancestors().map(a => a.id)) : null
  const toggle = id => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
    saveOpen(next)
  }
  function clickNode(n) {
    if (n.kind === 'group') return toggle(n.id)
    if (editing) {
      if (!child) return linkable(n) && setChild(n.id)
      if (n.id !== child) setPair({ child, parent: n.id })
      return undefined
    }
    if (n.link?.startsWith('?d=')) setD(n.link.slice(3))
    else if (n.link?.startsWith('?h=')) setH(decodeURIComponent(n.link.slice(3)))
    return undefined
  }
  function find(e) {
    e.preventDefault()
    const s = search.trim().toLowerCase()
    const hit = s && topo.nodes.find(n => [n.label, n.ip].some(v => v && String(v).toLowerCase().includes(s)))
    if (!hit) return
    if (hit.group && !open.has(hit.group)) toggle(hit.group)
    setTimeout(() => center(hit.id), 0)
  }
  function exportSvg() {
    const blob = new Blob([new XMLSerializer().serializeToString(svg.current)], { type: 'image/svg+xml' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'reseau.svg' })
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const selected = editing && child ? layout.byId.get(child)?.data : null
  const done = () => {
    setPair(null)
    setChild(null)
    setUnlink(null)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <form onSubmit={find} className="relative min-w-48 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('netmap.center_on_name_ip')} aria-label={t('netmap.search_map')} className={`${field} w-full pl-8`} />
        </form>
        <button type="button" className={btnGhost} onClick={exportSvg}><Download size={12} className="mr-1 inline" aria-hidden />SVG</button>
        <a className={btnGhost} href="/api/network/topology.mmd" download><Download size={12} className="mr-1 inline" aria-hidden />Mermaid</a>
        {isAdmin && (
          <button type="button" className={`${btnGhost} ${editing ? 'border-accent text-fg' : ''}`} aria-pressed={editing}
            onClick={() => { setEditing(!editing); setChild(null) }}><Pencil size={12} className="mr-1 inline" aria-hidden />{editing ? t('netmap.done') : t('netmap.edit_links')}</button>
        )}
      </div>
      {editing && (
        <p className={`${card} flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted`}>
          {!child ? t('netmap.click_child') : <>{t('netmap.link_a')}<b className="text-fg">{selected?.label}</b>{t('netmap.link_b')}</>}
          {selected?.origin === 'manual' && selected.linkId && (
            <button type="button" className="text-accent hover:underline" onClick={() => setUnlink(selected)}>{t('map.remove_typed_link')}</button>
          )}
          {child && <button type="button" className="ml-auto text-subtle hover:text-fg" onClick={() => setChild(null)}>{t('netmap.cancel')}</button>}
        </p>
      )}
      {topo.warnings?.length > 0 && <p className="text-2xs text-warn">{topo.warnings.join(' · ')}</p>}
      <div className={`${card} overflow-hidden`}>
        <svg ref={svg} role="img" aria-label={t('netmap.network_map')} className="block h-[70vh] w-full touch-none select-none">
          <g transform={transform.toString()}>
            {layout.links.map(l => (
              <path key={`${l.source.id}>${l.target.id}`} d={linkPath(l.source, l.target)} fill="none" strokeWidth={path?.has(l.target.id) ? 2 : 1}
                className={path?.has(l.target.id) ? 'stroke-accent' : l.target.data.origin === 'manual' ? 'stroke-accent/60' : 'stroke-line-strong'}
                strokeDasharray={l.target.data.origin === 'manual' ? '4 3' : undefined} />
            ))}
            {layout.nodes.map(n => (
              <MapNode key={n.id} node={n.data} x={n.x} y={n.y} dim={path && !path.has(n.id)} selected={focus === n.id}
                editing={editing && child === n.id} onClick={() => clickNode(n.data)} onHover={setHover} />
            ))}
          </g>
        </svg>
      </div>
      <Modal open={!!pair} onClose={done} title={t('netmap.link_map')}>
        {pair && (
          <ReasonForm submitLabel={t('netmap.link')} onCancel={done} placeholder={t('netmap.example_plugged_office_switch')} onSubmit={async reason => {
            await act('/api/network/links', { ...pair, kind: form.kind, port: form.port || null, note: form.note || null, reason }, { invalidate: [TOPO_KEY], success: t('netmap.link_typed') })
            done()
          }}>
            <p className="text-xs text-muted">{layout.byId.get(pair.child)?.data.label} → {layout.byId.get(pair.parent)?.data.label}</p>
            <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} aria-label={t('netmap.link_type')} className={field}>
              {KINDS.map(k => <option key={k} value={k}>{t(`map.kind.${k}`)}</option>)}
            </select>
            <input value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} maxLength={32} placeholder={t('netmap.port_optional')} aria-label={t('netmap.port')} className={field} />
            <input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} maxLength={200} placeholder={t('netmap.note_optional')} aria-label={t('netmap.note')} className={field} />
          </ReasonForm>
        )}
      </Modal>
      <Modal open={!!unlink} onClose={done} title={t('netmap.remove_typed_link')}>
        {unlink && (
          <ReasonForm submitLabel={t('netmap.remove')} onCancel={done} placeholder={t('netmap.example_cable_unplugged')} onSubmit={async reason => {
            await act('/api/network/links/remove', { id: unlink.linkId, reason }, { invalidate: [TOPO_KEY], success: t('netmap.link_removed_deduced_link') })
            done()
          }} />
        )}
      </Modal>
    </div>
  )
}

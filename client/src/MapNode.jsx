import { StatusDot } from './ui/Status.jsx'
import { originText } from './MapParent.jsx'
import { t } from './i18n/index.js'

// Network map node: state dot (shape readable without color), label and IP rendered as TEXT
// by React (escaped: never HTML coming from the data), counter for a collapsible group.
// x, y: position (horizontal tree); dim: outside the hovered path.
const LABEL_MAX = 28

const short = s => (String(s).length > LABEL_MAX ? `${String(s).slice(0, LABEL_MAX - 1)}…` : String(s))

export default function MapNode({ node, x, y, dim, selected, editing, onClick, onHover }) {
  const group = node.kind === 'group'
  const label = group ? `${node.label}${node.collapsed ? ' ▸' : ' ▾'}` : node.label
  return (
    <g transform={`translate(${y},${x})`} className={`cursor-pointer ${dim ? 'opacity-35' : ''}`}
      onClick={onClick} onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}
      role="button" tabIndex={0} aria-label={`${node.label}${node.ip ? `, ${node.ip}` : ''}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}>
      {/* origin of the parent ("by the agent (container X)"), as text, on hover */}
      {node.origin && node.kind !== 'group' && <title>{`${node.label} — ${originText(node)}`}</title>}
      {(selected || editing) && <circle r={13} className={selected ? 'fill-none stroke-accent' : 'fill-none stroke-warn'} strokeWidth={2} />}
      <g transform="translate(-8,-8)">
        <StatusDot state={group ? node.state : node.state} size={16} label={node.state} />
      </g>
      <text x={14} y={-1} className="fill-current text-[11px] text-fg">{short(label)}</text>
      {node.ip && <text x={14} y={11} className="fill-current font-mono text-[9px] text-subtle">{node.ip}</text>}
      {node.origin === 'manual' && <text x={-14} y={4} textAnchor="end" className="fill-current text-[9px] text-accent">{t('netmap.link_mark')}</text>}
    </g>
  )
}

import { useMemo } from 'react'
import { Star, Search, X, LayoutGrid, Bookmark, SearchX } from 'lucide-react'
import { useSource } from '../api.js'
import { useEnv, useUrlParam, matchEnv } from '../hooks/useUrlState.js'
import { useFavorites } from '../hooks/useFavorites.js'
import { STATES, RANK } from '../lib/state.js'
import { StatusBadge, StatusDot } from '../ui/Status.jsx'
import ServiceIcon from '../ui/ServiceIcon.jsx'
import Panel, { Skeleton } from '../ui/Panel.jsx'
import EmptyState from '../ui/EmptyState.jsx'
import { groupIcon } from '../ui/groupIcons.js'
import UptimeBand from '../ui/UptimeBand.jsx'
import WidgetFields from '../ui/WidgetFields.jsx'
import CompactTile from '../components/CompactTile.jsx'
import { hostLabel } from '../lib/hosts.js'
import { fmtUptime } from '../lib/format.js'
import { localeTag, t } from '../i18n/index.js'

const FILTER_STATES = ['crit', 'warn', 'unknown', 'ok']

function checkText(c) {
  if (c.type === 'tls') {
    if (c.tls?.daysLeft != null) return t('services.cert_days', { n: c.tls.daysLeft })
    return c.error || t('services.cert_unknown')
  }
  if (c.state === 'unknown') return t('services.pending')
  if (c.state === 'crit') return c.error || (c.code ? `HTTP ${c.code}` : t('services.unreachable'))
  const ms = c.latencyMs != null ? `${c.latencyMs} ms` : ''
  if (c.type === 'http') return [c.code ? `HTTP ${c.code}` : null, ms].filter(Boolean).join(' · ')
  return ms || 'ok'
}

function checkLabel(c) {
  return c.label || { http: null, tcp: 'TCP', tls: null, dns: 'DNS' }[c.type]
}

function CheckChip({ c }) {
  const label = checkLabel(c)
  const title = [c.target, c.error, c.tls?.validTo && t('services.expires', { date: new Date(c.tls.validTo).toLocaleDateString(localeTag()) }), c.tls?.issuer]
    .filter(Boolean).join(' · ')
  return (
    <li className="relative z-10 flex items-center gap-1 min-w-0 max-w-full rounded-[var(--radius-chip)] bg-surface-2 border border-line px-1.5 py-0.5 text-2xs" title={title}>
      <StatusDot state={c.state} size={10} />
      {label && <span className="text-muted truncate">{label}</span>}
      <span className={`font-mono truncate ${c.state === 'ok' ? 'text-muted' : STATES[c.state]?.text || 'text-muted'}`}>{checkText(c)}</span>
    </li>
  )
}

function FavButton({ service, fav, onToggle }) {
  const on = service.pinned || fav
  return (
    <button
      type="button"
      onClick={() => onToggle(service.id)}
      disabled={service.pinned}
      aria-pressed={on}
      aria-label={service.pinned ? t('services.fav_pinned', { name: service.name }) : on ? t('services.fav_remove', { name: service.name }) : t('services.fav_add', { name: service.name })}
      title={service.pinned ? t('services.pinned_config_json') : on ? t('services.remove_favorites') : t('services.add_favorites')}
      className="relative z-10 -m-1 p-1 rounded text-subtle hover:text-warn disabled:cursor-default disabled:hover:text-subtle"
    >
      <Star size={14} className={on ? 'fill-warn text-warn' : ''} aria-hidden />
    </button>
  )
}

// The whole tile is a link ("stretched link"); the star stays clickable on top

function Tile({ s, hosts, fav, onToggle, onHistory }) {
  const notOk = s.state !== 'ok' && s.state !== 'none'
  return (
    <article
      className={`group relative flex flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 transition hover:border-line-strong hover:bg-surface-2 ${notOk ? `border-l-[3px] ${STATES[s.state]?.border}` : ''}`}
    >
      <div className="flex items-start gap-3">
        <ServiceIcon name={s.name} iconUrl={s.iconUrl} iconUrlDark={s.iconUrlDark} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-fg">
              {s.url
                ? <a href={s.url} target="_blank" rel="noreferrer" className="after:absolute after:inset-0 after:rounded-[var(--radius-card)] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">{s.name}</a>
                : s.name}
            </h3>
            <span className="ml-auto flex items-center gap-2 shrink-0">
              {/* an all-green grid stays calm: full badge only when not "ok" */}
              {s.state === 'ok' ? <StatusDot state="ok" size={14} /> : <StatusBadge state={s.state} />}
              <FavButton service={s} fav={fav} onToggle={onToggle} />
            </span>
          </div>
          {s.desc && <p className="mt-0.5 text-xs text-muted line-clamp-2">{s.desc}</p>}
        </div>
      </div>
      <WidgetFields widget={s.widget} className="relative z-10" />
      {s.checks.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={t('services.probes')}>
          {s.checks.map(c => <CheckChip key={c.id} c={c} />)}
        </ul>
      )}
      {s.checks.some(c => c.type !== 'tls') && (
        <button
          type="button"
          onClick={() => onHistory(s.id)}
          className="relative z-10 flex items-center gap-2 rounded px-0.5 -mx-0.5 text-2xs text-subtle hover:text-fg"
          title={t('services.history_24_h')}
          aria-label={t('services.history_aria', { name: s.name, up: fmtUptime(s.uptime24h) })}
        >
          <UptimeBand band={s.band24h} height="h-2.5" className="flex-1" />
          <span className="w-12 text-right tabular-nums">{fmtUptime(s.uptime24h)}</span>
        </button>
      )}
      <div className="mt-auto flex items-center gap-1.5 text-2xs text-subtle min-w-0">
        {s.host && <span className="truncate" title={s.container ? t('services.container', { name: s.container }) : undefined}>{hostLabel(s.host, hosts)}</span>}
        {s.host?.ip && <span className="font-mono truncate">· {s.host.ip}</span>}
        <span className="ml-auto shrink-0 uppercase tracking-wide">{s.env}</span>
      </div>
    </article>
  )
}


function FilterBar({ q, setQ, states, setStates, counts }) {
  const active = new Set(states ? states.split(',') : [])
  const toggle = st => {
    const next = new Set(active)
    next.has(st) ? next.delete(st) : next.add(st)
    setStates([...next].join(','))
  }
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <label className="relative flex-1 min-w-[200px] max-w-md">
        <span className="sr-only">{t('services.filter_services')}</span>
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('services.filter_name_ip_host')}
          className="w-full rounded-lg border border-line bg-surface pl-8 pr-8 py-1.5 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label={t('services.clear_filter')} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-fg">
            <X size={14} aria-hidden />
          </button>
        )}
      </label>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('services.filter_state')}>
        {FILTER_STATES.map(st => (
          <button
            key={st}
            type="button"
            aria-pressed={active.has(st)}
            onClick={() => toggle(st)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${active.has(st) ? `${STATES[st].bg} ${STATES[st].text} border-current` : 'border-line text-muted hover:border-line-strong'}`}
          >
            <StatusDot state={st} size={12} label="" />
            {STATES[st].label}
            <span className="tabular-nums opacity-80">{counts[st] || 0}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Bookmarks({ groups }) {
  if (!groups?.length) return null
  return (
    <Panel icon={Bookmark} title={t('services.web_bookmarks')}>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {groups.map(g => (
          <div key={g.group} className="min-w-0">
            <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">{g.group}</h3>
            <ul className="space-y-0.5">
              {g.items.map(it => (
                <li key={it.url}>
                  <a href={it.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-fg hover:bg-surface-3">
                    <ServiceIcon name={it.name} iconUrl={it.iconUrl} iconUrlDark={it.iconUrlDark} size={18} />
                    <span className="truncate">{it.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  )
}

// services of a group missing from groups[] must not disappear
function withOrphans(groups = [], services) {
  const known = new Set(groups.map(g => g.id))
  const orphan = services.some(s => !known.has(s.group))
  if (!orphan) return groups
  return [...groups, { id: '__other', name: t('services.others'), icon: 'folder' }]
}

function matches(s, needle) {
  if (!needle) return true
  const hay = [s.name, s.desc, s.group, s.container, s.url, s.host?.name, s.host?.ip, s.host?.id, s.host?.vmid, ...(s.tags || [])]
    .filter(v => v != null).join(' ').toLowerCase()
  return needle.toLowerCase().split(/\s+/).every(w => hay.includes(w))
}

export default function Services() {
  const query = useSource('services')
  const [env] = useEnv()
  const [q, setQ] = useUrlParam('q')
  const [states, setStates] = useUrlParam('state')
  const [favs, toggleFav] = useFavorites()
  const [, openHistory] = useUrlParam('s')
  const data = query.data

  const { inEnv, visible } = useMemo(() => {
    const inEnv = (data?.services || []).filter(s => matchEnv(env, s.env))
    const wanted = states ? new Set(states.split(',')) : null
    const visible = inEnv.filter(s => matches(s, q) && (!wanted || wanted.has(s.state)))
    return { inEnv, visible }
  }, [data, env, q, states])

  const counts = useMemo(() => {
    const c = {}
    for (const s of inEnv) c[s.state] = (c[s.state] || 0) + 1
    return c
  }, [inEnv])

  const pinned = visible
    .filter(s => s.pinned || favs.has(s.id))
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9))
  const filtering = Boolean(q || states)

  return (
    <>
      <Panel
        icon={LayoutGrid}
        title={t('services.services_2')}
        query={query}
        skeleton={<Skeleton count={9} h="h-32" cols="sm:grid-cols-2 lg:grid-cols-3" />}
      >
        <FilterBar q={q} setQ={setQ} states={states} setStates={setStates} counts={counts} />

        {pinned.length > 0 && !filtering && (
          <div className="mb-7">
            <h3 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
              <Star size={12} aria-hidden /> {t('services.pinned')}
            </h3>
            <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(150px,100%),1fr))]">
              {pinned.map(s => <CompactTile key={s.id} s={s} />)}
            </div>
          </div>
        )}

        {visible.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={filtering ? t('services.no_service_matches_filters') : t('services.no_services_environment')}
            hint={filtering ? t('services.broaden_search_remove_state') : undefined}
          />
        ) : withOrphans(data.groups, visible).map(g => {
          const known = new Set(data.groups.map(x => x.id))
          const list = visible.filter(s => (g.id === '__other' ? !known.has(s.group) : s.group === g.id))
          if (!list.length) return null
          const Icon = groupIcon(g.icon)
          return (
            <div key={g.id} className="mb-7">
              <h3 className="mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">
                <Icon size={12} aria-hidden /> {g.name}
                <span className="font-normal normal-case tracking-normal">· {list.length}</span>
              </h3>
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))]">
                {list.map(s => <Tile key={s.id} s={s} hosts={data.hosts} fav={favs.has(s.id)} onToggle={toggleFav} onHistory={openHistory} />)}
              </div>
            </div>
          )
        })}
      </Panel>

      <Bookmarks groups={data?.bookmarks} />
    </>
  )
}

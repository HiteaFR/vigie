import { useEffect } from 'react'
import { Command } from 'cmdk'
import { useLocation } from 'wouter'
import { Box, Container, Monitor, Sun, Moon, ExternalLink, Search } from 'lucide-react'
import { useSource } from './api.js'
import { useEnv } from './hooks/useUrlState.js'
import { VIEWS, withEnv } from './nav.js'
import { StatusDot } from './ui/Status.jsx'
import ServiceIcon from './ui/ServiceIcon.jsx'
import { hostLabel } from './lib/hosts.js'
import { typeOf, deviceState, freshnessText, deviceName } from './lib/deviceTypes.js'
import { t } from './i18n/index.js'

const itemCls = 'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer text-sm text-fg aria-disabled:opacity-50'

function Row({ icon, name, context, right }) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        {context && <span className="block truncate text-2xs text-subtle">{context}</span>}
      </span>
      {right}
    </>
  )
}

// substring search (every word): "105" must not match 10.0.0.105
function substringFilter(value, search, keywords = []) {
  const hay = [value, ...keywords].join(' ').toLowerCase()
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every(w => hay.includes(w))) return 0
  // names that start with the input first
  return keywords[0]?.toLowerCase().startsWith(words[0]) ? 1 : 0.5
}

const open = url => window.open(url, '_blank', 'noopener,noreferrer')

export default function CommandPalette({ isOpen, setOpen, setTheme }) {
  const [, navigate] = useLocation()
  const [env] = useEnv()
  const services = useSource('services', { enabled: isOpen })
  const cluster = useSource('cluster', { enabled: isOpen })
  const network = useSource('network', { enabled: isOpen })

  // Ctrl/Cmd+K toggles; "/" opens outside input fields
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        const t = e.target
        if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setOpen])

  const run = fn => () => { setOpen(false); fn() }
  const data = services.data
  const guests = (cluster.data || []).flatMap(c => (c.guests || []).map(g => ({ ...g, cluster: c.id, clusterLabel: c.label })))

  return (
    <Command.Dialog
      open={isOpen}
      onOpenChange={setOpen}
      label={t('palette.global_search')}
      filter={substringFilter}
      className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl max-md:h-full max-md:rounded-none max-md:border-0"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search size={16} className="text-subtle" aria-hidden />
        <Command.Input
          autoFocus
          placeholder={t('palette.service_ip_vmid_view')}
          className="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-subtle outline-none focus-visible:outline-none"
        />
        <button type="button" onClick={() => setOpen(false)} className="text-2xs text-subtle border border-line rounded px-1.5 py-0.5 font-mono">{t('palette.esc')}</button>
      </div>
      <Command.List className="max-h-[60vh] max-md:max-h-none max-md:flex-1 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">{t('palette.no_results')}</Command.Empty>

        {data && (
          <Command.Group heading={t('palette.services_2')}>
            {data.services.map(s => (
              <Command.Item
                key={s.id}
                value={`svc:${s.id}`}
                keywords={[s.name, s.desc, s.host?.ip, s.host?.name, s.host?.vmid && String(s.host.vmid), s.container, ...(s.tags || [])].filter(Boolean)}
                onSelect={run(() => (s.url ? open(s.url) : navigate(withEnv(`/services?q=${encodeURIComponent(s.name)}`, env))))}
                className={itemCls}
              >
                <Row
                  icon={<ServiceIcon name={s.name} iconUrl={s.iconUrl} iconUrlDark={s.iconUrlDark} size={20} />}
                  name={s.name}
                  context={[hostLabel(s.host, data.hosts), s.host?.ip, s.env].filter(Boolean).join(' · ')}
                  right={<><StatusDot state={s.state} size={13} />{s.url && <ExternalLink size={13} className="text-subtle" aria-hidden />}</>}
                />
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {guests.length > 0 && (
          <Command.Group heading={t('palette.proxmox_guests')}>
            {guests.map(g => {
              const Icon = g.type === 'lxc' ? Container : Box
              return (
                <Command.Item
                  key={`${g.cluster}/${g.vmid}`}
                  value={`guest:${g.cluster}/${g.vmid}`}
                  keywords={[g.name, String(g.vmid), g.type === 'lxc' ? 'ct lxc' : 'vm qemu', g.cluster, g.node]}
                  onSelect={run(() => navigate(withEnv('/infra', g.cluster)))}
                  className={itemCls}
                >
                  <Row
                    icon={<Icon size={18} className="text-subtle" aria-hidden />}
                    name={g.name}
                    context={`${g.type === 'lxc' ? 'CT' : 'VM'} ${g.vmid} · ${g.node} · ${g.cluster}`}
                    right={<StatusDot state={g.status === 'running' ? 'ok' : 'unknown'} size={13} label={g.status} />}
                  />
                </Command.Item>
              )
            })}
          </Command.Group>
        )}

        {network.data?.devices?.length > 0 && (
          <Command.Group heading={t('palette.lan_devices')}>
            {network.data.devices.map(d => {
              const T = typeOf(d.type)
              return (
                <Command.Item
                  key={`dev:${d.id}`}
                  value={`dev:${d.id}`}
                  keywords={[deviceName(d), d.ip, d.mac, d.vendor, T.label, d.hostId, t('palette.device_word')].filter(Boolean)}
                  onSelect={run(() => navigate(withEnv(`/network?d=${d.id}`, env)))}
                  className={itemCls}
                >
                  <Row
                    icon={<T.icon size={18} className="text-subtle" aria-hidden />}
                    name={deviceName(d)}
                    context={[d.ip, d.mac, d.vendor].filter(Boolean).join(' · ')}
                    right={<StatusDot state={deviceState(d)} size={13} label={d.state === 'new' ? t('palette.new') : freshnessText(d)} />}
                  />
                </Command.Item>
              )
            })}
          </Command.Group>
        )}

        {data?.bookmarks?.length > 0 && (
          <Command.Group heading={t('palette.web_bookmarks')}>
            {data.bookmarks.flatMap(b => b.items.map(it => (
              <Command.Item
                key={`${b.group}/${it.url}`}
                value={`bm:${b.group}/${it.name}`}
                keywords={[it.name, b.group, it.url]}
                onSelect={run(() => open(it.url))}
                className={itemCls}
              >
                <Row icon={<ServiceIcon name={it.name} iconUrl={it.iconUrl} iconUrlDark={it.iconUrlDark} size={20} />} name={it.name} context={b.group} right={<ExternalLink size={13} className="text-subtle" aria-hidden />} />
              </Command.Item>
            )))}
          </Command.Group>
        )}

        <Command.Group heading={t('palette.views')}>
          {VIEWS.map(v => (
            <Command.Item key={v.path} value={`view:${v.path}`} keywords={[v.label, 'vue', 'aller']} onSelect={run(() => navigate(withEnv(v.path, env)))} className={itemCls}>
              <Row icon={<v.icon size={18} className="text-subtle" aria-hidden />} name={v.label} context={t('palette.view')} />
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading={t('palette.actions')}>
          {[['light', t('palette.theme_light'), Sun], ['dark', t('palette.theme_dark'), Moon], ['auto', t('palette.theme_auto'), Monitor]].map(([th, label, Icon]) => (
            <Command.Item key={th} value={`theme:${th}`} keywords={[label, t('palette.theme_word'), 'theme']} onSelect={run(() => setTheme(th))} className={itemCls}>
              <Row icon={<Icon size={18} className="text-subtle" aria-hidden />} name={label} context={t('palette.action')} />
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}

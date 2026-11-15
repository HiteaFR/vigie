// Integrations page, read only. Core modules and plugins of the host (/api/plugins): state
// (active, not configured, failing with the latest plugin_error of each hook), version of the
// plugin interface. No secret and no config are read here.
import { Puzzle } from 'lucide-react'
import { useSource } from '../api.js'
import Panel from '../ui/Panel.jsx'
import { StatusDot } from '../ui/Status.jsx'
import TimeAgo from '../ui/TimeAgo.jsx'
import { card } from '../ui/Kpi.jsx'
import { t, tLabels } from '../i18n/index.js'

// labels read at render time (integrations.state.<state>, integrations.kind.<kind>)
const STATE = {
  active: { get label() { return t('integrations.state.active') }, dot: 'ok' },
  unconfigured: { get label() { return t('integrations.state.unconfigured') }, dot: 'none' },
  error: { get label() { return t('integrations.state.error') }, dot: 'crit' },
}
const KIND = tLabels('integrations.kind', ['core', 'plugin'])

export default function Integrations() {
  const q = useSource('plugins')
  const modules = q.data?.modules ?? []
  return (
    <Panel icon={Puzzle} title={t('integrations.integrations')} query={q}
      right={q.data ? <span className="text-2xs text-subtle">{t('integrations.api_prefix')}{q.data.apiVersion}{t('integrations.api_suffix')}</span> : null}>
      <ul className="grid gap-3 md:grid-cols-2">
        {modules.map(m => {
          const st = STATE[m.state] ?? STATE.error
          return (
            <li key={m.id} className={`${card} p-4`}>
              <div className="flex items-center gap-2">
                <StatusDot state={st.dot} size={12} label={st.label} />
                <span className="text-sm font-medium text-fg">{m.label}</span>
                <span className="ml-auto text-2xs text-subtle">{KIND[m.kind] ?? m.kind} · {st.label}</span>
              </div>
              {m.errors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {m.errors.map(e => (
                    <li key={e.hook} className="text-xs text-crit">
                      {e.hook}{t('common.suffix', { v: e.message })} <span className="text-2xs text-subtle">(<TimeAgo date={e.at} />)</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

// Example plugin, cockpit tile: reads its key of /api/summary (summary hook, server side).
import { ListOrdered } from 'lucide-react'
import { withEnv } from '../../nav.js'
import Kpi from '../../ui/Kpi.jsx'
import { t } from '../../i18n/index.js'

export function ExampleKpi({ s, env, mural }) {
  const e = s.example
  return (
    <Kpi mural={mural} icon={ListOrdered} label={t('example.tile.label')} value={e?.depth ?? '—'}
      sub={e?.depth == null ? t('example.tile.unknown') : t('example.tile.max', { max: e.max })}
      state={e?.depth == null ? 'unknown' : e.depth > e.max ? 'warn' : 'ok'} href={withEnv('/example', env)} />
  )
}

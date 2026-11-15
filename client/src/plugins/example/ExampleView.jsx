// Example plugin, view /example (a lazy chunk of the same build, like the core views).
import { ListOrdered } from 'lucide-react'
import { useJson } from '../../api.js'
import Panel from '../../ui/Panel.jsx'
import { card } from '../../ui/Kpi.jsx'
import { t } from '../../i18n/index.js'

export default function ExampleView() {
  const q = useJson('/api/example', 60_000)
  const over = q.data && q.data.depth > q.data.max
  return (
    <Panel icon={ListOrdered} title={t('example.view.title')} query={q}>
      {q.data && q.data.depth != null && (
        <div className={`${card} p-4 text-sm`}>
          <span className={over ? 'text-warn font-semibold' : 'text-fg'}>{q.data.depth}</span> {t('example.view.waiting', { count: q.data.depth, max: q.data.max })}
        </div>
      )}
    </Panel>
  )
}

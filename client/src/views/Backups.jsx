import { Archive } from 'lucide-react'
import { useSource } from '../api.js'
import { useEnv, matchEnv } from '../hooks/useUrlState.js'
import Panel from '../ui/Panel.jsx'
import BackupsGrid from '../components/BackupsGrid.jsx'
import { t } from '../i18n/index.js'

export default function Backups() {
  const backups = useSource('backups')
  const cluster = useSource('cluster')
  const [env] = useEnv()
  const data = backups.data?.filter(b => matchEnv(env, b.id))
  return (
    <Panel icon={Archive} title={t('backups.backups')} query={backups}>
      {data && <BackupsGrid data={data} clusters={cluster.data} />}
    </Panel>
  )
}

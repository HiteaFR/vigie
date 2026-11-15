import { Server } from 'lucide-react'
import { useSource } from '../api.js'
import { useEnv, matchEnv } from '../hooks/useUrlState.js'
import Panel, { Skeleton } from '../ui/Panel.jsx'
import InfraGrid from '../components/InfraGrid.jsx'
import { t } from '../i18n/index.js'

export default function Infra() {
  const cluster = useSource('cluster')
  const agents = useSource('agents')
  const proxmox = useSource('proxmox')
  const [env] = useEnv()
  const data = cluster.data?.filter(c => matchEnv(env, c.id))
  return (
    <Panel icon={Server} title={t('infra.infrastructure_vm_lxc')} query={cluster} skeleton={<Skeleton count={8} h="h-32" cols="sm:grid-cols-2 lg:grid-cols-4" />}>
      {data && <InfraGrid data={data} agents={agents.data?.hosts} proxmox={proxmox.data?.clusters} />}
    </Panel>
  )
}

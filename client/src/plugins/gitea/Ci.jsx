import { Cpu, GitBranch } from 'lucide-react'
import { useSource } from '../../api.js'
import Panel, { Skeleton } from '../../ui/Panel.jsx'
import EmptyState from '../../ui/EmptyState.jsx'
import Runners from './Runners.jsx'
import Gitea from './Gitea.jsx'
import { t } from '../../i18n/index.js'

// Gitea not configured (no gitea block in the config, or GITEA_URL missing): a single message,
// read at render time (plugin catalog)
export const giteaOffHint = () => t('gitea.off_hint')

export default function Ci() {
  const runners = useSource('runners')
  const gitea = useSource('gitea')
  if (gitea.data?.configured === false) return <EmptyState icon={GitBranch} title={t('gitea.off')} hint={giteaOffHint()} />
  return (
    <>
      <Panel icon={Cpu} title={t('gitea.runners_title')} query={runners}>
        {runners.data && <Runners data={runners.data} />}
      </Panel>
      <Panel icon={GitBranch} title={t('gitea.activity_title')} query={gitea} skeleton={<Skeleton count={4} h="h-24" cols="md:grid-cols-2" />}>
        {gitea.data && <Gitea data={gitea.data} />}
      </Panel>
    </>
  )
}

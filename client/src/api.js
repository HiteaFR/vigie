import { useQuery } from '@tanstack/react-query'
import { httpError } from './lib/httpError.js'
import { PLUGIN_SOURCES } from './plugins/meta.js'

// a failed read shows the server's message ({ error }), like writes do
async function j(url) {
  const r = await fetch(url)
  if (!r.ok) throw await httpError(r)
  return r.json()
}

// a source = a key + a refresh period (also used to compute "stale")
const SOURCES = {
  config: { url: '/api/config', period: 5 * 60_000 },
  services: { url: '/api/services', period: 15_000 },
  cluster: { url: '/api/cluster', period: 5_000 },
  backups: { url: '/api/backups', period: 60_000 },
  alerts: { url: '/api/alerts', period: 15_000 },
  bands: { url: '/api/history/bands?range=24h', period: 60_000 },
  agents: { url: '/api/agents', period: 30_000 },
  updates: { url: '/api/updates', period: 5 * 60_000 },
  proxmox: { url: '/api/proxmox', period: 60_000 },
  session: { url: '/api/session', period: 60_000 },
  silences: { url: '/api/silences', period: 30_000 },
  network: { url: '/api/network', period: 30_000 },
  // state of the modules and plugins (Integrations page)
  plugins: { url: '/api/plugins', period: 60_000 },
  // plugin sources (plugins/meta.js: gitea and runners of the gitea plugin)
  ...PLUGIN_SOURCES,
}

// parameterized request (env, range, id): the key follows the URL
export function useJson(url, period, opts = {}) {
  return useQuery({ queryKey: [url], queryFn: () => j(url), refetchInterval: period, enabled: !!url, ...opts })
}

export function useSource(name, opts = {}) {
  const s = SOURCES[name]
  const q = useQuery({ queryKey: [name], queryFn: () => j(s.url), refetchInterval: s.period, ...opts })
  return { ...q, period: s.period }
}

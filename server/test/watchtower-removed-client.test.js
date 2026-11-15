// Watchtower removed from the client. No more "auto-update" badge on the containers
// of the host drawer; the generic badge of the updates page stays, with a title without Watchtower.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast } from '../lib/agents.js'
import { clientBundle } from './client-render.js'

const container = over => ({ name: '/app', image: 'registry.example/app:1.2.3', imageId: 'sha256:abc', state: 'running', ...over })

const client = t => clientBundle(t, 'l11', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import Updates from './src/views/Updates.jsx'",
  "import HostDrawer from './src/HostDrawer.jsx'",
  'export function render(el, { seed = {}, search = "" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/", ssrSearch: search }, h(AdminProvider, null, el))))',
  '}',
  'export const updates = o => render(h(Updates), o)',
  'export const drawer = o => render(h(HostDrawer), o)',
])

test('client: host drawer without auto-update badge on the containers (even if the API returned watchtower); generic badge of the updates page kept', async t => {
  const c = await client(t)
  if (!c) return
  const fast = cleanFast({ version: 7, ts: 1, uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false },
    docker: { version: '29.9.1', containers: [container({ name: '/etiquete' })] } })
  fast.docker.containers[0].watchtower = true // old API: ignored by the client
  const host = { id: 'dk', name: 'docker-a', kind: 'vm', agent: 'ssh', ok: true, at: Date.now(), fast, slow: null, slowAt: null }
  const d = c.drawer({ seed: { agents: { hosts: [host] } }, search: 'h=dk' })
  assert.match(d, />etiquete<\/span>/)
  assert.doesNotMatch(d, /auto-MAJ|Watchtower/i)
  const comp = (id, auto) => ({ id, name: id, kind: 'app', host: 'dk', where: 'VM 201', env: 'prod', current: '1.0.0', latest: '1.1.0', gap: 'minor', auto })
  const u = c.updates({ seed: { updates: { checkedAt: new Date().toISOString(), counts: {}, sources: [], stats: null, components: [comp('auto-app', true), comp('main-app', false)] }, agents: { hosts: [] }, session: { admin: false } } })
  const row = id => u.split('<li ').find(x => x.includes(`title="${id}"`)) ?? ''
  assert.match(row('auto-app'), /title="se met à jour automatiquement \(config ou Home Assistant\)"><svg[\s\S]*?<\/svg>auto-MAJ<\/span>/)
  assert.doesNotMatch(row('main-app'), /auto-MAJ/)
  assert.doesNotMatch(u, /Watchtower/i)
})

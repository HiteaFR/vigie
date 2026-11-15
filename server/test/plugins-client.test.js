// Client-side plugin registries, client-side gitea plugin, Integrations page.
// /api/plugins route and host.view(): plugins-route.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from './client-render.js'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src')
const read = f => fs.readFileSync(path.join(CLIENT, f), 'utf8')

const client = t => clientBundle(t, 'p4c-client', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import Integrations from './src/views/Integrations.jsx'",
  "import { VIEWS } from './src/nav.js'",
  "import { MOBILE_MAX } from './src/Shell.jsx'",
  "import { RULE_LABEL } from './src/lib/alerts.js'",
  "export { VIEWS, MOBILE_MAX, RULE_LABEL }",
  'export function integrations(data) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchInterval: false } } })',
  "  qc.setQueryData(['plugins'], data)",
  "  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: '/integrations' }, h(Integrations))))",
  '}',
])

test('Integrations page: modules and plugins, state (active, not configured, failing with the last plugin_error), interface version', async t => {
  const c = await client(t)
  if (!c) return
  const html = c.integrations({ apiVersion: 0, modules: [
    { id: 'updates', label: 'versions', kind: 'core', state: 'active', errors: [] },
    { id: 'gitea', label: 'Gitea', kind: 'plugin', state: 'unconfigured', errors: [] },
    { id: 'casse', label: 'Cassé', kind: 'plugin', state: 'error', errors: [{ hook: 'signals', message: 'boom', at: '2026-11-12T09:00:00.000Z' }] },
  ] })
  assert.match(html, /interface des plugins v0 \(instable\)/)
  assert.match(html, /versions<\/span><span[^>]*>module du cœur · actif/)
  assert.match(html, /Gitea<\/span><span[^>]*>plugin · non configuré/)
  assert.match(html, /Cassé<\/span><span[^>]*>plugin · en erreur/)
  assert.match(html, /signals : boom/)
})

test('navigation: core and plugin registry, order from before the registries, Integrations at the bottom of the sidebar and outside the mobile bar; mobile bar limited to 8 entries (360 px)', async t => {
  const c = await client(t)
  if (!c) return
  assert.deepEqual(c.VIEWS.map(v => v.path), ['/', '/services', '/infra', '/network', '/updates', '/backups', '/ci', '/alerts', '/integrations'])
  const integ = c.VIEWS.find(v => v.path === '/integrations')
  assert.deepEqual([integ.placement, integ.mobile], ['bottom', false])
  assert.equal(c.MOBILE_MAX, 8)
  assert.equal(c.VIEWS.filter(v => v.mobile !== false).length, 8, 'mobile bar unchanged (grid-cols-8)')
  // labels: order from before the registries, gitea ones between backup_failed and source_error (order 75, 76)
  const keys = Object.keys(c.RULE_LABEL)
  assert.deepEqual(keys.slice(keys.indexOf('backup_failed'), keys.indexOf('backup_failed') + 4), ['backup_failed', 'ci_failed', 'runner_offline', 'source_error'])
  // the mobile bar keeps its classes (icon only under 360 px, short label above)
  const shell = read('Shell.jsx')
  // a class written in full for each number of entries from 1 to MOBILE_MAX (no undefined)
  const cols = shell.match(/const MOBILE_COLS = (\{[^}]*\})/)[1]
  for (let n = 1; n <= c.MOBILE_MAX; n++) assert.ok(cols.includes(`${n}: 'grid-cols-${n}'`), `grid-cols-${n}`)
  assert.match(shell, /<span className="sr-only min-\[360px\]:not-sr-only">\{v\.short \|\| v\.label\}<\/span>/)
})

test('structure: the client gitea plugin is complete and isolated (view, tiles, navigation, labels, sources); nothing of Gitea left outside client/src/plugins/', () => {
  for (const f of ['plugins/gitea/index.jsx', 'plugins/gitea/Ci.jsx', 'plugins/gitea/tiles.jsx', 'plugins/gitea/nav.js', 'plugins/gitea/meta.js', 'plugins/gitea/Gitea.jsx', 'plugins/gitea/Runners.jsx']) assert.ok(fs.existsSync(path.join(CLIENT, f)), f)
  for (const f of ['views/Ci.jsx', 'components/Gitea.jsx', 'components/Runners.jsx']) assert.ok(!fs.existsSync(path.join(CLIENT, f)), f)
  const files = fs.readdirSync(CLIENT, { recursive: true }).filter(f => /\.jsx?$/.test(f) && !f.startsWith('plugins'))
  for (const f of files) {
    const code = read(f).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')
    assert.doesNotMatch(code, /useSource\('(gitea|runners)'\)|\/api\/gitea|\/api\/runners|ci_failed|runner_offline|CiCard/, f)
  }
  // data without component or icon (read by lib/ and api.js); static registries, literal imports
  assert.doesNotMatch(read('plugins/meta.js') + read('plugins/gitea/meta.js'), /lucide-react|\.jsx'/)
  assert.match(read('plugins/index.jsx'), /^import gitea from '\.\/gitea\/index\.jsx'$/m)
})

// Client extraction. Catalog of the default locale in the main bundle, the other one in a
// chunk loaded before the first render; rule labels (core and plugins) via the catalog;
// "bootstrap" state of a port read from an API code (bootstrap), no longer from a text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { clientBundle } from './client-render.js'
import { createAgentMemory } from '../lib/agentmemory.js'
import { openDb } from '../lib/db.js'
import { tmpDir } from './tmpdir.js'

const read = p => fs.readFileSync(new URL(`../../client/src/${p}`, import.meta.url), 'utf8')

test('rule labels (core and plugins) via the client catalog, same keys and same order; en after loadLocale', async t => {
  const c = await clientBundle(t, 'p5d-labels', [
    "export { RULE_LABEL, labelIn } from './src/lib/alerts.js'",
    "export { loadLocale, setLocale, locale } from './src/i18n/index.js'",
  ])
  if (!c) return
  const keys = Object.keys(c.RULE_LABEL)
  assert.equal(keys[0], 'service_down')
  // gitea (75, 76) between backup_failed (70) and source_error (80), as before
  assert.deepEqual(keys.slice(keys.indexOf('backup_failed'), keys.indexOf('backup_failed') + 4), ['backup_failed', 'ci_failed', 'runner_offline', 'source_error'])
  assert.deepEqual([c.RULE_LABEL.backup_failed, c.RULE_LABEL.ci_failed, c.RULE_LABEL.net_agent_conflict], ['Sauvegarde en échec', 'CI en échec', "Conflit d'identité de conteneur"])
  assert.equal(await c.loadLocale('en'), 'en')
  try {
    assert.deepEqual([c.RULE_LABEL.backup_failed, c.RULE_LABEL.ci_failed, c.RULE_LABEL.runner_offline], ['Backup failed', 'CI failing', 'Runner offline'])
    assert.deepEqual(Object.keys(c.RULE_LABEL), keys)
  } finally {
    c.setLocale('fr')
  }
  assert.equal(c.labelIn('Texte'), 'Texte')
  assert.equal(c.labelIn({ en: 'Only' }), 'Only')
})

test('startup: main.jsx hands startup over to boot.js (executed by client-boot.test.js); catalogs in separate chunks', () => {
  const main = read('main.jsx')
  assert.match(main, /import \{ boot, showFatal \} from '\.\/boot\.js'/)
  assert.match(main, /onConfig: config => queryClient\.setQueryData\(\['config'\], config\)/)
  assert.match(main, /fail: \(\) => showFatal\(root\)/)
  assert.doesNotMatch(main, /createRoot\([^)]*\)\.render[\s\S]*boot\(/, 'no render outside boot')
  const i18n = read('i18n/index.js')
  // no catalog in the main bundle: each locale is a chunk loaded on demand
  assert.match(i18n, /fr: \(\) => import\('\.\/fr\.json', \{ with: \{ type: 'json' \} \}\)/)
  assert.match(i18n, /en: \(\) => import\('\.\/en\.json', \{ with: \{ type: 'json' \} \}\)/)
  assert.doesNotMatch(i18n, /^import (fr|en) from/m, 'catalogs outside the main bundle')
})

test('port bootstrap state: the API says bootstrap (code), the client no longer compares any text; network sorted by the instance locale', t => {
  const store = openDb(tmpDir('p5d-mem-', t))
  t.after(() => store.db.close())
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['h1'] })
  const T0 = Date.parse('2026-11-10T09:00:00Z')
  const listening = [{ proto: 'tcp', addr: '192.0.2.1', port: 22, process: 'sshd' }]
  const agents = slow => ({ hosts: [{ id: 'h1', agent: 'ssh' }], get: () => ({ ok: true, slowAt: slow.ts * 1000, slow }) })
  mem.observe(agents({ version: 8, ts: Math.floor(T0 / 1000), listening }), T0)
  const later = [...listening, { proto: 'tcp', addr: '192.0.2.1', port: 8080, process: 'node' }]
  mem.observe(agents({ version: 8, ts: Math.floor(T0 / 1000) + 3600, listening: later }), T0 + 3600_000)
  mem.portKnown('h1', 'tcp', 8080, 'service déployé', 'admin', T0 + 7200_000)
  const view = Object.fromEntries(mem.portsView('h1', later).map(p => [p.port, p.known?.bootstrap]))
  assert.deepEqual(view, { 22: true, 8080: false })
  assert.doesNotMatch(read('components/AgentSecurity.jsx'), /amorçage/)
  assert.match(read('components/AgentSecurity.jsx'), /!p\.known\.bootstrap/)
  assert.doesNotMatch(read('views/Network.jsx'), /localeCompare\([^)]*'fr'\)/)
})

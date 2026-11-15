// Client structure rule, on the imports of client/src.
// - views/: imported only by App.jsx (exception: views/Mural.jsx imports views/Cockpit.jsx);
// - lib/ imports neither ui/, nor components/, nor views/; ui/ imports neither components/ nor views/.
// - plugins/: the core only goes through the registries (plugins/index.jsx, plugins/nav.js,
//   plugins/meta.js); lib/ and ui/ only read the data (plugins/meta.js); a plugin does not import
//   another plugin; the meta.js files (data) import neither ui/, nor components/, nor views/, nor
//   a .jsx.
// Static imports (import … from, export … from) and dynamic ones (import('…')), relative paths.
// Any import( whose argument is not a string literal ('…' or "…") is refused (otherwise the
// rule could not read it: import(`./views/${v}.jsx`), import(name), import('./' + v)).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src')
const EXCEPTIONS = new Set(['views/Mural.jsx -> views/Cockpit.jsx'])
const REGISTRIES = new Set(['plugins/index.jsx', 'plugins/nav.js', 'plugins/meta.js'])

// files: { 'relative/path.jsx': code }
function readTree(root = SRC) {
  const out = {}
  for (const f of fs.readdirSync(root, { recursive: true })) {
    if (/\.(jsx?|mjs)$/.test(f)) out[f.split(path.sep).join('/')] = fs.readFileSync(path.join(root, f), 'utf8')
  }
  return out
}
const specs = code => [...code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3])
// → violations "importer -> target : rule"
function structureViolations(tree) {
  const out = []
  for (const [file, code] of Object.entries(tree)) {
    // a JSON import attribute ({ with: { type: 'json' } }) is allowed after the literal
    for (const m of code.matchAll(/\bimport\s*\((?!\s*(['"])[^'"`$]*\1\s*(?:,\s*\{\s*with:\s*\{\s*type:\s*'json'\s*\}\s*\}\s*)?\))\s*([^)\n]{0,60})/g)) out.push(`${file} : import(${m[2].trim()}) non littéral, illisible par la règle`)
    for (const spec of specs(code)) {
      if (!spec.startsWith('.')) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
      const top = d => target.startsWith(`${d}/`)
      const from = d => file.startsWith(`${d}/`)
      if (top('views') && file !== 'App.jsx' && !EXCEPTIONS.has(`${file} -> ${target}`)) out.push(`${file} -> ${target} : seul App.jsx importe views/`)
      if (from('lib') && (top('ui') || top('components') || top('views'))) out.push(`${file} -> ${target} : lib/ n'importe ni ui/, ni components/, ni views/`)
      if (from('ui') && (top('components') || top('views'))) out.push(`${file} -> ${target} : ui/ n'importe ni components/ ni views/`)
      // plugins/
      const plug = f => f.match(/^plugins\/([^/]+)\//)?.[1] ?? null
      if (top('plugins') && !from('plugins') && !REGISTRIES.has(target)) out.push(`${file} -> ${target} : le cœur passe par les registres de plugins/`)
      if (top('plugins') && (from('lib') || from('ui')) && target !== 'plugins/meta.js') out.push(`${file} -> ${target} : lib/ et ui/ ne lisent que plugins/meta.js`)
      if (plug(file) && plug(target) && plug(file) !== plug(target)) out.push(`${file} -> ${target} : un plugin n'importe pas un autre plugin`)
      if (/(^|\/)meta\.js$/.test(file) && from('plugins') && (top('ui') || top('components') || top('views') || target.endsWith('.jsx'))) out.push(`${file} -> ${target} : meta.js (données) sans composant`)
    }
  }
  return out.sort()
}

test('structure rule: no forbidden import in client/src', () => {
  const tree = readTree()
  assert.ok(Object.keys(tree).length > 40, 'tree read')
  assert.ok(Object.keys(tree).some(f => f.startsWith('views/')) && 'App.jsx' in tree)
  assert.deepEqual(structureViolations(tree), [])
})

test('the rule detects each forbidden case (fake tree) and accepts the Mural → Cockpit exception', () => {
  const tree = {
    'App.jsx': "import Cockpit from './views/Cockpit.jsx'\nconst X = lazy(() => import('./views/Services.jsx'))",
    'views/Mural.jsx': "import Cockpit from './Cockpit.jsx'",
    'views/Cockpit.jsx': "import { x } from './Services.jsx'\nimport A from '../AlertBell.jsx'",
    'AlertBell.jsx': "import { RULE_LABEL } from './views/Alerts.jsx'",
    'Drawer.jsx': "const V = import('./views/Network.jsx')\nconst W = import( \"../lib/ok.js\" )",
    'Dyn.jsx': "const a = v => import(`./views/${v}.jsx`)\nconst b = n => import(n)\nconst c = v => import('./views/' + v)\nconst d = import(`./lib/x.js`)",
    'Meta.jsx': 'const u = import.meta.url\nconst e = import.meta.env.DEV',
    'lib/a.js': "import { since } from '../ui/TimeAgo.jsx'\nexport { y } from '../components/Grid.jsx'",
    'lib/b.js': "import './c.js'\nimport '../views/Infra.jsx'",
    'ui/Box.jsx': "import Grid from '../components/Grid.jsx'\nimport { z } from '../views/Ci.jsx'\nimport { fmt } from '../lib/format.js'",
    'components/Grid.jsx': "import Box from '../ui/Box.jsx'\nimport { f } from '../lib/format.js'",
  }
  assert.deepEqual(structureViolations(tree), [
    'AlertBell.jsx -> views/Alerts.jsx : seul App.jsx importe views/',
    'Drawer.jsx -> views/Network.jsx : seul App.jsx importe views/',
    'Dyn.jsx : import(`./views/${v}.jsx`) non littéral, illisible par la règle',
    'Dyn.jsx : import(n) non littéral, illisible par la règle',
    "Dyn.jsx : import('./views/' + v) non littéral, illisible par la règle",
    'Dyn.jsx : import(`./lib/x.js`) non littéral, illisible par la règle',
    "lib/a.js -> components/Grid.jsx : lib/ n'importe ni ui/, ni components/, ni views/",
    "lib/a.js -> ui/TimeAgo.jsx : lib/ n'importe ni ui/, ni components/, ni views/",
    "lib/b.js -> views/Infra.jsx : lib/ n'importe ni ui/, ni components/, ni views/",
    'lib/b.js -> views/Infra.jsx : seul App.jsx importe views/',
    "ui/Box.jsx -> components/Grid.jsx : ui/ n'importe ni components/ ni views/",
    'ui/Box.jsx -> views/Ci.jsx : seul App.jsx importe views/',
    "ui/Box.jsx -> views/Ci.jsx : ui/ n'importe ni components/ ni views/",
    'views/Cockpit.jsx -> views/Services.jsx : seul App.jsx importe views/',
  ].sort())
})

test('shared blocks are in their place: Section in ui/, netKeys in lib/, no reused view export', () => {
  const tree = readTree()
  assert.match(tree['ui/Section.jsx'], /^export default function Section\(/m)
  assert.match(tree['lib/netKeys.js'], /^export const netKeys = /m)
  assert.doesNotMatch(tree['HostDrawer.jsx'], /export function Section\(/)
  assert.doesNotMatch(tree['DeviceForm.jsx'], /export const netKeys/)
  for (const [f, re] of [['views/Alerts.jsx', /export (const RULE_LABEL|function duration)/], ['views/Services.jsx', /export (function hostLabel|const fmtUptime|function CompactTile)/], ['views/Updates.jsx', /export function GapBadge|const GAPS/], ['ui/TimeAgo.jsx', /export function since/]]) {
    assert.doesNotMatch(tree[f], re, f)
  }
})

test('the rule covers plugins/ (fake tree): registries only for the core, data only for lib/ and ui/, no import between plugins, meta.js without component', () => {
  const tree = {
    'App.jsx': "import { pluginRoutes } from './plugins/index.jsx'\nimport { Ci } from './plugins/gitea/Ci.jsx'",
    'nav.js': "import { PLUGIN_NAV } from './plugins/nav.js'",
    'lib/alerts.js': "import { PLUGIN_RULE_LABELS } from '../plugins/meta.js'\nimport x from '../plugins/index.jsx'",
    'ui/Kpi.jsx': "import g from '../plugins/gitea/meta.js'",
    'plugins/index.jsx': "import gitea from './gitea/index.jsx'",
    'plugins/gitea/index.jsx': "import { lazy } from 'react'\nconst Ci = lazy(() => import('./Ci.jsx'))\nimport o from '../autre/tiles.jsx'",
    'plugins/gitea/tiles.jsx': "import Kpi from '../../ui/Kpi.jsx'\nimport { useSource } from '../../api.js'\nimport V from '../../views/Alerts.jsx'",
    'plugins/gitea/meta.js': "import T from './tiles.jsx'\nimport P from '../../ui/Panel.jsx'",
    'plugins/meta.js': "import gitea from './gitea/meta.js'",
  }
  assert.deepEqual(structureViolations(tree), [
    'App.jsx -> plugins/gitea/Ci.jsx : le cœur passe par les registres de plugins/',
    'lib/alerts.js -> plugins/index.jsx : lib/ et ui/ ne lisent que plugins/meta.js',
    'plugins/gitea/index.jsx -> plugins/autre/tiles.jsx : un plugin n\'importe pas un autre plugin',
    'plugins/gitea/meta.js -> plugins/gitea/tiles.jsx : meta.js (données) sans composant',
    'plugins/gitea/meta.js -> ui/Panel.jsx : meta.js (données) sans composant',
    'plugins/gitea/tiles.jsx -> views/Alerts.jsx : seul App.jsx importe views/',
    'ui/Kpi.jsx -> plugins/gitea/meta.js : le cœur passe par les registres de plugins/',
    'ui/Kpi.jsx -> plugins/gitea/meta.js : lib/ et ui/ ne lisent que plugins/meta.js',
  ].sort())
})

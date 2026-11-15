// Accuracy of the docs/plugins.md guide. Each js or jsx code block appears word for word in the
// example plugin (server or client) or in the ntfy plugin (tested separately); the json block is a
// config that the example schema accepts; the diff blocks apply to the files they cite; the table
// of hooks, the extensions, the reserved ids and the cited limits are those of the code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogs, unreleased } from './changelog.js'
import example from '../plugins/example/index.js'
import { validatePluginConfig, CHANNEL_TIMEOUT_MS } from '../lib/plugins/host.js'
import { EXTENSION_KINDS } from '../lib/plugins/extensions.js'
import { RESERVED_PLUGIN_IDS } from '../lib/plugins/core.js'
import { RETRY_AFTER_MAX_SEC, CHANNEL_ERROR_FOR_SEC } from '../lib/notify/notifier.js'
import { PLUGIN_MARGIN_MS } from '../lib/checks.js'
import { WIDGET_TIMEOUT } from '../lib/widget-types.js'
import { collectTimeoutSec } from '../lib/plugins/host.js'
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../lib/http.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const GUIDE = read('docs/plugins.md')
const blocks = lang => [...GUIDE.matchAll(/```(\w*)\n([\s\S]*?)```/g)].filter(m => m[1] === lang).map(m => m[2].replace(/\n$/, ''))
const SOURCES = [
  'server/plugins/example/index.js', 'server/plugins/ntfy/index.js',
  // files only (the locales/ folder of the client catalog sits next to them)
  ...fs.readdirSync(path.join(ROOT, 'client/src/plugins/example'), { withFileTypes: true }).filter(e => e.isFile()).map(e => `client/src/plugins/example/${e.name}`),
].map(read)

test('guide: each js and jsx block is quoted word for word from a tested plugin (example or ntfy)', () => {
  const code = [...blocks('js'), ...blocks('jsx')]
  assert.ok(code.length >= 18, `${code.length} blocks`)
  for (const b of code) assert.ok(SOURCES.some(s => s.includes(b)), `block not found in the sources:\n${b.slice(0, 300)}`)
})

test('guide: the given config is accepted by the example schema; the diff blocks apply to the cited files', () => {
  const [json] = blocks('json')
  assert.deepEqual(validatePluginConfig(JSON.parse(json), [example]), [])
  const diffs = blocks('diff')
  assert.equal(diffs.length, 2)
  for (const d of diffs) {
    const file = d.match(/^\+\+\+ b\/(.+)$/m)[1]
    const target = read(file)
    for (const l of d.split('\n').filter(x => x.startsWith(' '))) assert.ok(target.includes(l.slice(1)), `${file}: ${l}`)
    // the added line imports a file that exists
    const imp = d.match(/^\+import \w+ from '(.+)'$/m)[1]
    assert.ok(fs.existsSync(path.join(ROOT, path.dirname(file), imp)), imp)
  }
})

test('guide: the hooks table cites exactly the host hooks; the six kinds of extensions; the reserved ids; the cited limits are those of the code', () => {
  const hooks = new Set(read('server/lib/plugins/host.js').match(/const HOOKS = new Set\(\[([^\]]+)\]\)/)[1].match(/'(\w+)'/g).map(s => s.slice(1, -1)))
  const sec = GUIDE.slice(GUIDE.indexOf('### Hooks'), GUIDE.indexOf('### Extensions'))
  const table = new Set([...sec.matchAll(/^\| `(\w+)(?:\([^`]*\))?` \|/gm)].map(m => m[1]))
  assert.deepEqual([...table].sort(), [...hooks].sort())
  for (const k of EXTENSION_KINDS) assert.ok(GUIDE.includes(`    ${k}: {`), k)
  const ids = GUIDE.match(/refused at load time: ([^.]+)\./)[1].match(/`(\w+)`/g).map(s => s.slice(1, -1))
  assert.deepEqual(ids.sort(), [...RESERVED_PLUGIN_IDS].sort())
  assert.equal(RETRY_AFTER_MAX_SEC, 15 * 60)
  assert.match(GUIDE, /capped at 15 min/)
  assert.equal(CHANNEL_TIMEOUT_MS, 30_000)
  assert.match(GUIDE, /a channel send is bounded at 30 s/)
  assert.equal(WIDGET_TIMEOUT, 8000)
  assert.match(GUIDE, /widget auth is\s+bounded at 8 s/)
  assert.equal(PLUGIN_MARGIN_MS, 1000)
  assert.match(GUIDE, /after its timeout \+ 1 s/)
  assert.equal(CHANNEL_ERROR_FOR_SEC, 600)
  assert.match(GUIDE, /keeps failing\s+\(10 min\)/)
  assert.match(GUIDE, /cut to 200 characters/)
  assert.match(read('server/lib/plugins/host.js'), /const ERROR_MAX = 200/)
  assert.match(read('server/lib/plugins/host.js'), /const PLUGIN_ERROR_FOR_SEC = 60/)
  assert.match(GUIDE, /raised \(after 60 s\)/)
  assert.match(read('server/package.json'), /"check-config": /)
})

test('README and CHANGELOG: link to the guide (valid link), Integrations page and ntfy in the README; Plugins entry of the changelog, unreleased (Gitea: "Non publié"; public: "[Unreleased]")', () => {
  const readme = read('README.md')
  assert.match(readme, /\[docs\/plugins\.md\]\(docs\/plugins\.md\)/)
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/plugins.md')))
  // short English README; the ntfy config example is in docs/alerts.md
  const sec = readme.slice(readme.indexOf('### Plugins and integrations'))
  assert.ok(readme.includes('### Plugins and integrations'))
  assert.match(sec, /\*\*Integrations\*\* page/)
  assert.match(sec, /GET \/api\/plugins/)
  assert.match(read('docs/alerts.md'), /"plugins": \{ "ntfy": \{/)
  // Gitea changelog (French) while it is in the tree, public changelog (English) and its template
  for (const log of changelogs()) {
    const entry = unreleased(log)
    assert.ok(entry, `${log.file}: unreleased entry`)
    if (log.isPublic) {
      assert.match(entry, /\*\*Plugins\*\*: an internal plugin interface, version 0 and unstable \(`apiVersion: 0`, static list,\s+no external loading\)/, log.file)
      assert.ok(entry.includes('[docs/plugins.md](docs/plugins.md)'), log.file)
    } else {
      assert.match(entry, /\*\*Plugins \(P4a-0 à P4f\)\.\*\*/)
      for (const lot of ['P4a-0', 'P4a', 'P4b', 'P4c', 'P4d', 'P4e']) assert.ok(entry.includes(lot), lot)
    }
  }
})

test('guide: default collection timeout min(periodSec, 60), periodSec ≥ 10, 30 s for version sources, ctx.http from 0.1 to 30 s; plugin routes rule', () => {
  assert.match(GUIDE, /`timeoutSec` defaults to `min\(periodSec, 60\)`/)
  assert.match(GUIDE, /default\s+`min\(periodSec, 60\)` s/)
  assert.deepEqual([collectTimeoutSec({ periodSec: 600 }), collectTimeoutSec({ periodSec: 30 }), collectTimeoutSec({ periodSec: 600, timeoutSec: 5 })], [60, 30, 5])
  assert.match(GUIDE, /periodSec \(≥ 10\)/)
  assert.match(read('server/lib/plugins/host.js'), /c\.periodSec >= 10/)
  assert.match(GUIDE, /a version source at 30 s/)
  assert.match(read('server/lib/updates/index.js'), /pluginTimeoutMs = 30_000/)
  assert.match(GUIDE, /\(`timeoutMs`, 0\.1 to 30 s\)/)
  assert.deepEqual([MIN_TIMEOUT_MS, MAX_TIMEOUT_MS], [100, 30_000])
  assert.match(GUIDE, /Rule for plugin routes: serve what the collector already read/)
  assert.match(GUIDE, /never `Date\.now\(\)`/)
})

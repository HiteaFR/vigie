// Client size, two criteria. Real Vite build in memory (write: false, repository
// configuration); skipped only if the client is not installed (npm ci in client/), like the
// client rendering.
// - main bundle ≤ MAIN_LIMIT (432,521 bytes when the views were split, i.e. about 10 % of margin);
// - no view chunk > VIEW_LIMIT; every view except the Cockpit in its own chunk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = path.join(ROOT, 'client')
const MAIN_LIMIT = 476_000
const VIEW_LIMIT = 200_000
// the CI view belongs to the gitea plugin (client/src/plugins/gitea/Ci.jsx); Integrations added
const LAZY_VIEWS = ['Alerts', 'Backups', 'Infra', 'Integrations', 'Mural', 'Network', 'Services', 'Updates']
const PLUGIN_VIEWS = ['plugins/gitea/Ci.jsx']

let built = null
// all emitted files (chunks and assets), including the Vite manifest
let emitted = null
// access to a .env* file during the build (never read: the access is intercepted before the call)
const envLookups = []
async function build(t) {
  const entry = path.join(CLIENT, 'node_modules/vite/dist/node/index.js')
  if (!fs.existsSync(entry)) {
    t.skip('client not installed (npm ci in client/)')
    return null
  }
  if (built) return built
  const vite = await import(entry)
  const isEnv = p => path.basename(String(p)).startsWith('.env')
  const saved = { statSync: fs.statSync, existsSync: fs.existsSync, readFileSync: fs.readFileSync }
  fs.statSync = function (p, ...a) { if (isEnv(p)) { envLookups.push(String(p)); return undefined } return saved.statSync.call(this, p, ...a) }
  fs.existsSync = function (p, ...a) { if (isEnv(p)) { envLookups.push(String(p)); return false } return saved.existsSync.call(this, p, ...a) }
  fs.readFileSync = function (p, ...a) { if (isEnv(p)) { envLookups.push(String(p)); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } return saved.readFileSync.call(this, p, ...a) }
  let out
  try {
    // in memory: nothing is written or emptied (client/dist intact); same config as the prod build
    out = await vite.build({ root: CLIENT, configFile: path.join(CLIENT, 'vite.config.js'), logLevel: 'silent', build: { write: false, emptyOutDir: false, outDir: tmpDir('dash-bundle-') } })
  } finally {
    Object.assign(fs, saved)
  }
  const all = (Array.isArray(out) ? out : [out]).flatMap(o => o.output)
  emitted = all.map(o => ({ file: o.fileName, text: o.type === 'asset' ? String(o.source) : null }))
  const chunks = all.filter(o => o.type === 'chunk')
  built = chunks.map(c => ({ file: c.fileName, bytes: Buffer.byteLength(c.code), entry: c.isEntry, dynamic: c.isDynamicEntry, facade: c.facadeModuleId ? path.relative(path.join(CLIENT, 'src'), c.facadeModuleId).split(path.sep).join('/') : null, modules: Object.keys(c.modules).map(m => path.relative(path.join(CLIENT, 'src'), m).split(path.sep).join('/')) }))
  return built
}

test('size: main bundle ≤ MAIN_LIMIT; no view chunk > VIEW_LIMIT', async t => {
  const chunks = await build(t)
  if (!chunks) return
  const main = chunks.filter(c => c.entry)
  assert.equal(main.length, 1)
  t.diagnostic(`main bundle ${main[0].bytes} B (limit ${MAIN_LIMIT})`)
  assert.ok(main[0].bytes <= MAIN_LIMIT, `main bundle ${main[0].bytes} B > ${MAIN_LIMIT} B`)
  const views = chunks.filter(c => c.facade?.startsWith('views/'))
  for (const v of views) {
    t.diagnostic(`${v.facade} ${v.bytes} B`)
    assert.ok(v.bytes <= VIEW_LIMIT, `${v.facade}: ${v.bytes} B > ${VIEW_LIMIT} B`)
  }
})

test('split: one view = one chunk loaded on demand (except the Cockpit, in the main bundle); drawers, palette and bell in the main one', async t => {
  const chunks = await build(t)
  if (!chunks) return
  const main = chunks.find(c => c.entry)
  const dyn = chunks.filter(c => c.dynamic).map(c => c.facade).sort()
  assert.deepEqual(dyn.filter(f => f.startsWith('views/')), LAZY_VIEWS.map(v => `views/${v}.jsx`).sort())
  assert.ok(dyn.includes('NetworkMap.jsx'), 'the map stays on demand')
  // plugin views: on-demand chunks of the same build, like the core ones
  assert.deepEqual(dyn.filter(f => f.startsWith('plugins/')), PLUGIN_VIEWS)
  const inMain = main.modules.filter(m => m.startsWith('views/'))
  assert.deepEqual(inMain, ['views/Cockpit.jsx'])
  for (const m of ['Shell.jsx', 'CommandPalette.jsx', 'AlertBell.jsx', 'ServiceDrawer.jsx', 'HostDrawer.jsx', 'DeviceDrawer.jsx', 'ui/ViewFallback.jsx']) {
    assert.ok(main.modules.includes(m), `${m} in the main bundle`)
  }
})

test('static: React.lazy per view in App.jsx, Suspense with an aria-busy fallback (views and wall)', () => {
  const app = fs.readFileSync(path.join(CLIENT, 'src/App.jsx'), 'utf8')
  for (const v of LAZY_VIEWS) assert.match(app, new RegExp(`^const ${v} = lazy\\(\\(\\) => import\\('\\./views/${v}\\.jsx'\\)\\)$`, 'm'), v)
  assert.match(app, /^import Cockpit from '\.\/views\/Cockpit\.jsx'$/m)
  assert.doesNotMatch(app, /^import (Services|Infra|Backups|Ci|Alerts|Updates|Mural|Network|Integrations) from/m)
  // gitea plugin view, lazy in its registry; plugin routes via pluginRoutes()
  assert.match(fs.readFileSync(path.join(CLIENT, 'src/plugins/gitea/index.jsx'), 'utf8'), /^const Ci = lazy\(\(\) => import\('\.\/Ci\.jsx'\)\)$/m)
  assert.match(app, /\{PLUGIN_ROUTES\.map\(r => <Route key=\{r\.path\} path=\{r\.path\} component=\{r\.component\} \/>\)\}/)
  assert.equal((app.match(/<Suspense fallback=\{<ViewFallback \/>\}>/g) || []).length, 2)
  const fb = fs.readFileSync(path.join(CLIENT, 'src/ui/ViewFallback.jsx'), 'utf8')
  assert.match(fb, /aria-busy="true"/)
  assert.match(fb, /min-h-\[60vh\]/)
  assert.match(fb, /sr-only/)
})

test('envDir: the build (repository config) looks up no .env; vite.config.js sets envDir: false', async t => {
  const chunks = await build(t)
  if (!chunks) return
  assert.deepEqual(envLookups, [])
  const conf = fs.readFileSync(path.join(CLIENT, 'vite.config.js'), 'utf8')
  assert.match(conf, /^  envDir: false,$/m)
})

test('manifest (build.manifest: true): .vite/manifest.json covers exactly the files emitted under assets/, paths "assets/<name>"', async t => {
  const chunks = await build(t)
  if (!chunks) return
  const { filesOf } = await import('../../deploy/prune-assets.mjs')
  const mf = emitted.find(o => o.file === '.vite/manifest.json')
  assert.ok(mf, 'manifest emitted')
  const listed = [...filesOf(JSON.parse(mf.text))].sort()
  const real = emitted.map(o => o.file).filter(f => f.startsWith('assets/')).sort()
  assert.ok(real.length >= 10)
  assert.deepEqual(listed, real)
})

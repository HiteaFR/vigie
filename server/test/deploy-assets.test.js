// Old chunks kept for one deployment cycle.
// - deploy/prune-assets.mjs: fake builds (files only, no Vite) in a temporary directory: first
//   deployment, idempotence, two then three builds, safeguards;
// - deploy/sync.sh with the REAL rsync, exactly like deploy.yml: excludes protected from --delete;
// - simulation of successive deployments (sync.sh then prune, like deploy.yml) served by the same
//   static chain as index.js: a chunk of N is served after N+1, then 404 no-store after N+2;
// - static: sync.sh and the code-side wiring (the order of the deployment steps is checked
//   in the infra repository, with the workflow);
// - deploy/icons-migrate.sh (icons carried over before the sync, no network), on copies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { prune, filesOf, STATE, PREVIOUS, LEGACY } from '../../deploy/prune-assets.mjs'
import { staticHeaders, missingAsset } from '../lib/security-headers.js'
import { tmpDir } from './tmpdir.js'
import { ICON_FILE } from '../lib/icons.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SYNC = path.join(ROOT, 'deploy/sync.sh')
const PRUNE = path.join(ROOT, 'deploy/prune-assets.mjs')
const hasRsync = spawnSync('rsync', ['--version']).status === 0

// fake build n: index-<n>.js, shared view (same hash from one build to the next) and CSS sheet
const build = n => ({
  'index.html': { file: `assets/index-B${n}.js`, isEntry: true, css: [`assets/index-C${n}.css`], dynamicImports: ['src/views/Ci.jsx'] },
  'src/views/Ci.jsx': { file: `assets/Ci-V${n}.js`, isDynamicEntry: true },
  '_partage.js': { file: 'assets/partage-STABLE.js' },
})
const files = n => [...filesOf(build(n))].sort()
// writes the files of a build into <dist>/assets (like step 1 of sync.sh)
function addBuild(dist, n) {
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  for (const f of files(n)) fs.writeFileSync(path.join(dist, f), `contenu de ${f}`)
}
const ls = dist => fs.readdirSync(path.join(dist, 'assets')).map(f => `assets/${f}`).sort()
const run = (dist, n, log = []) => prune({ dist, manifestText: JSON.stringify(build(n)), log: l => log.push(l) })

test('prune: first deployment without state → nothing deleted, files already there kept as "previous"; rerun → identical', t => {
  const dist = tmpDir('dash-prune-', t)
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'assets/ancien-A.js'), 'build d\'avant le manifeste')
  addBuild(dist, 1)
  const log = []
  const r = run(dist, 1, log)
  assert.deepEqual([r.first, r.deleted, r.skipped], [true, [], []])
  assert.deepEqual(ls(dist), ['assets/ancien-A.js', ...files(1)].sort())
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dist, STATE), 'utf8')), build(1))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dist, PREVIOUS), 'utf8')), { [LEGACY]: { assets: ['assets/ancien-A.js'] } })
  assert.match(log[0], /^assets: 5 kept \(current build 4, previous 1, first deployment: nothing deleted\), 0 deleted$/)
  // idempotent: same build rerun
  const again = run(dist, 1)
  assert.deepEqual([again.first, again.shifted, again.deleted], [false, false, []])
  assert.deepEqual(ls(dist), ['assets/ancien-A.js', ...files(1)].sort())
})

test('prune: two then three builds → N kept after N+1, deleted after N+2; shared file kept; idempotent at each step; log', t => {
  const dist = tmpDir('dash-prune-', t)
  addBuild(dist, 1)
  run(dist, 1)
  addBuild(dist, 2)
  const log2 = []
  const r2 = run(dist, 2, log2)
  assert.deepEqual([r2.shifted, r2.deleted], [true, []])
  assert.deepEqual(ls(dist), [...new Set([...files(1), ...files(2)])].sort(), 'N and N+1 served')
  assert.match(log2[0], /^assets: 7 kept \(current build 4, previous 4\), 0 deleted$/)
  assert.deepEqual(run(dist, 2).deleted, [], 'idempotent')
  addBuild(dist, 3)
  const log3 = []
  const r3 = run(dist, 3, log3)
  assert.deepEqual(r3.deleted, ['assets/Ci-V1.js', 'assets/index-B1.js', 'assets/index-C1.css'])
  assert.deepEqual(ls(dist), [...new Set([...files(2), ...files(3)])].sort())
  assert.ok(ls(dist).includes('assets/partage-STABLE.js'), 'file shared by the builds kept')
  assert.deepEqual(log3, [
    'assets: 7 kept (current build 4, previous 4), 3 deleted',
    '  deleted: assets/Ci-V1.js', '  deleted: assets/index-B1.js', '  deleted: assets/index-C1.css',
  ])
  const again = run(dist, 3)
  assert.deepEqual([again.shifted, again.deleted], [false, []])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dist, PREVIOUS), 'utf8')), build(2))
})

test('prune: only touches regular files directly in assets/; symbolic link (not followed) and directory ignored; nothing outside assets/', t => {
  const dist = tmpDir('dash-prune-', t)
  const outside = path.join(tmpDir('dash-prune-ext-', t), 'precieux.txt')
  fs.writeFileSync(outside, 'à garder')
  addBuild(dist, 1)
  run(dist, 1)
  addBuild(dist, 2)
  run(dist, 2)
  fs.symlinkSync(outside, path.join(dist, 'assets/lien.js'))
  fs.mkdirSync(path.join(dist, 'assets/sous-dossier'))
  fs.writeFileSync(path.join(dist, 'assets/sous-dossier/x.js'), 'x')
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *')
  addBuild(dist, 3)
  const r = run(dist, 3)
  assert.deepEqual(r.skipped, ['assets/lien.js', 'assets/sous-dossier'])
  assert.ok(fs.lstatSync(path.join(dist, 'assets/lien.js')).isSymbolicLink())
  assert.equal(fs.readFileSync(outside, 'utf8'), 'à garder')
  assert.ok(fs.existsSync(path.join(dist, 'assets/sous-dossier/x.js')))
  assert.ok(fs.existsSync(path.join(dist, 'index.html')) && fs.existsSync(path.join(dist, 'robots.txt')))
})

test('prune: safeguards → error and NO deletion, state unchanged (manifest unreadable or empty, path outside assets/, current file missing or a link)', t => {
  const dist = tmpDir('dash-prune-', t)
  addBuild(dist, 1)
  run(dist, 1)
  addBuild(dist, 2)
  run(dist, 2)
  addBuild(dist, 3)
  const before = ls(dist)
  const state = fs.readFileSync(path.join(dist, STATE), 'utf8')
  const bad = [
    ['{pas du json', /build manifest unreadable/],
    ['{}', /manifest empty or invalid/],
    ['[]', /manifest empty or invalid/],
    [JSON.stringify({ x: { file: '../server/index.js' } }), /path refused "\.\.\/server\/index\.js"/],
    [JSON.stringify({ x: { file: 'assets/sous/x.js' } }), /path refused/],
    [JSON.stringify({ x: { file: '/etc/passwd' } }), /path refused/],
    [JSON.stringify({ x: { file: 'index.html' } }), /path refused/],
    [JSON.stringify({ x: { file: 'assets/absent-Z.js' } }), /file of the current build missing or not regular: assets\/absent-Z\.js/],
  ]
  for (const [text, re] of bad) {
    assert.throws(() => prune({ dist, manifestText: text }), re, text)
    assert.deepEqual(ls(dist), before, text)
    assert.equal(fs.readFileSync(path.join(dist, STATE), 'utf8'), state, text)
  }
  fs.symlinkSync(path.join(dist, 'assets/index-B3.js'), path.join(dist, 'assets/lien-courant.js'))
  assert.throws(() => prune({ dist, manifestText: JSON.stringify({ x: { file: 'assets/lien-courant.js' } }) }), /not regular/)
  assert.throws(() => prune({ dist: tmpDir('dash-prune-vide-', t), manifestText: JSON.stringify(build(1)) }), /directory missing/)
  assert.deepEqual(ls(dist), [...before, 'assets/lien-courant.js'].sort())
})

test('prune on the command line: --manifest file or - (standard input), log on stdout, exit code 1 and message on an error', t => {
  const dist = tmpDir('dash-prune-cli-', t)
  addBuild(dist, 1)
  const mf = path.join(tmpDir('dash-prune-mf-', t), 'manifest.json')
  fs.writeFileSync(mf, JSON.stringify(build(1)))
  const a = spawnSync(process.execPath, [PRUNE, '--dist', dist, '--manifest', mf], { encoding: 'utf8' })
  assert.equal(a.status, 0, a.stderr)
  assert.match(a.stdout, /^assets: 4 kept \(current build 4, previous 0, first deployment: nothing deleted\), 0 deleted$/m)
  addBuild(dist, 2)
  spawnSync(process.execPath, [PRUNE, '--dist', dist, '--manifest', '-'], { input: JSON.stringify(build(2)), encoding: 'utf8' })
  addBuild(dist, 3)
  const c = spawnSync(process.execPath, [PRUNE, '--dist', dist, '--manifest', '-'], { input: JSON.stringify(build(3)), encoding: 'utf8' })
  assert.equal(c.status, 0, c.stderr)
  assert.match(c.stdout, /3 deleted\n {2}deleted: assets\/Ci-V1\.js\n/)
  const e = spawnSync(process.execPath, [PRUNE, '--dist', dist, '--manifest', '-'], { input: '{x', encoding: 'utf8' })
  assert.equal(e.status, 1)
  assert.match(e.stderr, /^✗ assets cleanup: build manifest unreadable/)
  const u = spawnSync(process.execPath, [PRUNE, '--dist', dist], { encoding: 'utf8' })
  assert.equal(u.status, 1)
  assert.match(u.stderr, /usage/)
})

// fake source tree of a deployment (checkout + build)
function source(t, n, extra = {}) {
  const src = tmpDir('dash-sync-src-', t)
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), c) }
  for (const f of files(n)) put(`client/dist/${f}`, `contenu de ${f}`)
  put('client/dist/index.html', `<!doctype html><script type="module" src="/${build(n)['index.html'].file}"></script>`)
  put('client/dist/.vite/manifest.json', JSON.stringify(build(n)))
  put('client/dist/robots.txt', 'User-agent: *')
  put('server/index.js', `// build ${n}`)
  put('.gitea/workflows/deploy.yml', 'ci')
  put('.git/HEAD', 'ref')
  put('client/node_modules/x/index.js', 'module du client')
  for (const [f, c] of Object.entries(extra)) put(f, c)
  // distinct dates per build, like a real checkout and build (rsync compares size and date:
  // two index.html files of the same size written in the same second would be deemed identical)
  const when = new Date(Date.UTC(2026, 9, 1) + n * 3600_000)
  const touch = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) touch(p); fs.utimesSync(p, when, when) } }
  touch(src)
  return src
}
// deploy.yml steps: sync.sh (exact deploy.yml options), then cleanup
const CI_OPTS = ['--exclude', '.gitea', '--exclude', 'client/node_modules']
function deploy(src, dest) {
  const s = spawnSync('sh', [SYNC, src, dest, ...CI_OPTS], { encoding: 'utf8' })
  assert.equal(s.status, 0, s.stderr)
  const p = spawnSync(process.execPath, [PRUNE, '--dist', path.join(dest, 'client/dist'), '--manifest', path.join(src, 'client/dist/.vite/manifest.json')], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  return p.stdout
}

test('sync.sh (real rsync, deploy.yml options): assets added, anchored excludes protected from --delete, the rest synced; first deployment to an empty target', t => {
  if (!hasRsync) {
    t.skip('rsync missing')
    return
  }
  const dest = tmpDir('dash-sync-dest-', t)
  // target: an older build, its state, a .env, client node_modules, a removed file
  const old = path.join(dest, 'client/dist')
  fs.mkdirSync(path.join(old, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(old, '.vite'), { recursive: true })
  fs.writeFileSync(path.join(old, 'assets/index-ANCIEN.js'), 'ancien')
  fs.writeFileSync(path.join(old, '.vite/manifest.json'), '{"etat":"à garder"}')
  fs.writeFileSync(path.join(old, 'index.html'), 'ancien index')
  fs.writeFileSync(path.join(old, 'obsolete.txt'), 'à effacer')
  fs.mkdirSync(path.join(dest, 'client/node_modules/y'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'client/node_modules/y/index.js'), 'module installé')
  assert.ok(path.resolve(dest).startsWith(path.resolve(os.tmpdir()) + path.sep) && !path.resolve(dest).startsWith(ROOT + path.sep) && !dest.startsWith('/opt'), dest)
  // FAKE .env (FACTICE=1), in a temporary directory created by the test: the only way to prove
  // that sync.sh does not erase it; never the real file
  fs.writeFileSync(path.join(dest, '.env'), 'FACTICE=1')
  const src = source(t, 7)
  const s = spawnSync('sh', [SYNC, src, dest, ...CI_OPTS], { encoding: 'utf8' })
  assert.equal(s.status, 0, s.stderr)
  assert.deepEqual(ls(old), ['assets/index-ANCIEN.js', ...files(7)].sort(), 'old ones kept, new ones added')
  assert.equal(fs.readFileSync(path.join(old, '.vite/manifest.json'), 'utf8'), '{"etat":"à garder"}', '.vite of the target untouched')
  assert.match(fs.readFileSync(path.join(old, 'index.html'), 'utf8'), /index-B7\.js/)
  assert.equal(fs.existsSync(path.join(old, 'obsolete.txt')), false, '--delete outside the excluded paths')
  assert.ok(fs.existsSync(path.join(old, 'robots.txt')))
  assert.equal(fs.readFileSync(path.join(dest, 'server/index.js'), 'utf8'), '// build 7')
  // FAKE .env (FACTICE=1), in a temporary directory created by the test: the only way to prove
  // that sync.sh does not erase it; never the real file
  assert.equal(fs.readFileSync(path.join(dest, '.env'), 'utf8'), 'FACTICE=1', '.env preserved')
  assert.ok(fs.existsSync(path.join(dest, 'client/node_modules/y/index.js')), 'client/node_modules preserved')
  assert.equal(fs.existsSync(path.join(dest, 'client/node_modules/x')), false, 'client/node_modules not transferred')
  for (const f of ['.git', '.gitea']) assert.equal(fs.existsSync(path.join(dest, f)), false, f)
  // first deployment: empty target
  const empty = tmpDir('dash-sync-vide-', t)
  const e = spawnSync('sh', [SYNC, src, path.join(empty, 'opt'), ...CI_OPTS], { encoding: 'utf8' })
  assert.equal(e.status, 0, e.stderr)
  assert.deepEqual(ls(path.join(empty, 'opt/client/dist')), files(7))
  // without build: refused, nothing touched
  const nob = spawnSync('sh', [SYNC, tmpDir('dash-sync-nob-', t), dest], { encoding: 'utf8' })
  assert.equal(nob.status, 1)
  assert.match(nob.stderr, /no build/)
})

test('simulation: deployments N, N+1, N+2 (sync.sh then cleanup) served by the index.js static chain: chunk of N served after N+1, 404 no-store after N+2; manifest never served', async t => {
  if (!hasRsync) {
    t.skip('rsync missing')
    return
  }
  const dest = tmpDir('dash-simu-', t)
  const dist = path.join(dest, 'client/dist')
  const app = express()
  app.use(express.static(dist, { setHeaders: staticHeaders, dotfiles: 'ignore' }))
  app.use('/assets', missingAsset)
  app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')) })
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  t.after(() => new Promise(r => srv.close(r)))
  const get = async p => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, cc: r.headers.get('cache-control'), body: await r.text() } }
  const logs = []
  logs.push(deploy(source(t, 1), dest))
  assert.equal((await get('/assets/Ci-V1.js')).status, 200)
  logs.push(deploy(source(t, 2), dest))
  // a tab open on N (index-B1) still loads its chunks after N+1
  for (const f of files(1)) assert.equal((await get(`/${f}`)).status, 200, `${f} after N+1`)
  assert.match((await get('/')).body, /index-B2\.js/)
  logs.push(deploy(source(t, 3), dest))
  const gone = await get('/assets/Ci-V1.js')
  assert.deepEqual([gone.status, gone.cc], [404, 'no-store'], 'chunk of N after N+2')
  for (const f of files(2)) assert.equal((await get(`/${f}`)).status, 200, `${f} (N+1) after N+2`)
  assert.equal((await get('/assets/partage-STABLE.js')).status, 200)
  assert.match(logs[2], /3 deleted/)
  // the manifest (dot directory .vite) is never served: fallback to index.html
  for (const p of ['/.vite/manifest.json', '/.vite/manifest.previous.json', '/assets/../.vite/manifest.json', '/.vite/']) {
    const m = await get(p)
    assert.doesNotMatch(m.body, /isEntry|_partage/, p)
  }
  assert.equal((await get('/assets/.vite')).status, 404)
  // the rest of dist/ does not change: index, unhashed files, chunks (no more icons in dist/)
  assert.equal((await get('/robots.txt')).status, 200)
  assert.match((await get('/')).body, /index-B3\.js/)
  assert.equal((await get('/assets/index-B3.js')).cc, 'public, max-age=31536000, immutable')
})

// the order of the deployment steps (deploy.yml, deploy.sh) is checked in the infra
// repository, with these files; here, the public scripts and the code-side wiring
test('static: sync.sh (anchored excludes, never --delete-excluded), vite.config manifest: true, index.js with dotfiles: \'ignore\'', () => {
  const sync = fs.readFileSync(SYNC, 'utf8')
  assert.match(sync, /--exclude \/client\/dist\/assets\/ \\\n {2}--exclude \/client\/dist\/\.vite\/ \\/)
  assert.doesNotMatch(sync.split('\n').filter(l => !l.trim().startsWith('#')).join('\n'), /delete-excluded/)
  assert.match(fs.readFileSync(path.join(ROOT, 'client/vite.config.js'), 'utf8'), /build: \{ outDir: 'dist', emptyOutDir: true, manifest: true \}/)
  assert.match(fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8'), /^app\.use\(express\.static\(dist, \{ setHeaders: staticHeaders, dotfiles: 'ignore' \}\)\)$/m)
})

// --- icons outside the repository (deploy/icons-migrate.sh), on copies in temporary directories ---
const MIGRATE = path.join(ROOT, 'deploy/icons-migrate.sh')
const migrate = (...args) => spawnSync('sh', [MIGRATE, ...args], { encoding: 'utf8' })
const modeOf = f => fs.statSync(f).mode & 0o777
const owner = f => { const st = fs.statSync(f); return `${st.uid}:${st.gid}` }
const NAMES = ['plex.svg', 'nas.png', 'appli-light.svg', 'netalertx.svg', 'Majuscule.svg', 'notes.txt', '.cache.svg', 'photo.webp', 'a.svg.bak', 'a b.svg', 'x.SVG']
// fake old deployed tree: icons in client/dist/icons (and/or client/public/icons)
function oldTree(t, where = ['client/dist/icons']) {
  const opt = tmpDir('dash-icons-opt-', t)
  for (const w of where) {
    const d = path.join(opt, w)
    fs.mkdirSync(d, { recursive: true })
    for (const f of NAMES) fs.writeFileSync(path.join(d, f), `${w}/${f}`)
    fs.mkdirSync(path.join(d, 'dossier.svg')) // not a file
  }
  return opt
}

test('icons-migrate.sh: copies regular files matching ICON_FILE (same filter as the server), links not followed; 0755/0644, owner of the parent; summary', t => {
  const opt = oldTree(t)
  const outside = path.join(tmpDir('dash-icons-ext-', t), 'secret.svg')
  fs.writeFileSync(outside, 'SECRET')
  fs.symlinkSync(outside, path.join(opt, 'client/dist/icons/lien.svg'))
  const state = tmpDir('dash-icons-state-', t)
  const dest = path.join(state, 'icons')
  const r = migrate(opt, dest)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), `icons: 4 copied, 0 already present (${dest})`)
  // same selection as ICON_FILE (lib/icons.js), the server constant
  assert.deepEqual(fs.readdirSync(dest).sort(), NAMES.filter(n => ICON_FILE.test(n)).sort())
  assert.deepEqual(fs.readdirSync(dest).sort(), ['appli-light.svg', 'nas.png', 'netalertx.svg', 'plex.svg'])
  assert.equal(fs.readFileSync(path.join(dest, 'plex.svg'), 'utf8'), 'client/dist/icons/plex.svg')
  assert.equal(modeOf(dest), 0o755)
  for (const f of fs.readdirSync(dest)) {
    assert.equal(modeOf(path.join(dest, f)), 0o644, f)
    assert.equal(owner(path.join(dest, f)), owner(state), f)
  }
  // pattern written in the script = constant of the server
  assert.ok(fs.readFileSync(MIGRATE, 'utf8').includes(`# pattern: ${ICON_FILE.source} (ICON_FILE of server/lib/icons.js`))
})

test('icons-migrate.sh: file by file — partial directory completed, never overwritten; idempotent; dist takes priority over public, names not counted twice', t => {
  const opt = oldTree(t, ['client/dist/icons', 'client/public/icons'])
  fs.writeFileSync(path.join(opt, 'client/public/icons/seulement-public.svg'), 'public')
  const dest = path.join(tmpDir('dash-icons-part-', t), 'icons')
  fs.mkdirSync(dest)
  fs.writeFileSync(path.join(dest, 'plex.svg'), 'VERSION LOCALE') // interrupted run, or icon downloaded again
  const r = migrate(opt, dest)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), `icons: 4 copied, 1 already present (${dest})`)
  assert.equal(fs.readFileSync(path.join(dest, 'plex.svg'), 'utf8'), 'VERSION LOCALE', 'never overwritten')
  assert.equal(fs.readFileSync(path.join(dest, 'nas.png'), 'utf8'), 'client/dist/icons/nas.png', 'dist takes precedence')
  assert.equal(fs.readFileSync(path.join(dest, 'seulement-public.svg'), 'utf8'), 'public')
  const again = migrate(opt, dest)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.stdout.trim(), `icons: 0 copied, 5 already present (${dest})`)
  assert.equal(fs.readdirSync(dest).filter(f => f.endsWith('.tmp')).length, 0)
})

test('icons-migrate.sh: missing source → nothing, exit 0, no directory created; linked source ignored; linked target refused; usage', t => {
  const none = path.join(tmpDir('dash-icons-none-', t), 'icons')
  const n = migrate(path.join(tmpDir('dash-icons-vide-', t), 'opt-absent'), none)
  assert.equal(n.status, 0, n.stderr)
  assert.match(n.stdout, /^icons: nothing to migrate \(no icon in /)
  assert.equal(fs.existsSync(none), false)
  const real = oldTree(t)
  const linked = tmpDir('dash-icons-lien-', t)
  fs.mkdirSync(path.join(linked, 'client/dist'), { recursive: true })
  fs.symlinkSync(path.join(real, 'client/dist/icons'), path.join(linked, 'client/dist/icons'))
  assert.match(migrate(linked, path.join(tmpDir('dash-icons-l2-', t), 'icons')).stdout, /nothing to migrate \(no icon/)
  const target = tmpDir('dash-icons-cible-', t)
  const ln = path.join(tmpDir('dash-icons-ln-', t), 'icons')
  fs.symlinkSync(target, ln)
  const refused = migrate(real, ln)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /is a link, refused/)
  assert.deepEqual(fs.readdirSync(target), [])
  // an icon already present as a link: counted as present, never replaced nor followed
  const d2 = path.join(tmpDir('dash-icons-l3-', t), 'icons')
  fs.mkdirSync(d2)
  fs.symlinkSync(path.join(target, 'cible.svg'), path.join(d2, 'plex.svg'))
  assert.match(migrate(real, d2).stdout, /3 copied, 1 already present/)
  assert.ok(fs.lstatSync(path.join(d2, 'plex.svg')).isSymbolicLink())
  assert.equal(migrate(real).status, 2)
  assert.equal(migrate().status, 2)
})

test('icons-migrate.sh: copy failing halfway → non-zero exit (the deployment stops before the sync)', t => {
  const opt = oldTree(t)
  const dest = path.join(tmpDir('dash-icons-echec-', t), 'icons')
  // the temporary file of an icon is taken by a non-empty directory: the copy fails, whatever the
  // user (root included, as on the runner)
  fs.mkdirSync(path.join(dest, '.nas.png.tmp/occupe'), { recursive: true })
  const r = migrate(opt, dest)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /cannot overwrite directory/, 'failure of the copy itself (cp -T), not of the chown')
  assert.doesNotMatch(r.stdout, /copied/)
})

test('simulation (real rsync): icons-migrate.sh then sync.sh of a tree without icons → icons erased from /opt, kept in the state directory; redeployment: nothing to copy', t => {
  if (!hasRsync) {
    t.skip('rsync missing')
    return
  }
  const base = tmpDir('dash-icons-simu-', t)
  const opt = path.join(base, 'opt')
  const dest = path.join(base, 'state/icons')
  fs.mkdirSync(path.join(base, 'state'))
  const before = source(t, 1, { 'client/public/icons/plex.svg': '<svg>ancienne</svg>', 'client/dist/icons/plex.svg': '<svg>ancienne</svg>' })
  assert.equal(spawnSync('sh', [SYNC, before, opt, ...CI_OPTS], { encoding: 'utf8' }).status, 0)
  const m = migrate(opt, dest)
  assert.equal(m.status, 0, m.stderr)
  assert.match(m.stdout, /^icons: 1 copied, 0 already present/)
  assert.equal(spawnSync('sh', [SYNC, source(t, 2), opt, ...CI_OPTS], { encoding: 'utf8' }).status, 0)
  assert.equal(fs.existsSync(path.join(opt, 'client/dist/icons')), false, 'no more icons in /opt')
  assert.equal(fs.existsSync(path.join(opt, 'client/public/icons')), false)
  assert.equal(fs.readFileSync(path.join(dest, 'plex.svg'), 'utf8'), '<svg>ancienne</svg>', 'kept outside /opt')
  assert.match(migrate(opt, dest).stdout, /nothing to migrate/)
  assert.ok(fs.existsSync(path.join(dest, 'plex.svg')))
})

test('static: icons-migrate.sh without network, owner read by stat; no more icon in the repository; Vite forwards /icons to the backend', () => {
  const code = text => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
  const mig = code(fs.readFileSync(MIGRATE, 'utf8'))
  assert.doesNotMatch(mig, /curl|wget|node |fetch/, 'migration without network')
  assert.match(mig, /stat -c '%u:%g' "\$\(dirname "\$dest"\)"/)
  assert.match(mig, /chown -R -h "\$owner" "\$dest"/)
  assert.doesNotMatch(mig, /dashboard:|chown dashboard|chown root/, 'no hard-coded user name')
  const tracked = spawnSync('git', ['ls-files', 'client/public'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  assert.equal(tracked, '')
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^client\/public\/icons\/$/m)
  assert.match(fs.readFileSync(path.join(ROOT, 'client/vite.config.js'), 'utf8'), /'\/icons': 'http:\/\/localhost:8088'/)
})

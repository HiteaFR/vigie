// Icons served by the REAL server/index.js from ICONS_DIR (default <state folder>/icons),
// plus from client/dist. iconUrls map read at startup, strict CSP for SVGs, paths outside the
// folder refused, missing folder without crash (monogram). Fake config, port 0, 127.0.0.1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootServer, bootConfig, request } from './server-boot.js'
import { tmpDir } from './tmpdir.js'
import { ICON_CSP } from '../lib/security-headers.js'
import { iconsDir, stateDir } from '../lib/paths.js'
import { ICON_FILE, ICON_EXTS, loadIconUrls, iconFile } from '../lib/icons.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'
// anonymous read: /api/services is read without a session, the icons are the subject
const config = () => bootConfig({
  security: { anonymousRead: true },
  services: [
    { id: 'a', name: 'A', group: 'g', host: 'web', url: 'http://127.0.0.1:9/', icon: 'appli' },
    { id: 'b', name: 'B', group: 'g', host: 'web', url: 'http://127.0.0.1:9/', icon: 'absente' },
  ],
})
const svcIcons = async port => Object.fromEntries((await request(port, '/api/services')).json.services.map(s => [s.id, [s.iconUrl, s.iconUrlDark]]))

test('paths: ICONS_DIR, otherwise <STATE_DIRECTORY>/icons, otherwise <root>/data/icons; same state folder as the database', () => {
  assert.equal(stateDir({}, '/r'), '/r/data')
  assert.equal(stateDir({ STATE_DIRECTORY: '/var/lib/x' }, '/r'), '/var/lib/x')
  assert.equal(iconsDir({}, '/r'), '/r/data/icons')
  assert.equal(iconsDir({ STATE_DIRECTORY: '/var/lib/x' }, '/r'), '/var/lib/x/icons')
  assert.equal(iconsDir({ STATE_DIRECTORY: '/var/lib/x', ICONS_DIR: '/srv/logos' }, '/r'), '/srv/logos')
  assert.equal(iconsDir({ ICONS_DIR: 'rel/icons' }, '/r'), path.resolve('rel/icons'))
  assert.match(INDEX, /^const store = openDb\(stateDir\(process\.env, ROOT\)\)$/m)
  assert.match(INDEX, /^const ICONS = iconsDir\(process\.env, ROOT\)$/m)
  assert.doesNotMatch(INDEX, /client', d, 'icons'|public', 'dist'/, 'no more reading of the icons in client/')
})

test('serving from ICONS_DIR: iconUrls map (svg first, -light variant), strict CSP and one-day cache; only .svg/.png with a slug name, regular files: sources.json, .webp, links, folders → 404 and out of the map', async t => {
  const icons = tmpDir('dash-icons-', t)
  const outside = path.join(tmpDir('dash-icons-ext-', t), 'secret.svg')
  fs.writeFileSync(outside, 'SECRET-LIEN')
  fs.writeFileSync(path.join(icons, 'appli.png'), 'png')
  fs.writeFileSync(path.join(icons, 'appli.svg'), SVG)
  fs.writeFileSync(path.join(icons, 'appli-light.svg'), SVG)
  fs.writeFileSync(path.join(icons, 'photo.png'), 'png')
  fs.writeFileSync(path.join(icons, 'absente.webp'), 'webp')
  fs.writeFileSync(path.join(icons, 'Majuscule.svg'), SVG)
  fs.writeFileSync(path.join(icons, 'sources.json'), '{"secret":"MANIFESTE"}')
  fs.writeFileSync(path.join(icons, 'notes.txt'), 'NOTES')
  fs.symlinkSync(outside, path.join(icons, 'lien.svg'))
  fs.mkdirSync(path.join(icons, 'dossier.svg'))
  const s = await bootServer(t, { config: config(), env: { ICONS_DIR: icons } })
  assert.deepEqual(await svcIcons(s.port), { a: ['/icons/appli.svg', '/icons/appli-light.svg'], b: [null, null] }, 'absente.webp not in the map')
  const png = await fetch(`${s.base}/icons/photo.png`, { headers: { host: 'localhost' } })
  assert.deepEqual([png.status, png.headers.get('content-type'), png.headers.get('content-security-policy') === ICON_CSP], [200, 'image/png', false])
  for (const p of ['/icons/sources.json', '/icons/absente.webp', '/icons/Majuscule.svg', '/icons/notes.txt', '/icons/lien.svg', '/icons/dossier.svg']) {
    const r = await request(s.port, p, { host: 'localhost' })
    assert.deepEqual([r.status, r.headers['cache-control']], [404, 'no-store'], p)
    assert.doesNotMatch(r.body, /MANIFESTE|SECRET-LIEN|NOTES/, p)
  }
  const r = await fetch(`${s.base}/icons/appli.svg`, { headers: { host: 'localhost' } })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), SVG)
  assert.equal(r.headers.get('content-security-policy'), ICON_CSP)
  assert.equal(r.headers.get('cache-control'), 'public, max-age=86400')
  assert.equal(r.headers.get('content-type'), 'image/svg+xml')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  // missing → 404 as text, no-store, never the application
  const miss = await fetch(`${s.base}/icons/inconnue.svg`, { headers: { host: 'localhost' } })
  assert.deepEqual([miss.status, miss.headers.get('cache-control')], [404, 'no-store'])
  assert.doesNotMatch(await miss.text(), /<html|<!doctype/i)
})

test('paths outside the folder refused (.., encoded, absolute, neighbor file): 404 without content; no folder redirect', async t => {
  const base = tmpDir('dash-icons-trav-', t)
  const icons = path.join(base, 'icons')
  fs.mkdirSync(icons)
  fs.writeFileSync(path.join(icons, 'appli.svg'), SVG)
  fs.writeFileSync(path.join(base, 'voisin.txt'), 'SECRET-VOISIN')
  fs.mkdirSync(path.join(icons, 'sous'))
  const s = await bootServer(t, { config: config(), env: { ICONS_DIR: icons } })
  for (const p of ['/icons/../voisin.txt', '/icons/%2e%2e/voisin.txt', '/icons/..%2fvoisin.txt', '/icons/%2e%2e%2fvoisin.txt', '/icons//etc/passwd', '/icons/sous', '/icons/sous/', '/icons/.sources.json']) {
    const r = await request(s.port, p, { host: 'localhost' })
    assert.notEqual(r.status, 200, p)
    assert.ok(r.status === 404 || r.status === 400, `${p}: ${r.status}`)
    assert.doesNotMatch(String(r.body ?? ''), /SECRET-VOISIN|root:/, p)
    assert.equal(r.headers?.location, undefined, p)
  }
})

test('missing icons folder: the server starts, no icon (monogram), /icons/* → 404; default <STATE_DIRECTORY>/icons', async t => {
  const s = await bootServer(t, { config: config(), env: { ICONS_DIR: path.join(tmpDir('dash-icons-none-', t), 'absent') } })
  assert.equal((await request(s.port, '/api/healthz')).status, 200)
  assert.deepEqual(await svcIcons(s.port), { a: [null, null], b: [null, null] })
  assert.equal((await request(s.port, '/icons/appli.svg', { host: 'localhost' })).status, 404)
  assert.doesNotMatch(s.logs(), /illisible/)
  // without ICONS_DIR: <STATE_DIRECTORY>/icons
  const state = tmpDir('dash-icons-state-', t)
  fs.mkdirSync(path.join(state, 'icons'))
  fs.writeFileSync(path.join(state, 'icons/appli.svg'), SVG)
  const d = await bootServer(t, { config: config(), env: { STATE_DIRECTORY: state } })
  assert.deepEqual((await svcIcons(d.port)).a, ['/icons/appli.svg', null])
  assert.equal((await request(d.port, '/icons/appli.svg', { host: 'localhost' })).status, 200)
})

test('single constant: ICON_FILE = .svg/.png with a slug name; index, route and vendor-icons use it; /icons mounted BEFORE the dist statics and the fallback', () => {
  assert.deepEqual([...ICON_EXTS], ['svg', 'png'])
  for (const ok of ['a.svg', 'a-b-1.png', 'x-light.svg']) assert.ok(ICON_FILE.test(ok), ok)
  for (const bad of ['a.webp', 'A.svg', 'a.svg.bak', '.a.svg', 'sources.json', 'a/b.svg', '..svg', 'a b.svg', 'a.SVG']) assert.ok(!ICON_FILE.test(bad), bad)
  assert.equal(iconFile('/nulle-part', '../x.svg'), null)
  assert.equal(loadIconUrls('/nulle-part/absent').size, 0)
  assert.match(INDEX, /^const iconUrls = loadIconUrls\(ICONS\)$/m)
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/vendor-icons.mjs'), 'utf8'), /import \{ ICON_SLUG, ICON_FILE \} from '\.\.\/server\/lib\/icons\.js'/)
  const at = s => INDEX.indexOf(s)
  const mount = "app.get('/icons/:file', iconRoute(ICONS, { setHeaders: iconHeaders, fallback: missingAsset }))"
  assert.ok(at(mount) > 0)
  assert.ok(at(mount) < at("app.use('/icons', missingAsset)"))
  assert.ok(at("app.use('/icons', missingAsset)") < at('app.use(express.static(dist'))
  assert.ok(at('app.use(express.static(dist') < at("app.get('*'"))
})

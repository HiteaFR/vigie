// Security headers on all responses. Test application composed like server/index.js (hostGuard,
// securityHeaders, JSON, API routes, static files with staticHeaders, SPA fallback), on
// 127.0.0.1:0, and a static check of the order in server/index.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { securityHeaders, staticHeaders, iconHeaders, cspFor, THEME_SCRIPT_HASH, ICON_CSP, missingAsset } from '../lib/security-headers.js'
import { hostGuard, allowedHostsOf } from '../lib/auth.js'
import { parseConfig } from '../lib/config.js'
import { tmpDir } from './tmpdir.js'
import { iconRoute } from '../lib/icons.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')

async function app(cfg = {}) {
  const dist = tmpDir('dash-headers-')
  // icons in a separate folder (ICONS_DIR), served by their own route, like index.js
  const icons = tmpDir('dash-headers-icons-')
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>')
  fs.writeFileSync(path.join(dist, 'assets/index-abc.js'), 'export {}')
  fs.writeFileSync(path.join(icons, 'plex.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const a = express()
  a.disable('x-powered-by')
  a.use(hostGuard(allowedHostsOf(cfg)))
  a.use(securityHeaders(cfg))
  a.use('/api', express.json({ limit: '8kb' }))
  a.get('/api/session', (req, res) => res.json({ configured: false }))
  a.get('/api/history/service/:id', (req, res) => res.status(404).json({ error: 'service inconnu' }))
  a.get('/icons/:file', iconRoute(icons, { setHeaders: iconHeaders, fallback: missingAsset }))
  a.use('/icons', missingAsset)
  a.use(express.static(dist, { setHeaders: staticHeaders, dotfiles: 'ignore' }))
  a.use('/assets', missingAsset)
  a.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')))
  const srv = a.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) }
}
const directives = csp => Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))

test('on /, /mural, /reseau, /api/session, /assets, an API 404: no X-Powered-By, nosniff, Referrer-Policy, CSP; index.js: same order', async () => {
  const s = await app()
  try {
    // English route names and former French names, all served (SPA fallback, same headers)
    for (const [p, status] of [['/', 200], ['/mural', 200], ['/reseau', 200], ['/wall', 200], ['/network', 200], ['/alerts', 200], ['/alertes', 200], ['/backups', 200], ['/updates', 200], ['/maj', 200], ['/api/session', 200], ['/assets/index-abc.js', 200], ['/api/history/service/inexistant', 404]]) {
      const r = await fetch(s.base + p)
      await r.arrayBuffer()
      assert.equal(r.status, status, p)
      assert.equal(r.headers.get('x-powered-by'), null, p)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p)
      assert.equal(r.headers.get('referrer-policy'), 'same-origin', p)
      assert.equal(r.headers.get('content-security-policy'), cspFor({}), p)
    }
  } finally {
    await s.close()
  }
  // server/index.js: app.disable right after creation; securityHeaders right after hostGuard,
  // before JSON, the API routes and the static files; static files via staticHeaders
  const at = s2 => INDEX.indexOf(s2)
  assert.match(INDEX, /^const app = express\(\)\n(\/\/[^\n]*\n)*app\.disable\('x-powered-by'\)$/m)
  const guard = at('app.use(hostGuard(hosts))')
  const headers = at('app.use(securityHeaders(cfg))')
  assert.ok(guard > 0 && headers > guard, 'securityHeaders after hostGuard')
  const between = INDEX.slice(guard, headers)
  assert.equal((between.match(/^app\.(use|get|post)\(/gm) ?? []).length, 1, 'nothing between hostGuard and securityHeaders')
  assert.ok(headers < at("app.use('/api', express.json("), 'before the JSON')
  assert.ok(headers < at("app.get('/api/"), 'before the API routes')
  assert.ok(headers < at('host.mount(app'), 'before the modules (network included)')
  assert.ok(headers < at('app.use(express.static('), 'before the static files')
  assert.match(INDEX, /app\.use\(express\.static\(dist, \{ setHeaders: staticHeaders, dotfiles: 'ignore' \}\)\)/)
})

test('each <script> of client/index.html (and of the build if it exists) is external or has its exact hash in script-src', () => {
  const scriptSrc = directives(cspFor({}))['script-src']
  const pages = ['client/index.html', 'client/dist/index.html'].map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f))
  assert.ok(pages.length >= 1)
  let inline = 0
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8')
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc\s*=/.test(m[1])) continue
      inline++
      const h = `'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`
      assert.ok(scriptSrc.includes(h), `${path.relative(ROOT, f)}: inline script missing from script-src; expected hash ${h} (THEME_SCRIPT_HASH)`)
    }
  }
  assert.ok(inline >= 1, 'the theme script is indeed inline')
  assert.equal(`'${THEME_SCRIPT_HASH}'`, scriptSrc[1])
})

test('script-src without \'unsafe-inline\' or \'unsafe-eval\'; object-src \'none\'; base-uri \'none\'', () => {
  for (const cfg of [{}, { frameAncestors: ['http://kiosk.example.net:8123'] }]) {
    const d = directives(cspFor(cfg))
    assert.ok(!d['script-src'].includes("'unsafe-inline'"))
    assert.ok(!d['script-src'].includes("'unsafe-eval'"))
    assert.ok(!(d['default-src'] ?? []).some(v => /unsafe/.test(v)))
    assert.deepEqual(d['object-src'], ["'none'"])
    assert.deepEqual(d['base-uri'], ["'none'"])
    assert.deepEqual(d['default-src'], ["'self'"])
    assert.deepEqual(d['style-src'], ["'self'", "'unsafe-inline'"])
    for (const k of ['img-src', 'connect-src', 'font-src', 'form-action']) assert.deepEqual(d[k], ["'self'"], k)
  }
})

test('Referrer-Policy is exactly same-origin', async () => {
  const s = await app()
  try {
    const r = await fetch(`${s.base}/api/session`)
    await r.arrayBuffer()
    assert.equal(r.headers.get('referrer-policy'), 'same-origin')
  } finally {
    await s.close()
  }
})

test('frameAncestors: [] → \'none\' and X-Frame-Options DENY; one origin → that one only, without X-Frame-Options; path or query → refused', async () => {
  const base = { version: 2, title: 't', gitea: { owner: 'o' }, groups: [{ id: 'g', name: 'G' }], hosts: [], proxmox: [], services: [] }
  const none = parseConfig(base)
  assert.deepEqual(none.config.frameAncestors, [])
  const kiosk = parseConfig({ ...base, frameAncestors: ['http://kiosk.example.net:8123'] })
  assert.ok(!kiosk.errors, kiosk.errors?.join('\n'))
  assert.deepEqual(kiosk.config.frameAncestors, ['http://kiosk.example.net:8123'])
  for (const bad of ['http://x/y?z', 'http://x/y', 'http://x/?a=1', 'http://x/#f', 'ftp://x', 'kiosk.example.net', 'http://u:p@x',
    // nothing that injects text into the CSP
    'http://a;sandbox', 'http://a%3Bb', 'http://a,b', "http://'none'", 'http://*.example', 'http://a b', 'http://[::1];x', 'http://a:99999']) {
    assert.ok(parseConfig({ ...base, frameAncestors: [bad] }).errors, bad)
  }
  for (const [good, origin] of [['http://kiosk.example.net', 'http://kiosk.example.net'], ['https://Kiosk.Example.NET:8443/', 'https://kiosk.example.net:8443'], ['http://192.0.2.7:8123', 'http://192.0.2.7:8123'], ['http://[::1]:8123', 'http://[::1]:8123'], ['http://[2001:db8::1]', 'http://[2001:db8::1]']]) {
    const r = parseConfig({ ...base, frameAncestors: [good] })
    assert.ok(!r.errors, `${good}: ${r.errors?.join(' ')}`)
    assert.deepEqual(r.config.frameAncestors, [origin])
    assert.match(cspFor(r.config), new RegExp(`frame-ancestors ${origin.replace(/[[\].]/g, '\\$&')}$`))
  }
  for (const [cfg, fa, xfo] of [[none.config, ["'none'"], 'DENY'], [kiosk.config, ['http://kiosk.example.net:8123'], null]]) {
    const s = await app(cfg)
    try {
      const r = await fetch(`${s.base}/mural`)
      await r.arrayBuffer()
      assert.deepEqual(directives(r.headers.get('content-security-policy'))['frame-ancestors'], fa)
      assert.equal(r.headers.get('x-frame-options'), xfo)
    } finally {
      await s.close()
    }
  }
})

test('an SVG from /icons/ (served from ICONS_DIR) keeps its strict CSP (default-src \'none\'); other files get the general CSP', async () => {
  const s = await app()
  try {
    const svg = await fetch(`${s.base}/icons/plex.svg`)
    await svg.arrayBuffer()
    assert.equal(svg.status, 200)
    assert.equal(svg.headers.get('content-security-policy'), ICON_CSP)
    assert.match(ICON_CSP, /^default-src 'none'/)
    assert.equal(svg.headers.get('cache-control'), 'public, max-age=86400')
    const js = await fetch(`${s.base}/assets/index-abc.js`)
    await js.arrayBuffer()
    assert.equal(js.headers.get('content-security-policy'), cspFor({}))
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    // missing icon → 404 no-store, never index.html; iconHeaders alone: strict CSP even
    // if the folder path does not contain "icons"
    const miss = await fetch(`${s.base}/icons/absente.svg`)
    assert.deepEqual([miss.status, miss.headers.get('cache-control')], [404, 'no-store'])
    assert.doesNotMatch(await miss.text(), /<title>t<\/title>/)
    const h = {}
    iconHeaders({ setHeader: (k, v) => { h[k] = v } }, '/srv/logos/x.svg')
    assert.deepEqual(h, { 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': ICON_CSP })
    const p = {}
    iconHeaders({ setHeader: (k, v) => { p[k] = v } }, '/srv/logos/x.png')
    assert.deepEqual(p, { 'Cache-Control': 'public, max-age=86400' })
  } finally {
    await s.close()
  }
})

test('missing asset: 404 as text, Cache-Control: no-store (not immutable), CSP and nosniff; a real asset stays immutable; app routes keep index.html; index.js: same order', async () => {
  const s = await app()
  try {
    for (const p of ['/assets/Ci-ancien.js', '/assets/index-ancien.css', '/assets/sous/dossier.js']) {
      const r = await fetch(s.base + p)
      const body = await r.text()
      assert.equal(r.status, 404, p)
      assert.equal(r.headers.get('cache-control'), 'no-store', p)
      assert.match(r.headers.get('content-type'), /^text\/plain/, p)
      assert.equal(body, 'fichier introuvable', p)
      assert.equal(r.headers.get('content-security-policy'), cspFor({}), p)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p)
    }
    const ok = await fetch(s.base + '/assets/index-abc.js')
    await ok.arrayBuffer()
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    for (const p of ['/ci', '/reseau', '/mural']) {
      const r = await fetch(s.base + p)
      assert.equal(r.status, 200, p)
      assert.match(await r.text(), /<title>t<\/title>/, p)
    }
  } finally {
    await s.close()
  }
  const at = s2 => INDEX.indexOf(s2)
  assert.match(INDEX, /^import \{ securityHeaders, staticHeaders, iconHeaders, missingAsset \} from '\.\/lib\/security-headers\.js'$/m)
  assert.ok(at('app.use(express.static(dist') < at("app.use('/assets', missingAsset)") && at("app.use('/assets', missingAsset)") < at("app.get('*'"))
})

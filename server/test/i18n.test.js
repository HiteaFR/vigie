// Translation (t) and instance locale, server and client; locale key of the config;
// Telegram escaping (tHtml); catalog parity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createI18n, setLocale, locale, localeTag, LOCALES, CATALOGS, DEFAULT_LOCALE } from '../lib/i18n.js'
import { parseConfig } from '../lib/config.js'
import { clientBundle } from './client-render.js'
import { bootServer, bootConfig, request } from './server-boot.js'

const CAT = {
  fr: { 'x.hello': 'Bonjour {name}', 'x.alerts': { one: '{count} alerte', other: '{count} alertes' }, 'x.fr_only': 'seulement en français', 'x.html': '<b>{title}</b> — {detail}' },
  en: { 'x.hello': 'Hello {name}', 'x.alerts': { one: '{count} alert', other: '{count} alerts' }, 'x.en_only': 'English only', 'x.html': '<b>{title}</b> — {detail}' },
}

test('server t: interpolation, plural via Intl.PluralRules, fallback to English then to the key; strict: missing key → error; missing parameter kept', () => {
  let l = 'fr'
  const t = createI18n({ catalogs: CAT, getLocale: () => l, strict: false })
  assert.equal(t('x.hello', { name: 'Alice' }), 'Bonjour Alice')
  assert.deepEqual([0, 1, 2, 5].map(count => t('x.alerts', { count })), ['0 alerte', '1 alerte', '2 alertes', '5 alertes'], 'fr: 0 and 1 in the singular')
  l = 'en'
  assert.deepEqual([0, 1, 2].map(count => t('x.alerts', { count })), ['0 alerts', '1 alert', '2 alerts'])
  assert.equal(t('x.hello', { name: 'Alice' }), 'Hello Alice')
  l = 'fr'
  assert.equal(t('x.en_only'), 'English only', 'fallback to English')
  assert.equal(t('x.absente'), 'x.absente', 'fallback to the key')
  assert.equal(t('x.hello'), 'Bonjour {name}', 'missing parameter: kept as is')
  const strict = createI18n({ catalogs: CAT, getLocale: () => 'fr', strict: true })
  assert.throws(() => strict('x.absente'), /i18n: missing key: x\.absente \(fr\)/)
  // under node --test, strict by default
  assert.throws(() => createI18n({ catalogs: CAT, getLocale: () => 'fr' })('x.absente'), /missing key/)
})

test('instance locale: en by default, fr set by the test preload; setLocale (fr, en; anything else refused); format tags fr-FR and en-GB', () => {
  assert.deepEqual([DEFAULT_LOCALE, locale(), localeTag()], ['en', 'fr', 'fr-FR'])
  assert.deepEqual(LOCALES, ['fr', 'en'])
  setLocale('en')
  assert.deepEqual([locale(), localeTag()], ['en', 'en-GB'])
  setLocale('fr')
  assert.throws(() => setLocale('de'), /unknown locale: de/)
  assert.equal(locale(), 'fr')
})

test('catalogs: same keys in fr and en (server and client), same parameters, complete plural forms', () => {
  const client = Object.fromEntries(['fr', 'en'].map(l => [l, JSON.parse(fs.readFileSync(new URL(`../../client/src/i18n/${l}.json`, import.meta.url), 'utf8'))]))
  for (const [name, cats] of [['server', CATALOGS], ['client', client]]) {
    assert.deepEqual(Object.keys(cats.fr).sort(), Object.keys(cats.en).sort(), `${name}: same keys`)
    const params = v => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) ?? [])].sort()
    for (const k of Object.keys(cats.fr)) {
      assert.deepEqual(params(cats.fr[k]), params(cats.en[k]), `${name}: parameters of ${k}`)
      if (typeof cats.fr[k] === 'object') for (const l of ['fr', 'en']) assert.ok(cats[l][k].other, `${name}: ${k}.other (${l})`)
    }
  }
})

test('config: locale at the root, en by default, fr accepted, anything else refused (hence by check-config)', () => {
  const MIN = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }
  assert.equal(parseConfig(MIN).config.locale, 'en')
  assert.equal(parseConfig({ ...MIN, locale: 'fr' }).config.locale, 'fr')
  assert.deepEqual(parseConfig({ ...MIN, locale: 'de' }).errors, ['locale: Invalid option: expected one of "fr"|"en"'])
})

test('/api/config exposes the instance locale', { timeout: 60_000 }, async t => {
  const s = await bootServer(t, { config: bootConfig({ security: { anonymousRead: true }, locale: 'en' }) })
  assert.equal((await request(s.port, '/api/config')).json.locale, 'en')
  const d = await bootServer(t, { config: bootConfig({ security: { anonymousRead: true } }) })
  assert.equal((await request(d.port, '/api/config')).json.locale, 'fr')
  // without a locale key, the product default
  const { locale: _drop, ...noLocale } = bootConfig({ security: { anonymousRead: true } })
  const e = await bootServer(t, { config: noLocale })
  assert.equal((await request(e.port, '/api/config')).json.locale, 'en')
})

test('tHtml (Telegram): translates, then escapes each parameter (HTML and IP, via the t of format.js), count included, never the template; the plural follows count', async () => {
  const { tHtml } = await import('../lib/notify/format.js')
  const t = createI18n({ catalogs: { ...CAT, fr: { ...CAT.fr, 'x.seen': '<b>{name}</b> vu sur {ip} : {count} fois' } }, getLocale: () => 'fr', strict: true })
  assert.equal(tHtml('x.html', { title: '<script>', detail: 'a & b' }, t), '<b>&lt;script&gt;</b> — a &amp; b')
  assert.equal(tHtml('x.seen', { name: '<i>x</i>', ip: '192.0.2.9:22', count: '<script>alert(1)</script> 192.0.2.9' }, t),
    '<b>&lt;i&gt;x&lt;/i&gt;</b> vu sur ‹ip› : &lt;script&gt;alert(1)&lt;/script&gt; ‹ip› fois')
  assert.deepEqual([1, 3].map(count => tHtml('x.alerts', { count }, t)), ['1 alerte', '3 alertes'], 'plural unchanged')
  // real catalog still empty: missing key reported
  assert.throws(() => tHtml('x.html', { title: 'x' }), /missing key: x\.html/)
})

test('client t: same contract (interpolation, plural, fallback, strict); setLocale ignores an unknown locale', async t => {
  const c = await clientBundle(t, 'p5a-i18n', [
    "export * from './src/i18n/index.js'",
  ])
  if (!c) return
  assert.deepEqual([c.locale(), c.localeTag()], ['fr', 'fr-FR'])
  c.setLocale('de')
  assert.equal(c.locale(), 'fr')
  c.setLocale('en')
  assert.equal(c.locale(), 'fr', 'English catalog not loaded yet: locale unchanged')
  assert.equal(await c.loadLocale('en'), 'en')
  assert.equal(c.localeTag(), 'en-GB')
  c.setLocale('fr')
  // strict by default under node --test; outside strict (browser), fallback to the key
  assert.throws(() => c.t('absente.cle'), /i18n: missing key: absente\.cle \(fr\)/)
  c.setStrict(false)
  assert.equal(c.t('absente.cle'), 'absente.cle')
  c.setStrict(true)
})

test('server formats: widget numbers by the instance locale (former fr, en-GB); machine clock independent of the locale; no hardcoded fr-FR left outside the i18n modules', async () => {
  const { widgetFormats } = await import('../lib/registry.js')
  await import('../lib/widget-types.js')
  const { createClock } = await import('../lib/clock.js')
  const { numberFormat } = await import('../lib/i18n.js')
  const num = v => widgetFormats.get('number').format(v)
  const T = Date.parse('2026-11-10T22:30:00Z') // Tuesday 23:30 in Paris
  const before = createClock('Europe/Paris').local(T)
  assert.deepEqual([num(1234.56), widgetFormats.get('percent').format(6.39)], ['1 234,6', '6,4 %'])
  setLocale('en')
  try {
    assert.deepEqual([num(1234.56), widgetFormats.get('percent').format(6.39), numberFormat({ maximumFractionDigits: 0 }).format(1234.5)], ['1,234.6', '6.4 %', '1,235'])
    assert.deepEqual(createClock('Europe/Paris').local(T), before, 'machine clock identical')
  } finally {
    setLocale('fr')
  }
  assert.deepEqual(before, { date: '2026-11-10', dm: '10/11', hm: '23:30', minutes: 1410, weekday: 2 })
  // no hardcoded fr-FR left (server and client), except the tag table of the i18n modules
  // files: git grep, otherwise (copy without .git) a directory walk, like docker.test.js
  const { execFileSync } = await import('node:child_process')
  const root = new URL('../..', import.meta.url).pathname
  let hits
  try {
    hits = execFileSync('git', ['grep', '-l', "'fr-FR'", '--', 'server/lib', 'server/plugins', 'server/index.js', 'client/src'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean)
  } catch {
    const pathm = await import('node:path')
    hits = []
    const walk = rel => {
      for (const e of fs.readdirSync(pathm.join(root, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!['node_modules', '.git', 'dist'].includes(e.name)) walk(p) } else if (/\.(js|jsx)$/.test(e.name) && fs.readFileSync(pathm.join(root, p), 'utf8').includes("'fr-FR'")) hits.push(p)
      }
    }
    for (const d of ['server/lib', 'server/plugins', 'client/src']) walk(d)
    if (fs.readFileSync(pathm.join(root, 'server/index.js'), 'utf8').includes("'fr-FR'")) hits.push('server/index.js')
  }
  assert.deepEqual(hits.sort(), ['client/src/i18n/index.js', 'server/lib/i18n.js'])
})

test('client formats: real view whose formatter is created WHEN THE MODULE LOADS (Nodes: n1); it follows the locale set afterwards', async t => {
  const c = await clientBundle(t, 'p5a-nodes', [
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement as h } from 'react'",
    "import Nodes from './src/components/Nodes.jsx'",
    "import { loadLocale, setLocale } from './src/i18n/index.js'",
    // English catalog loaded before rendering in English (separate chunk in the browser)
    "export const ready = loadLocale('en').then(() => setLocale('fr'))",
    'const px = { nodes: [{ node: "pve-a", pveVersion: "8", kernel: "6", uptime: 3600, mem: { total: 100, used: 50, available: 50 }, swap: { total: 0 }, rootfs: { total: 0 }, cpus: 4, load: [1.25, 0.5], cpuModel: "cpu", iowait: 0.0123 }], disks: [], tasks: [], notifications: null }',
    'export function render(l) { setLocale(l); const html = renderToStaticMarkup(h(Nodes, { px, cluster: { nodes: [{ name: "pve-a", cpu: 0.5 }] } })); setLocale("fr"); return html }',
  ])
  if (!c) return
  await c.ready
  // the module is loaded in fr (default); the view rendered in en must still format in en
  // the text follows the locale too (catalog)
  assert.match(c.render('en'), /I\/O wait 1\.2 %/)
  assert.match(c.render('en'), /load 1\.3 0\.5/)
  assert.match(c.render('fr'), /attente E\/S 1,2 %/)
})

test('client formats: dates and numbers by the instance locale (TimeAgo, gauges), former fr by default', async t => {
  const c = await clientBundle(t, 'p5a-formats', [
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement as h } from 'react'",
    "import TimeAgo from './src/ui/TimeAgo.jsx'",
    "import { loadLocale, setLocale, numberFormat } from './src/i18n/index.js'",
    // English catalog loaded before rendering in English (separate chunk in the browser)
    "export const ready = loadLocale('en').then(() => setLocale('fr'))",
    'export function title(l, ts) { setLocale(l); const html = renderToStaticMarkup(h(TimeAgo, { date: ts })); setLocale("fr"); return html.match(/title="([^"]*)"/)[1] }',
    'export function num(l, v) { setLocale(l); const s = numberFormat({ maximumFractionDigits: 1 }).format(v); setLocale("fr"); return s }',
  ])
  if (!c) return
  await c.ready
  const ts = Date.parse('2026-11-10T09:05:07Z')
  const fr = c.title('fr', ts)
  const en = c.title('en', ts)
  assert.equal(fr, new Date(ts).toLocaleString('fr-FR'))
  assert.equal(en, new Date(ts).toLocaleString('en-GB'))
  assert.notEqual(fr, en)
  assert.deepEqual([c.num('fr', 1234.56), c.num('en', 1234.56)], ['1 234,6', '1,234.6'])
})

test('Proxmox error code (rules.js): the source classifies (api: HTTP status or missing token; network: unreachable); guest suppression decides on the code, no longer on the text', async () => {
  const { createSources } = await import('../lib/sources.js')
  const { createRules } = await import('../lib/alerts/rules.js')
  const raw = { version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], alerts: {},
    proxmox: [{ id: 'a', label: 'A', host: 'http://192.0.2.10:8006', env: 'PVE_A' }, { id: 'b', label: 'B', host: 'http://192.0.2.11:8006', env: 'PVE_B' }, { id: 'c', label: 'C', host: 'http://192.0.2.12:8006', env: 'PVE_C' }],
    hosts: [{ id: 'na', name: 'na', kind: 'pve-node', pve: 'a', ip: '192.0.2.10', env: 'prod' }, { id: 'nb', name: 'nb', kind: 'pve-node', pve: 'b', ip: '192.0.2.11', env: 'prod' }, { id: 'nc', name: 'nc', kind: 'pve-node', pve: 'c', ip: '192.0.2.12', env: 'prod' }] }
  const cfg = parseConfig(raw).config
  const env = { PVE_A_TOKEN_ID: 'x@pve!t', PVE_A_TOKEN_SECRET: 's', PVE_C_TOKEN_ID: 'x@pve!t', PVE_C_TOKEN_SECRET: 's' } // B: missing token
  const fetch = async url => {
    if (url.startsWith('http://192.0.2.10')) return { ok: false, status: 401, json: async () => ({}) }
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }
  const src = createSources(cfg, env, { fetch, now: () => Date.parse('2026-11-10T09:00:00Z') })
  const cluster = await src.cluster()
  assert.deepEqual(cluster.map(c => [c.id, c.errorKind]), [['a', 'api'], ['b', 'api'], ['c', 'network']])
  assert.deepEqual(cluster.map(c => c.error), ['Proxmox 401', 'token PVE_B_TOKEN_SECRET absent', cluster[2].error])
  // rule: on the code; a text resembling the old pattern no longer decides anything
  const rules = createRules(cfg, { checks: [], result: () => null })
  const masks = entries => Object.fromEntries(rules.evaluate({ cluster: { data: entries, error: null } }, Date.now()).filter(s => s.rule === 'pve_unreachable').map(s => [s.entity, s.masksChildren]))
  assert.deepEqual(masks([{ id: 'a', error: 'Proxmox 401', errorKind: 'api' }, { id: 'b', error: 'Proxmox 401', errorKind: 'network' }, { id: 'c', error: 'n\'importe quoi', errorKind: 'api' }]), { a: false, b: true, c: false })
  assert.doesNotMatch(fs.readFileSync(new URL('../lib/alerts/rules.js', import.meta.url), 'utf8'), /Proxmox \\d\{3\}|token \.\* absent/)
})

test('index.js sets the instance locale from the config (real server: widget formatted server side in en); static wiring', { timeout: 60_000 }, async t => {
  const http = await import('node:http')
  const svc = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ n: 1234.56 })) })
  await new Promise(r => svc.listen(0, '127.0.0.1', r))
  t.after(() => svc.close())
  const url = `http://127.0.0.1:${svc.address().port}`
  const services = [{ id: 'w', name: 'W', group: 'g', host: 'web', url, widget: { url, fields: [{ label: 'N', path: '/n', json: 'n' }] } }]
  const value = async locale => {
    const s = await bootServer(t, { config: bootConfig({ security: { anonymousRead: true }, locale, services }) })
    const { until } = await import('./server-boot.js')
    let v = null
    await until(async () => (v = (await request(s.port, '/api/services')).json?.services?.find(x => x.id === 'w')?.widget?.fields?.[0]?.value), 15_000)
    return v
  }
  assert.equal(await value('en'), '1,234.6')
  assert.equal(await value('fr'), '1\u202f234,6')
  assert.match(fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /^const cfg = loaded\.config\n\/\/ instance language[^\n]*\nsetLocale\(cfg\.locale\)$/m)
})

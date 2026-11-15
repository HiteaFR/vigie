// Client startup (client/src/boot.js) EXECUTED, with the client's real loadLocale: fake fetch
// (response, timeout, HTTP error), fake catalog imports (chunk that loads or fails). Rendering
// waits for a loaded catalog; a missing chunk falls back to the default locale; with no catalog
// at all, the last-resort message, never a blank page. A fresh module per case (catalog state
// specific to each startup).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ESBUILD = path.join(ROOT, 'client/node_modules/esbuild/lib/main.js')
let file = null
let n = 0
async function fresh(t) {
  if (!fs.existsSync(ESBUILD)) return t.skip('client not installed (npm ci in client/)')
  if (!file) {
    const { build } = await import(ESBUILD)
    const r = await build({
      stdin: { contents: "export * from './src/boot.js'\nexport { loadLocale, loadedLocales, locale, t } from './src/i18n/index.js'", resolveDir: path.join(ROOT, 'client'), loader: 'js' },
      bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error',
    })
    file = path.join(tmpDir('vigie-p5d-boot-'), 'boot.mjs')
    fs.writeFileSync(file, r.outputFiles[0].text)
  }
  return import(`${file}?cas=${++n}`)
}

const ok = cat => async () => ({ default: cat })
const broken = async () => { throw new TypeError('Failed to fetch dynamically imported module') }
const CATS = { fr: ok({ 'x.y': 'bonjour' }), en: ok({ 'x.y': 'hello' }) }
const json = body => async () => ({ ok: true, json: async () => body })
// answers only when asked to… or never; honors the abort signal, like fetch
const silent = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))

async function start(m, { fetchImpl, loaders = CATS, render, timeoutMs, storage = null } = {}) {
  const calls = { config: [], render: 0, fail: 0, urls: [], loads: [] }
  const result = await m.boot({
    fetchImpl: async (url, opts) => { calls.urls.push([url, opts.headers.accept, !!opts.signal]); return fetchImpl(url, opts) },
    i18n: { loadLocale: l => (calls.loads.push(l), m.loadLocale(l, loaders)), loadedLocales: m.loadedLocales },
    onConfig: c => calls.config.push(c),
    render: render ?? (() => { calls.render++; calls.text = m.t('x.y') }),
    fail: () => calls.fail++,
    timeoutMs,
    storage,
  })
  return { result, calls, locale: m.locale(), loaded: m.loadedLocales().sort() }
}

test('executed startup: config locale loaded before rendering, config cached, bounded request', async t => {
  const m = await fresh(t)
  if (!m) return
  // a config locale different from the product default (en)
  const r = await start(m, { fetchImpl: json({ title: 'Banc', locale: 'fr' }) })
  assert.deepEqual([r.result, r.calls.render, r.calls.fail, r.calls.text, r.locale, r.loaded], ['rendered', 1, 0, 'bonjour', 'fr', ['fr']])
  assert.deepEqual(r.calls.config, [{ title: 'Banc', locale: 'fr' }])
  assert.deepEqual(r.calls.urls, [['/api/config', 'application/json', true]], 'timeout (signal) on the request')
  assert.equal(m.CONFIG_TIMEOUT_MS, 4000)
})

test('executed startup: silent /api/config → bounded delay, rendering in the default locale (en); HTTP error, unreadable response, unknown locale → en', async t => {
  const m = await fresh(t)
  if (!m) return
  const t0 = Date.now()
  // AbortSignal.timeout does not keep the Node event loop alive ("unref" timer): without this
  // keep-alive, the test would end before expiry; nothing like that in the browser
  const keep = setInterval(() => {}, 1000)
  let r
  try {
    r = await start(m, { fetchImpl: silent, timeoutMs: 50 })
  } finally {
    clearInterval(keep)
  }
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
  assert.deepEqual([r.result, r.calls.render, r.calls.config, r.calls.text, r.locale], ['rendered', 1, [], 'hello', 'en'])
  for (const fetchImpl of [async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => ({ ok: true, json: async () => { throw new SyntaxError('JSON') } }), json({ locale: 'de' }), async () => { throw new TypeError('network') }]) {
    const x = await start(await fresh(t), { fetchImpl })
    assert.deepEqual([x.result, x.calls.render, x.calls.text, x.locale, x.loaded], ['rendered', 1, 'hello', 'en', ['en']])
  }
})

test('executed startup: locale chunk not found → second attempt with the default locale (en)', async t => {
  const m = await fresh(t)
  if (!m) return
  const r = await start(m, { fetchImpl: json({ locale: 'fr' }), loaders: { ...CATS, fr: broken } })
  assert.deepEqual([r.result, r.calls.render, r.calls.fail, r.calls.text, r.locale, r.loaded], ['rendered', 1, 0, 'hello', 'en', ['en']])
})

test('executed startup: no catalog (neither the locale nor the default one), or rendering that throws → last-resort message, never a rejection', async t => {
  const m = await fresh(t)
  if (!m) return
  const r = await start(m, { fetchImpl: json({ locale: 'fr' }), loaders: { fr: broken, en: broken } })
  assert.deepEqual([r.result, r.calls.render, r.calls.fail, r.loaded], ['failed', 0, 1, []])
  const fr = await start(await fresh(t), { fetchImpl: json({}), loaders: { fr: CATS.fr, en: broken } })
  assert.deepEqual([fr.result, fr.calls.fail], ['failed', 1])
  const thrown = await start(await fresh(t), { fetchImpl: json({}), render: () => { throw new Error('rendu') } })
  assert.deepEqual([thrown.result, thrown.calls.fail], ['failed', 1])
  // the message itself: bilingual, placed in the root, announced (role alert)
  const root = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v } }
  m.showFatal(root)
  assert.deepEqual(root.attrs, { role: 'alert' })
  assert.equal(root.textContent, m.FATAL_TEXT)
  assert.match(m.FATAL_TEXT, /Impossible de charger l'interface.*The interface could not be loaded/)
})

// last known locale of this browser (localStorage), written on each successful /api/config, read
// only as a fallback; each access guarded (blocked storage, private mode: default locale)
const memory = (init = {}) => {
  const data = { ...init }
  const log = []
  return { data, log, getItem: k => (log.push(['get', k]), Object.hasOwn(data, k) ? data[k] : null), setItem: (k, v) => { log.push(['set', k, v]); data[k] = String(v) } }
}
const throwing = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }
const down = async () => { throw new TypeError('network') }

test('executed startup: successful /api/config → locale remembered, memory never read; failure with fr remembered → fr', async t => {
  const m = await fresh(t)
  if (!m) return
  const st = memory()
  const ok = await start(m, { fetchImpl: json({ locale: 'fr' }), storage: st })
  assert.deepEqual([ok.result, ok.locale, st.data['vigie.locale']], ['rendered', 'fr', 'fr'])
  assert.deepEqual(st.log, [['set', 'vigie.locale', 'fr']], 'written, not read')
  // transient failure: the French instance stays in French
  const r = await start(await fresh(t), { fetchImpl: down, storage: st })
  assert.deepEqual([r.result, r.calls.text, r.locale, r.loaded], ['rendered', 'bonjour', 'fr', ['fr']])
  // /api/config that answers but its locale catalog is missing: the memory, then the default
  const c = await start(await fresh(t), { fetchImpl: json({ locale: 'fr' }), loaders: { ...CATS, fr: broken }, storage: memory({ 'vigie.locale': 'fr' }) })
  assert.deepEqual([c.result, c.locale], ['rendered', 'en'])
})

test('executed startup: failure without memory, storage that throws, missing, or unknown remembered locale → en; config without a recognized locale: default, memory ignored', async t => {
  for (const storage of [memory(), throwing, null, memory({ 'vigie.locale': 'de' }), memory({ 'vigie.locale': '' })]) {
    const r = await start(await fresh(t), { fetchImpl: down, storage })
    assert.deepEqual([r.result, r.calls.text, r.locale], ['rendered', 'hello', 'en'], JSON.stringify(storage?.data ?? storage))
    assert.deepEqual(r.calls.loads, ['en'], 'unknown stored locale: never requested')
  }
  // write that throws: rendering happens anyway, in the config locale
  const w = await start(await fresh(t), { fetchImpl: json({ locale: 'fr' }), storage: throwing })
  assert.deepEqual([w.result, w.locale], ['rendered', 'fr'])
  // the config answered without a recognized locale: it is the default locale, not the memory
  const st = memory({ 'vigie.locale': 'fr' })
  const n = await start(await fresh(t), { fetchImpl: json({ title: 'Banc', locale: 'de' }), storage: st })
  assert.deepEqual([n.result, n.locale, st.data['vigie.locale']], ['rendered', 'en', 'fr'])
  assert.deepEqual(st.log, [], 'neither read nor written')
})

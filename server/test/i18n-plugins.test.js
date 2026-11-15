// Plugin i18n. Catalog stored next to the plugin (plugins/<id>/locales/<locale>.json),
// ctx.t in the instance locale, ctx.tAll for the labels hook ({ en, fr }), labels of the
// core modules via the instance catalog; gitea, ntfy and the example: same keys and same
// parameters in each language, former French byte for byte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHost, definePlugin, pluginLocales, labelIn } from '../lib/plugins/host.js'
import { coreModules } from '../lib/plugins/core.js'
import { CORE_RULES } from '../lib/alerts/rules.js'
import { setLocale } from '../lib/i18n.js'
import gitea from '../plugins/gitea/index.js'
import ntfy from '../plugins/ntfy/index.js'
import example from '../plugins/example/index.js'

const quiet = { log() {}, warn() {}, error() {} }
const T0 = Date.parse('2026-11-10T09:00:00Z')
const inEnglish = fn => {
  setLocale('en')
  try {
    return fn()
  } finally {
    setLocale('fr')
  }
}

test('plugin catalogs: fr and en for gitea, ntfy, the example; same keys, same parameters, same plural forms', () => {
  const params = v => (typeof v === 'string' ? [v] : Object.values(v)).flatMap(s => s.match(/\{\w+\}/g) ?? []).sort()
  for (const p of [gitea, ntfy, example]) {
    assert.deepEqual(Object.keys(p.locales).sort(), ['en', 'fr'], p.id)
    const { fr, en } = p.locales
    assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort(), p.id)
    for (const k of Object.keys(fr)) {
      assert.equal(typeof en[k], typeof fr[k], `${p.id} ${k}`)
      assert.deepEqual([...new Set(params(en[k]))], [...new Set(params(fr[k]))], `${p.id} ${k}`)
    }
    // files read by pluginLocales, next to the plugin
    for (const l of ['fr', 'en']) assert.deepEqual(p.locales[l], JSON.parse(fs.readFileSync(new URL(`../plugins/${p.id}/locales/${l}.json`, import.meta.url), 'utf8')))
  }
  assert.deepEqual(pluginLocales(new URL('../plugins/aucun/index.js', import.meta.url)), {})
})

test('ctx.t and ctx.tAll: instance locale, missing key refused under test, labels { en, fr } read in the locale', () => {
  let ctxSeen
  const p = definePlugin({
    id: 'demo', apiVersion: 0, configured: () => true,
    locales: { fr: { hi: 'Bonjour {who}', label: 'Démo' }, en: { hi: 'Hello {who}', label: 'Demo' } },
    setup(ctx) { ctxSeen = ctx; return { rules: ['demo_rule'], labels: { demo_rule: ctx.tAll('label') } } },
  })
  const host = createHost({ cfg: {}, log: quiet, plugins: [p] })
  assert.equal(ctxSeen.t('hi', { who: 'Alice' }), 'Bonjour Alice')
  assert.equal(inEnglish(() => ctxSeen.t('hi', { who: 'Alice' })), 'Hello Alice')
  assert.throws(() => ctxSeen.t('absente'), /missing key: absente/)
  assert.deepEqual(ctxSeen.tAll('label'), { fr: 'Démo', en: 'Demo' })
  assert.deepEqual(host.labels({}), { demo_rule: 'Démo' })
  assert.deepEqual(inEnglish(() => host.labels({})), { demo_rule: 'Demo' })
  assert.equal(labelIn('Texte'), 'Texte')
  assert.equal(labelIn({ en: 'Only' }), 'Only', 'fallback: en')
  // malformed label or malformed catalog: refused with a clear message
  const bad = createHost({ cfg: {}, log: quiet, plugins: [definePlugin({ id: 'bad', apiVersion: 0, configured: () => true, setup: () => ({ rules: ['bad_rule'], labels: { bad_rule: { de: 'x' } } }) })] })
  assert.match(bad.list().find(m => m.id === 'bad').errors.setup.message, /label of rule bad_rule/)
  assert.throws(() => definePlugin({ id: 'bad2', apiVersion: 0, setup: () => ({}), locales: { de: {} } }), /locales/)
})

test('core modules: label via the catalog (network), plugin_error title and the "unavailable" line of the digest', () => {
  const network = { signals: () => [], digestLines: () => { throw new Error('boom') }, summary: () => null }
  const host = createHost({ cfg: {}, log: quiet, modules: coreModules({ updates: { signals: () => [], digestLines: () => [], counts: () => ({}) }, network }) })
  const view = () => {
    const lines = host.digestLines('end', { now: T0 })
    const pe = host.signals({}, T0).find(s => s.key === 'plugin_error:network')
    return [host.list().map(m => m.label), lines, pe.title]
  }
  assert.deepEqual(view(), [['versions', 'réseau'], ['⚠️ réseau : indisponible'], 'Module réseau en erreur'])
  assert.deepEqual(inEnglish(view), [['versions', 'network'], ['⚠️ network: unavailable'], 'Module network error'])
})

test('gitea in English: source titles, runner state, CI line of the digest, labels; former French byte for byte', () => {
  const snap = {
    gitea: { data: [{ name: 'app', defaultBranch: 'main', mainRun: { status: 'failure', number: 12, title: 't' } }], error: 'Gitea 500', at: T0 },
    runners: { data: [{ name: 'runner-a', status: 'offline' }], error: null, at: T0 },
  }
  const host = createHost({ cfg: { plugins: { gitea: { owner: 'o' } } }, env: { GITEA_URL: 'http://gitea.example.net', GITEA_TOKEN: 'x' }, log: quiet, plugins: [gitea], coreRules: CORE_RULES })
  const view = () => {
    const sig = host.signals(snap, T0)
    const by = k => sig.find(s => s.key === k)
    return [by('source_error:gitea').title, by('source_error:runners').title, by('runner_offline:runner-a').detail, host.digestLines('ci', { snap, now: T0 }), host.labels({})]
  }
  assert.deepEqual(view(), ['Lecture de Gitea', 'Lecture des runners Gitea', 'état : offline', ['⚙️ CI : runners 0/1 en ligne · en échec : app'], { ci_failed: 'CI en échec', runner_offline: 'Runner hors ligne' }])
  assert.deepEqual(inEnglish(view), ['Reading Gitea', 'Reading Gitea runners', 'state: offline', ['⚙️ CI: runners 0/1 online · failing: app'], { ci_failed: 'CI failing', runner_offline: 'Runner offline' }])
})

test('ntfy: network error message via the catalog (no URL or token)', async () => {
  const http = async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }) }
  const slow = async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }
  const send = async h => {
    const host = createHost({ cfg: { plugins: { ntfy: { url: 'https://ntfy.example.net', topic: 't' } } }, env: { NTFY_TOKEN: 'secret-jeton' }, log: quiet, plugins: [ntfy], http: h })
    const [ch] = host.channels()
    return ch.send([{ plain: 'a', severity: 'warning' }]).then(() => null, e => e.message)
  }
  assert.equal(await send(http), 'ntfy : ECONNREFUSED')
  assert.equal(await send(slow), 'ntfy : délai dépassé')
  setLocale('en')
  try {
    assert.equal(await send(slow), 'ntfy: timed out')
  } finally {
    setLocale('fr')
  }
})

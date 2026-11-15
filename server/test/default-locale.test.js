// English is the product's default language. A config WITHOUT a locale key gives an English
// instance: server (module default, schema, /api/config, API errors, 421 page), digest, client
// (before /api/config, and at startup if the config says nothing). The other tests run in French
// (test/setup-locale.mjs, like an instance with "locale": "fr"): this file checks the default itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../lib/config.js'
import { DEFAULT_LOCALE, locale, setLocale } from '../lib/i18n.js'
import { bootServer, bootConfig, request } from './server-boot.js'
import { tmpDir } from './tmpdir.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(SERVER, '..')
const noLocale = over => {
  const { locale: _drop, ...c } = bootConfig(over)
  return c
}

test('default: en for the i18n module (process without preload) and for the config schema', () => {
  assert.equal(DEFAULT_LOCALE, 'en')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./lib/i18n.js'); console.log(m.locale(), m.t('digest.none'))"], { cwd: SERVER, encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(out.trim(), 'en none')
  const MIN = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }
  assert.equal(parseConfig(MIN).config.locale, 'en')
  assert.equal(parseConfig({ ...MIN, locale: 'fr' }).config.locale, 'fr')
})

test('real server without a locale key: /api/config en, API errors and 421 page in English', { timeout: 60_000 }, async t => {
  const s = await bootServer(t, { config: noLocale() })
  assert.equal((await request(s.port, '/api/config')).json.locale, 'en')
  assert.deepEqual((await request(s.port, '/api/alerts')).json, { error: 'admin login required' })
  const page = await request(s.port, '/network', { host: 'evil.example:8443', headers: { accept: 'text/html' } })
  assert.equal(page.status, 421)
  assert.match(page.body, /<html lang="en">/)
  assert.match(page.body, /Name not allowed/)
  // the same instance with "locale": "fr": French
  const f = await bootServer(t, { config: bootConfig() })
  assert.deepEqual((await request(f.port, '/api/alerts')).json, { error: 'connexion admin requise' })
})

test('digest of a config without a locale key: in English (same world as the golden files)', async t => {
  const { outputs, rawConfig } = await import('./golden/world.js')
  const raw = rawConfig()
  delete raw.locale
  const loc = parseConfig(raw).config.locale
  assert.equal(loc, 'en')
  try {
    const out = await outputs({ storeDir: tmpDir('vigie-p5g-', t), locale: loc })
    assert.match(out['digest.txt'], /^☀️ <b>Infra — digest for /)
    assert.equal(out['digest.txt'], fs.readFileSync(path.join(SERVER, 'test/golden/digest.en.txt'), 'utf8'))
  } finally {
    setLocale('fr')
  }
  assert.equal(locale(), 'fr')
})

test('client: en before /api/config, and at startup when the config says nothing; index.html in "en"', async t => {
  const esb = path.join(ROOT, 'client/node_modules/esbuild/lib/main.js')
  if (!fs.existsSync(esb)) return t.skip('client not installed (npm ci in client/)')
  const { build } = await import(esb)
  const r = await build({ stdin: { contents: "export * from './src/boot.js'\nexport { loadLocale, loadedLocales, locale, t, DEFAULT_LOCALE } from './src/i18n/index.js'", resolveDir: path.join(ROOT, 'client'), loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error' })
  const file = path.join(tmpDir('vigie-p5g-client-', t), 'c.mjs')
  fs.writeFileSync(file, r.outputFiles[0].text)
  const m = await import(file)
  assert.deepEqual([m.DEFAULT_LOCALE, m.locale()], ['en', 'en'])
  let rendered = null
  const result = await m.boot({
    fetchImpl: async () => ({ ok: true, json: async () => ({ title: 'Banc' }) }),
    i18n: { loadLocale: l => m.loadLocale(l), loadedLocales: m.loadedLocales },
    render: () => { rendered = m.t('common.close') },
    fail: () => {},
  })
  assert.deepEqual([result, m.locale(), rendered], ['rendered', 'en', 'Close'])
  assert.match(fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8'), /<html lang="en">/)
  assert.match(fs.readFileSync(path.join(ROOT, 'client/src/main.jsx'), 'utf8'), /document\.documentElement\.lang = locale\(\)/)
})

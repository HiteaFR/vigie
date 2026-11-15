// Collection and probe errors, widget formats, weather: via the catalog (former French byte
// for byte, English alongside). These are texts read by a person (interface, alert detail,
// Telegram); no code reads them back (the Proxmox failure decides on errorKind).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dnsVerdict } from '../lib/checks.js'
import { parseArp } from '../lib/network/sources/arp.js'
import { createTelegram } from '../lib/notify/telegram.js'
import { createWeather } from '../lib/weather.js'
import { widgetFormats } from '../lib/registry.js'
import '../lib/widget-types.js'
import { setLocale } from '../lib/i18n.js'

const both = async fn => {
  const fr = await fn()
  setLocale('en')
  try {
    return [fr, await fn()]
  } finally {
    setLocale('fr')
  }
}

test('probes and arp file: error messages in both languages', async () => {
  assert.deepEqual(await both(() => [dnsVerdict([], {}).error, dnsVerdict(['192.0.2.1'], { expect: { address: '192.0.2.2' } }).error]), [
    ['aucune adresse', 'réponse 192.0.2.1, attendu 192.0.2.2'],
    ['no address', 'answer 192.0.2.1, expected 192.0.2.2'],
  ])
  const arp = () => [parseArp('{').error, parseArp(JSON.stringify({ v: 2 })).error, parseArp(JSON.stringify({ v: 1, ts: 1, ok: true, hosts: Array(5000).fill({}) }), { now: 2 }).error]
  assert.deepEqual(await both(arp), [
    ['fichier arp illisible (JSON invalide)', 'fichier arp : version inconnue', 'fichier arp refusé : plus de 1024 hôtes'],
    ['arp file unreadable (invalid JSON)', 'arp file: unknown version', 'arp file refused: more than 1024 hosts'],
  ])
})

test('Telegram unreachable: message without URL or token, in both languages', async () => {
  const tg = createTelegram({ token: 'jeton-secret', chatId: '1', fetch: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }) } })
  const msg = () => tg.send('x').then(() => null, e => e.message)
  assert.deepEqual(await both(msg), ['réseau : ECONNRESET', 'network: ECONNRESET'])
})

test('widget formats (formatted server side) in both languages', async () => {
  const f = name => v => widgetFormats.get(name).format(v)
  const now = Date.now()
  const view = () => [
    f('until')('0001-01-01T00:00:00Z'), f('until')(new Date(now - 86400_000).toISOString()), f('until')(new Date(now + 3.5 * 86400_000).toISOString()),
    f('ago')(new Date(now).toISOString()), f('ago')(new Date(now - 5 * 60_000).toISOString()), f('ago')(new Date(now - 3 * 3600_000).toISOString()), f('ago')(new Date(now - 4 * 86400_000).toISOString()),
    f('bool')(true), f('bool')(false), f('rate')(1536),
  ]
  assert.deepEqual(await both(view), [
    ['jamais', 'expiré', '3 j', 'à l\'instant', 'il y a 5 min', 'il y a 3 h', 'il y a 4 j', 'oui', 'non', '1,5 Ko/s'],
    ['never', 'expired', '3 d', 'just now', '5 min ago', '3 h ago', '4 d ago', 'yes', 'no', '1.5 KB/s'],
  ])
})

test('weather: WMO label in the instance locale', async () => {
  const read = async () => {
    const timers = []
    const body = { current: { temperature_2m: 1, weather_code: 96, is_day: 1 }, daily: {} }
    const w = createWeather({ label: 'x', lat: 1, lon: 1 }, { fetch: async () => new Response(JSON.stringify(body)), setTimer: fn => timers.push(fn) })
    w.start()
    await timers.shift()()
    return w.get().data.text
  }
  assert.deepEqual(await both(read), ['Orage et grêle', 'Thunderstorm with hail'])
})

test('date of an update decision, error without message, plugin widget error, in both languages', async () => {
  const { createDecisions } = await import('../lib/updates/decisions.js')
  const { tmpStore } = await import('./tmpdir.js')
  const { redactError } = await import('../lib/redact.js')
  const d = createDecisions({ store: tmpStore('dash-p5c-dec-') })
  const msgs = () => {
    let date
    try {
      d.create({ compId: 'os:x', mode: 'until', until: '1er mai', reason: 'motif assez long', by: 'x' })
    } catch (e) {
      date = e.message
    }
    return [date, redactError(null), redactError(undefined)]
  }
  assert.deepEqual(await both(msgs), [['date : AAAA-MM-JJ', 'erreur', 'erreur'], ['date: YYYY-MM-DD', 'error', 'error']])
})

// two sentences made identical again to the former production (the golden files do not see
// them): mDNS interface without a single IPv4, missing variable of a version header
test('mDNS interface without a single IPv4 and missing header variable, sentences of the former production', async () => {
  const { ifaceIp } = await import('../lib/network/sources/mdns.js')
  const { createUpdates } = await import('../lib/updates/index.js')
  const { parseConfig } = await import('../lib/config.js')
  const { tmpStore } = await import('./tmpdir.js')
  const iface = () => {
    try {
      ifaceIp('eth9', { eth9: [{ family: 'IPv4', address: '192.0.2.5', internal: false }, { family: 'IPv4', address: '192.0.2.6', internal: false }] })
    } catch (e) {
      return e.message
    }
  }
  const parsed = parseConfig({
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], hosts: [],
    services: [{ id: 'app', name: 'App', group: 'g', env: 'prod', url: 'http://192.0.2.7', version: {
      current: { from: 'http-json', url: 'http://192.0.2.7/version', path: 'version', auth: { type: 'header', name: 'X-Key', secretEnv: 'APP_KEY' } },
      latest: { from: 'github', repo: 'o/app' } } }],
  })
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const upstream = { github: async () => [{ tag: 'v1.0.0', body: '' }], githubTags: async () => [], eol: async () => [], node: async () => [], httpJson: async () => ({ version: '1.0.0' }), errors: () => [], stats: () => ({}) }
  const updates = createUpdates({ cfg: parsed.config, store: tmpStore('dash-p5c-var-'), agents: { hosts: [], get: () => ({ ok: null }) }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, env: {}, log: { error() {} } })
  const varMissing = async () => {
    await updates.refresh()
    return updates.view().components.find(c => c.id === 'svc:app')?.error
  }
  assert.deepEqual(await both(async () => [iface(), await varMissing()]), [
    ['interface eth9 : 2 IPv4 non internes (une seule attendue)', 'variable APP_KEY absente'],
    ['interface eth9: 2 non-internal IPv4 addresses (exactly one expected)', 'variable APP_KEY missing'],
  ])
})

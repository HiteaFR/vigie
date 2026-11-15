// vpn_noinfo. Gluetun tunnel running, widget fresh and without error, but neither
// country nor organization for the public IP (expired IP provider, real case on 2026-10-30): leak
// detection would be blind without saying so. FAKE widget; real engine for the 15 min delay
// (previously 10 min) and the masking by vpn_down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRules, RULE_LABEL } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { parseConfig } from '../lib/config.js'
import { tmpStore } from './tmpdir.js'

const T0 = Date.parse('2026-10-30T14:00:00Z')
const MIN = 60_000
const GLUETUN = {
  id: 'gluetun', name: 'Gluetun', group: 'g', host: 'docker-a', container: 'gluetun',
  widget: { url: 'http://192.0.2.156:8000', auth: { type: 'header', name: 'X-API-Key', secretEnv: 'GLUETUN_KEY' }, fields: [
    { label: 'VPN', path: '/v1/vpn/status', json: 'status', format: 'text' },
    { label: 'Pays', path: '/v1/publicip/ip', json: 'country', format: 'text' },
    { label: 'Opérateur', path: '/v1/publicip/ip', json: 'organization', format: 'text' },
  ] },
  checks: [{ type: 'http', url: 'http://192.0.2.156:8000/v1/publicip/ip', label: 'control server' }],
  vpn: { type: 'gluetun', homeIsp: 'FAI-Maison', countries: ['Netherlands'] },
}
const cfgFor = (env = 'prod', service = GLUETUN) => {
  const p = parseConfig({
    version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }, { id: 'dev', label: 'Dev', host: 'http://192.0.2.168:8006', env: 'PVE' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', env: 'prod' },
      { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', env: 'dev' },
      { id: 'docker-a', name: 'docker-a', kind: 'vm', pve: env === 'dev' ? 'dev' : 'prod', vmid: 101, env, agent: 'ssh', ip: '192.0.2.156' },
    ],
    services: [service],
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
// widget: values [status, country, organization] read at `at`
const widgets = state => ({ get: id => (id === 'gluetun' && state.values ? { fields: state.values.map((value, i) => ({ label: ['VPN', 'Pays', 'Opérateur'][i], value })), error: state.error ?? null, stale: false, at: new Date(state.at).toISOString() } : null) })
const sigsAt = (values, now = T0, { env = 'prod', error = null, service } = {}) => {
  const out = createRules(cfgFor(env, service), { checks: [], result: () => null }, null, null, null, widgets({ values, error, at: now - 30_000 })).evaluate({}, now)
  return k => out.find(s => s.key === k)
}

test('vpn_noinfo: running, country AND organization empty → warning (prod and dev alike), forSec 15 min, parents of vpn_leak plus vpn_down', () => {
  for (const values of [['running', '', ''], ['running', '—', '—'], ['Running', null, '  ']]) {
    const s = sigsAt(values)('vpn_noinfo:gluetun')
    assert.deepEqual([s.cond, s.severity, s.forSec, s.rule], [true, 'warning', 900, 'vpn_noinfo'], JSON.stringify(values))
    assert.equal(s.detail, 'ni pays ni organisation pour l\'IP publique : la détection de fuite est aveugle')
  }
  assert.equal(sigsAt(['running', '', ''], T0, { env: 'dev' })('vpn_noinfo:gluetun').severity, 'warning')
  const s = sigsAt(['running', '', ''])
  assert.deepEqual(s('vpn_noinfo:gluetun').parents, [...s('vpn_leak:gluetun').parents, 'vpn_down:gluetun'])
  assert.ok(s('vpn_noinfo:gluetun').parents.includes('container_restarting:docker-a/gluetun'))
  assert.equal(RULE_LABEL.vpn_noinfo, 'IP du VPN inconnue')
})

test('vpn_noinfo: only one of the two empty → no alert (vpn_leak can still judge); values present → false; without countries, a missing country field counts as empty', () => {
  for (const values of [['running', 'Netherlands', ''], ['running', '', 'AS9009 M247 Europe SRL'], ['running', 'Netherlands', 'AS9009 M247']]) {
    assert.equal(sigsAt(values)('vpn_noinfo:gluetun').cond, false, JSON.stringify(values))
  }
  assert.equal(sigsAt(['running', 'France', ''])('vpn_leak:gluetun').cond, true, 'country alone: the leak is still seen')
  // service without a "Pays" field (countries not configured): only the organization counts
  const noCountry = { ...GLUETUN, vpn: { type: 'gluetun', homeIsp: 'FAI-Maison' }, widget: { ...GLUETUN.widget, fields: [GLUETUN.widget.fields[0], GLUETUN.widget.fields[2]] } }
  const w2 = { get: () => ({ fields: [{ label: 'VPN', value: 'running' }, { label: 'Opérateur', value: '' }], error: null, stale: false, at: new Date(T0 - 30_000).toISOString() }) }
  const out = createRules(cfgFor('prod', noCountry), { checks: [], result: () => null }, null, null, null, w2).evaluate({}, T0)
  assert.equal(out.find(x => x.key === 'vpn_noinfo:gluetun').cond, true)
  // without countries but with a filled "Pays" field: the country is known, no alert
  const withField = { ...GLUETUN, vpn: { type: 'gluetun', homeIsp: 'FAI-Maison' } }
  const w3 = widgets({ values: ['running', 'Netherlands', ''], at: T0 - 30_000 })
  const out3 = createRules(cfgFor('prod', withField), { checks: [], result: () => null }, null, null, null, w3).evaluate({}, T0)
  assert.equal(out3.find(x => x.key === 'vpn_noinfo:gluetun').cond, false)
})

test('vpn_noinfo: tunnel stopped → only vpn_down; widget in error → vpn_down unchanged, vpn_noinfo without information; old or missing widget → null', () => {
  const stopped = sigsAt(['stopped', '', ''])
  assert.deepEqual([stopped('vpn_down:gluetun').cond, stopped('vpn_noinfo:gluetun').cond], [true, false])
  const err = sigsAt(['running', '', ''], T0, { error: '/v1/vpn/status → HTTP 401' })
  assert.deepEqual([err('vpn_down:gluetun').cond, err('vpn_down:gluetun').detail], [true, 'widget en erreur (surveillance du tunnel impossible) : /v1/vpn/status → HTTP 401'])
  assert.equal(err('vpn_noinfo:gluetun').cond, null)
  const old = createRules(cfgFor(), { checks: [], result: () => null }, null, null, null, widgets({ values: ['running', '', ''], at: T0 - 6 * MIN })).evaluate({}, T0)
  assert.equal(old.find(x => x.key === 'vpn_noinfo:gluetun').cond, null)
  assert.equal(sigsAt(null)('vpn_noinfo:gluetun').cond, null)
})

test('vpn_noinfo through the engine: empty 14 min → nothing, 16 min → fires (delay: 15 min); values back → resolved; tunnel stopped → vpn_down only, vpn_noinfo masked', () => {
  const sent = []
  const state = { values: ['running', 'Netherlands', 'AS9009 M247'], at: T0 }
  const engine = createEngine({ cfg: cfgFor(), store: tmpStore('dash-l12-vpn-'), rules: createRules(cfgFor(), { checks: [], result: () => null }, null, null, null, widgets(state)),
    notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: T0 - 60 * MIN })
  const at = (min, values) => { const t = T0 + min * MIN; Object.assign(state, { values, at: t - 20_000 }); engine.evaluate({}, t) }
  at(0, ['running', 'Netherlands', 'AS9009 M247'])
  at(1, ['running', '', ''])
  at(10, ['running', '', '']) // 9 min after the start
  at(15, ['running', '', '']) // 14 min
  assert.deepEqual(sent, [])
  at(17, ['running', '', '']) // 16 min
  assert.deepEqual(sent, ['open:vpn_noinfo:gluetun'])
  at(18, ['running', 'Netherlands', 'AS9009 M247'])
  assert.deepEqual(sent, ['open:vpn_noinfo:gluetun', 'resolve:vpn_noinfo:gluetun'])
  // tunnel stopped, empty fields: only vpn_down (vpn_noinfo false, and masked if it was firing)
  sent.length = 0
  for (const m of [25, 28, 45]) at(m, ['stopped', '', ''])
  assert.deepEqual(sent, ['open:vpn_down:gluetun'])
})

// /api/plugins route (state of modules and plugins for the Integrations page) and
// host.view(): read guarded like the others, no secret and no config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootServer, bootConfig, request } from './server-boot.js'

test('/api/plugins: state of modules and plugins, read guard, NO secret (no token, URL, or config)', { timeout: 60_000 }, async t => {
  const withPlugin = over => { const { gitea, ...rest } = bootConfig(over); return rest }
  const s = await bootServer(t, { config: withPlugin({ security: { anonymousRead: true }, plugins: { gitea: { owner: 'factice-proprietaire' } } }), env: { GITEA_URL: 'http://gitea.invalid:9', GITEA_TOKEN: 'jeton-tres-secret' } })
  const r = await request(s.port, '/api/plugins')
  assert.equal(r.status, 200)
  assert.equal(r.json.apiVersion, 0)
  assert.deepEqual(r.json.modules.map(m => [m.id, m.kind, m.state]), [['updates', 'core', 'active'], ['network', 'core', 'active'], ['gitea', 'plugin', 'active'], ['ntfy', 'plugin', 'unconfigured']])
  for (const k of ['jeton-tres-secret', 'gitea.invalid', 'factice-proprietaire', 'GITEA_']) assert.ok(!r.body.includes(k), k)
  // without anonymous read: session required, like the other reads
  const closed = await bootServer(t, { config: withPlugin({ plugins: { gitea: { owner: 'x' } } }) })
  assert.equal((await request(closed.port, '/api/plugins')).status, 401)
  // Gitea without GITEA_URL: "not configured"
  const off = await bootServer(t, { config: bootConfig({ security: { anonymousRead: true } }) })
  assert.equal((await request(off.port, '/api/plugins')).json.modules.find(m => m.id === 'gitea').state, 'unconfigured')
})

test('host.view(): active, not configured (no block, or status() → configured false), failing (hook that throws: short message and date, like plugin_error) then active on recovery', async () => {
  const { definePlugin, createHost, PLUGIN_API_VERSION } = await import('../lib/plugins/host.js')
  const { z } = await import('zod')
  const quiet = { log() {}, warn() {}, error() {} }
  const boom = { on: false }
  const mk = (id, hooks, extra = {}) => definePlugin({ id, apiVersion: 0, label: id.toUpperCase(), configSchema: z.object({}).strict(), ...extra, setup: () => hooks })
  const host = createHost({ cfg: { plugins: { casse: {}, muet: {} } }, log: quiet, now: () => Date.parse('2026-11-12T09:00:00Z'), plugins: [
    mk('casse', { rules: ['casse_rule'], signals: () => { if (boom.on) throw new Error('boom\nligne 2'); return [] } }),
    mk('muet', { status: () => ({ configured: false }) }),
    mk('absent', {}),
    mk('bizarre', { status: () => { throw new Error('x') } }, { configured: () => true }),
  ] })
  const st = () => Object.fromEntries(host.view().modules.map(m => [m.id, m.state]))
  assert.equal(host.view().apiVersion, PLUGIN_API_VERSION)
  assert.deepEqual(st(), { casse: 'active', muet: 'unconfigured', absent: 'unconfigured', bizarre: 'active' })
  boom.on = true
  host.signals({}, Date.parse('2026-11-12T09:00:00Z'))
  const casse = host.view().modules.find(m => m.id === 'casse')
  assert.equal(casse.state, 'error')
  assert.deepEqual(casse.errors, [{ hook: 'signals', message: 'boom ligne 2', at: '2026-11-12T09:00:00.000Z' }])
  assert.deepEqual(Object.keys(casse).sort(), ['errors', 'id', 'kind', 'label', 'state'], 'neither config nor secret')
  boom.on = false
  host.signals({}, Date.parse('2026-11-12T09:01:00Z'))
  assert.equal(st().casse, 'active')  // plugin refused at load (reserved id): listed, failing, "load" hook
  const refused = createHost({ cfg: {}, log: quiet, reservedIds: ['backups'], now: () => Date.parse('2026-11-12T09:00:00Z'), plugins: [mk('backups', {}, { configured: () => true })] }).view().modules
  assert.deepEqual(refused, [{ id: 'backups', label: 'BACKUPS', kind: 'plugin', state: 'error', errors: [{ hook: 'load', message: 'id backups réservé au cœur (source ou module du cœur), plugin non chargé', at: '2026-11-12T09:00:00.000Z' }] }])
})

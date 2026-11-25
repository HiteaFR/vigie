// Watchtower removed from the code (v1.0.1). The label com.centurylinklabs.watchtower.enable is
// no longer read: the "watchtower" field of a container is filtered by the allowlist, and a Docker
// container is never "auto". The GENERIC "auto" of the config (app that updates itself) and the
// one of Home Assistant stay. Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createUpdates } from '../lib/updates/index.js'
import { tmpStore } from './tmpdir.js'

const container = over => ({ name: '/app', image: 'registry.example/app:1.2.3', imageId: 'sha256:abc', state: 'running', ...over })

test('allowlist: the watchtower field of a container no longer passes, whatever its value', () => {
  for (const v of ['true', 'false', true, '', null]) {
    const fast = cleanFast({ version: 7, ts: 1, docker: { version: '29.9.1', containers: [container({ watchtower: v })] } })
    const c = fast.docker.containers[0]
    assert.equal(c.name, 'app')
    assert.ok(!Object.hasOwn(c, 'watchtower'), JSON.stringify(v))
  }
})

function bench(t, { containers = [], services = [] } = {}) {
  const raw = {
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], gitea: { owner: 'x' },
    proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
    hosts: [{ id: 'dk', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 101, ip: '192.0.2.156', env: 'prod', agent: 'ssh' }],
    services,
  }
  const cfg = parseConfig(raw).config
  assert.ok(cfg, parseConfig(raw).errors?.join('\n'))
  // UNCLEANED report: even if an agent still returned the label, nothing must read it
  const agents = { hosts: cfg.hosts, get: () => ({ ok: true, at: Date.now(), fast: { osId: 'debian', docker: { containers } }, slow: { versions: { app: '1.0.0' } } }) }
  const upstream = {
    github: async () => [{ tag: 'v1.1.0', body: '' }, { tag: 'v1.0.0', body: '' }], githubTags: async () => [], eol: async () => [], node: async () => [],
    errors: () => [], stats: () => ({}),
  }
  return createUpdates({ cfg, store: tmpStore('dash-l11-', t), agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
}

test('updates: a Docker container is never "auto", even with watchtower true in the report', async t => {
  // image without a readable registry reference: local component, without upstream call
  const u = bench(t, { containers: [container({ name: 'wt', image: '', watchtower: true }), container({ name: 'wt2', image: '', watchtower: 'true' })] })
  await u.refresh()
  const docker = u.view().components.filter(c => c.kind === 'docker')
  assert.equal(docker.length, 2)
  for (const c of docker) assert.equal(c.auto, false, c.id)
  assert.equal(u.view().counts.auto, 0)
})

test('updates: the generic "auto" of the config stays (displayed, not announced, counted apart)', async t => {
  const svc = auto => ({ id: 'app', name: 'App', group: 'g', host: 'dk', url: 'http://192.0.2.156:8080', version: { current: { from: 'agent', package: 'app' }, latest: { from: 'github', repo: 'o/app' }, ...(auto ? { auto: true } : {}) } })
  const on = bench(t, { services: [svc(true)] })
  await on.refresh()
  const c = on.view().components.find(x => x.id === 'svc:app')
  assert.deepEqual([c.auto, c.gap], [true, 'minor'])
  assert.equal(on.view().counts.auto, 1)
  assert.deepEqual(on.digestLines(), [], 'auto: never announced in the digest')
  const off = bench(t, { services: [svc(false)] })
  await off.refresh()
  assert.equal(off.view().components.find(x => x.id === 'svc:app').auto, false)
  assert.match(off.digestLines().join('\n'), /1 nouvelle version\n {2}App/)
})


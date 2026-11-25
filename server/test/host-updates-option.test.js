// Dev containers left out of the Updates page (host option updates.containers) and
// locally built images never in error. No network calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdates } from '../lib/updates/index.js'
import { parseConfig, loadConfig } from '../lib/config.js'
import { tmpStore } from './tmpdir.js'

const PVE = [{ id: 'prod', label: 'p', host: 'https://pve:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }]
const rawConfig = (hosts, extra = {}) => ({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], proxmox: PVE, hosts, services: [], gitea: { owner: 'x' }, ...extra,
})
const vm = (id, more = {}) => ({ id, name: id, kind: 'vm', pve: 'prod', vmid: id.length, ip: '10.0.0.1', env: 'dev', agent: 'ssh', ...more })

// agent report for a host: Debian 13, Node.js, apt, two containers (public image, local image)
const report = () => ({
  ok: true, at: Date.now(),
  fast: {
    osId: 'debian', osVersion: '13',
    docker: { containers: [
      { name: 'dev-pg', image: 'postgres:16-alpine', imageId: 'sha256:pg' },
      { name: 'emu', image: 'emu-img', imageId: 'sha256:emu' },
    ] },
  },
  slow: {
    versions: { nodejs: '22.1.0' },
    apt: { upgradable: 2, security: 0, held: 0, listsAt: Math.floor(Date.now() / 1000), packages: [] },
    images: [{ id: 'sha256:pg', digests: ['postgres@sha256:old'] }, { id: 'sha256:emu', digests: [] }],
  },
})

function setup(hosts, { upstream: over = {} } = {}) {
  const parsed = parseConfig(rawConfig(hosts))
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const calls = []
  const upstream = {
    remoteDigest: async ref => { calls.push(`digest ${ref.repo}`); return { digest: 'sha256:old' } },
    remoteTags: async ref => { calls.push(`tags ${ref.repo}`); return [{ tag: '16-alpine' }, { tag: '18-alpine' }] },
    github: async () => [], githubTags: async () => [], node: async () => [{ tag: 'v22.2.0', lts: 'Jod' }],
    eol: async product => (product === 'debian' ? [{ cycle: '13', eol: false }] : [{ cycle: '22', eol: false }]),
    errors: () => [], stats: () => ({}),
    ...over,
  }
  const agents = { hosts: parsed.config.hosts.filter(h => h.agent), get: () => report() }
  const updates = createUpdates({ cfg: parsed.config, store: tmpStore('dash-l18-'), agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  return { updates, calls, cfg: parsed.config }
}

const idsOf = (updates, host) => updates.view().components.filter(c => c.host === host).map(c => c.id).sort()

test('updates.containers false → no docker component for the host, OS, apt and runtimes remain', async () => {
  const { updates, calls } = setup([vm('devbox', { updates: { containers: false } }), vm('web')])
  await updates.refresh()
  assert.deepEqual(idsOf(updates, 'devbox'), ['apt:devbox', 'os:devbox', 'runtime:devbox/nodejs'])
  // the other host keeps its containers
  assert.deepEqual(idsOf(updates, 'web'), ['apt:web', 'docker:web/dev-pg', 'docker:web/emu', 'os:web', 'runtime:web/nodejs'])
  // no registry call for the containers of the excluded host (a single host probed)
  assert.deepEqual(calls.filter(c => c.startsWith('digest')), ['digest library/postgres'])
  // counters (menu badge, cockpit) and digest: the 16 → 18 major is counted only once (web)
  assert.equal(updates.counts().major, 1)
  assert.equal(updates.counts('dev').major, 1)
  const lines = updates.digestLines()
  assert.match(lines.join('\n'), /\n {2}dev-pg \(VM 3 · prod\) 16-alpine → 18-alpine/)
  assert.equal(lines.join('\n').match(/16-alpine → 18-alpine/g).length, 1, lines.join('\n'))
  assert.ok(!lines.join('\n').includes('VM 4 · prod) 16-alpine'), 'nothing from devbox (VM 4) on the container side')
})

test('without the option (or set to true), nothing changes', async () => {
  for (const opt of [undefined, { containers: true }, {}]) {
    const { updates } = setup([vm('devbox', opt ? { updates: opt } : {})])
    await updates.refresh()
    assert.deepEqual(idsOf(updates, 'devbox'), ['apt:devbox', 'docker:devbox/dev-pg', 'docker:devbox/emu', 'os:devbox', 'runtime:devbox/nodejs'], JSON.stringify(opt))
    const pg = updates.view().components.find(c => c.id === 'docker:devbox/dev-pg')
    assert.equal(pg.gap, 'major')
    assert.equal(pg.latest, '18-alpine')
    assert.equal(updates.view().components.find(c => c.id === 'docker:devbox/emu').local, true)
    assert.equal(updates.counts().major, 1)
  }
})

test('the schema rejects an invalid updates value', () => {
  for (const bad of [{ containers: 'no' }, { containers: 0 }, { containers: null }, { images: false }, false, 'off']) {
    const r = parseConfig(rawConfig([vm('devbox', { updates: bad })]))
    assert.ok(!r.config && r.errors?.length, `refused: ${JSON.stringify(bad)}`)
    assert.match(r.errors.join('\n'), /updates/)
  }
  assert.ok(parseConfig(rawConfig([vm('devbox', { updates: { containers: false } })])).config)
})

// --- locally built images: real upstream module, registries simulated by a fake fetch ---
// Docker Hub: 401 without a token (realm auth.docker.io), then the response set per repository once
// the token is presented; a nonexistent repository answers 401 even with the token, like the real Hub.
function registries(status) {
  const calls = []
  const fetch = async (url, opts = {}) => {
    url = String(url)
    const method = opts.method ?? 'GET'
    calls.push(`${method} ${url}`)
    const m = url.match(/^https:\/\/(registry-1\.docker\.io|ghcr\.io)\/v2\/(.+)\/manifests\/(.+)$/)
    if (m) {
      const realm = m[1] === 'ghcr.io' ? 'https://ghcr.io/token' : 'https://auth.docker.io/token'
      // like the real registry, every 401 carries the www-authenticate challenge (token missing,
      // expired or without rights on the repository)
      const challenge = { 'www-authenticate': `Bearer realm="${realm}",service="reg",scope="repository:${m[2]}:pull"` }
      if (!opts.headers?.Authorization) return new Response(null, { status: 401, headers: challenge })
      const st = status[`${m[1] === 'ghcr.io' ? 'ghcr.io' : 'docker.io'}/${m[2]}`] ?? 401
      if (st === 'down') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return new Response(null, { status: st, headers: st === 200 ? { 'docker-content-digest': 'sha256:old' } : st === 401 ? challenge : {} })
    }
    if (/^https:\/\/(auth\.docker\.io|ghcr\.io)\/token/.test(url)) return Response.json({ token: 'anon' })
    if (url.startsWith('https://hub.docker.com/v2/repositories/')) return Response.json({ results: [{ name: '16-alpine' }], next: null })
    return new Response('?', { status: 599 })
  }
  return { fetch, calls }
}

async function upstreamSetup(containers, { images = [], status = {} } = {}) {
  const { createUpstream } = await import('../lib/updates/upstream.js')
  const parsed = parseConfig(rawConfig([vm('docker-c')]))
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const store = tmpStore('dash-l18-up-')
  const reg = registries(status)
  const upstream = createUpstream({ store, env: {}, fetch: reg.fetch, log: { error() {} } })
  const slow = { versions: {}, images }
  const agents = {
    hosts: parsed.config.hosts,
    get: () => ({ ok: true, at: Date.now(), fast: { osId: 'alpine', docker: { containers } }, slow }),
  }
  const updates = createUpdates({ cfg: parsed.config, store, agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  const comp = id => updates.view().components.find(c => c.id === `docker:docker-c/${id}`)
  const cached = () => store.db.prepare("SELECT url FROM http_cache WHERE url LIKE 'digest:%'").all().map(r => r.url)
  return { updates, upstream, slow, reg, comp, cached, status }
}

const API = { name: 'appli-api-1', image: 'appli-api', imageId: 'sha256:rebuilt' }
const PG = { name: 'db', image: 'postgres:16-alpine', imageId: 'sha256:pg' }
const PG_IMG = { id: 'sha256:pg', digests: ['postgres@sha256:old'] }

test('local image just rebuilt (imageId unknown to the inventory) → local, no error and no cache', async () => {
  // the slow inventory only knows the old appli-api image
  const s = await upstreamSetup([API, PG], { images: [{ id: 'sha256:before', digests: [] }, PG_IMG], status: { 'docker.io/library/postgres': 200 } })
  await s.updates.refresh()
  const c = s.comp('appli-api-1')
  assert.equal(c.local, true)
  assert.equal(c.error, null)
  assert.equal(c.gap, null)
  assert.equal(c.current, 'latest')
  assert.equal(s.updates.view().counts.errors, 0)
  assert.deepEqual(s.upstream.errors(), [], 'no source error for docker.io')
  assert.equal(s.comp('db').gap, 'same', 'the neighbouring public image stays tracked')
  // the 401 is not cached: asked again on the next tick, still local
  assert.deepEqual(s.cached(), ['digest:docker.io/library/postgres:16-alpine'])
  const asked = () => s.reg.calls.filter(x => x.includes('/library/appli-api/manifests/')).length
  const before = asked()
  await s.updates.refresh()
  assert.ok(asked() > before, '401 asked again, not frozen')
  assert.equal(s.comp('appli-api-1').local, true)
  // next slow: the image is known, without a digest → local, no registry call
  s.slow.images = [{ id: 'sha256:rebuilt', digests: [] }, PG_IMG]
  const n = asked()
  await s.updates.refresh()
  assert.equal(s.comp('appli-api-1').local, true)
  assert.equal(asked(), n)
})

test('a 401 does not freeze an error (image known to the inventory, then registry reachable again)', async () => {
  // known public image with a digest: a 401 is still an error, as before…
  const s = await upstreamSetup([PG], { images: [PG_IMG], status: { 'docker.io/library/postgres': 401 } })
  await s.updates.refresh()
  assert.equal(s.comp('db').error, 'docker.io : HTTP 401')
  assert.equal(s.comp('db').local, false)
  assert.deepEqual(s.cached(), [], 'nothing cached')
  // …but is not served from the 6 h cache: the registry answers again → no more error
  s.status['docker.io/library/postgres'] = 200
  await s.updates.refresh()
  assert.equal(s.comp('db').error, null)
  assert.equal(s.comp('db').gap, 'same')
})

test('public image, registry in 5xx, 429 or unreachable → error as before, even before the inventory', async () => {
  for (const [st, msg] of [[503, 'docker.io : HTTP 503'], [500, 'docker.io : HTTP 500'], [429, 'docker.io : HTTP 429'], ['down', 'ECONNREFUSED']]) {
    for (const images of [[PG_IMG], []]) {
      const s = await upstreamSetup([PG], { images, status: { 'docker.io/library/postgres': st } })
      await s.updates.refresh()
      const c = s.comp('db')
      assert.equal(c.error, msg, `${st}, inventory ${images.length ? 'up to date' : 'late'}`)
      assert.equal(c.local, false)
      assert.equal(s.upstream.errors()[0]?.source, 'registre docker.io', 'source error, as before')
    }
  }
  // a local image just rebuilt, Hub down: error too (nothing is assumed)
  const s = await upstreamSetup([API], { status: { 'docker.io/library/appli-api': 503 } })
  await s.updates.refresh()
  assert.equal(s.comp('appli-api-1').error, 'docker.io : HTTP 503')
  assert.equal(s.comp('appli-api-1').local, false)
})

test('public image whose tag has disappeared → "tag missing from the registry", as before', async () => {
  for (const images of [[PG_IMG], []]) {
    const s = await upstreamSetup([PG], { images, status: { 'docker.io/library/postgres': 404 } })
    await s.updates.refresh()
    assert.equal(s.comp('db').error, 'tag 16-alpine absent du registre')
    assert.equal(s.comp('db').local, false)
  }
})

test('explicit registry (ghcr.io, docker.io/…) in 401 → error, even before the inventory', async () => {
  const s = await upstreamSetup([
    { name: 'ha', image: 'ghcr.io/acme/private:1.0', imageId: 'sha256:x' },
    { name: 'hub', image: 'docker.io/library/appli-api', imageId: 'sha256:y' },
    { name: 'user', image: 'example/appli-api:2', imageId: 'sha256:z' },
  ])
  await s.updates.refresh()
  assert.equal(s.comp('ha').error, 'ghcr.io : HTTP 401')
  assert.equal(s.comp('hub').error, 'docker.io : HTTP 401')
  // implicit docker.io (user namespace): local as long as the inventory does not know it
  assert.equal(s.comp('user').local, true)
  assert.equal(s.comp('user').error, null)
})

test('explicitRegistry follows parseImageRef', async () => {
  const { explicitRegistry } = await import('../lib/updates/upstream.js')
  for (const i of ['appli-api', 'postgres:16-alpine', 'example/app:1', 'library/redis@sha256:abc']) assert.equal(explicitRegistry(i), false, i)
  for (const i of ['ghcr.io/a/b', 'docker.io/library/x', 'localhost/app', 'localhost:5000/app:1.2', 'registry:5000/app']) assert.equal(explicitRegistry(i), true, i)
})

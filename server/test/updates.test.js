// Version comparison, releases, end of life, config decisions
// and a single announcement of each new version (no network call).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { versionGap, compareVersions, tagShape } from '../lib/version.js'
import { parseImageRef } from '../lib/updates/upstream.js'
import { createUpdates, fromReleases, eolInfo } from '../lib/updates/index.js'
import { openDb } from '../lib/db.js'
import { parseConfig } from '../lib/config.js'
import { tmpDir, tmpStore, trackStore } from './tmpdir.js'

test('version gap: semver, prefixes, Debian, calver, four components', () => {
  assert.equal(versionGap('1.26.1', 'v28.1.0'), 'major')
  assert.equal(versionGap('v6.4.2', 'v6.5'), 'minor')
  assert.equal(versionGap('1.6.15', 'v1.6.16'), 'patch')
  assert.equal(versionGap('22.23.2-1nodesource1', 'v22.23.3'), 'patch')
  assert.equal(versionGap('5:29.8.1-1~debian.13~trixie', '29.8.1'), 'same')
  assert.equal(versionGap('2026.10.1', '2026.10.2'), 'patch')
  assert.equal(versionGap('2026.9.3', '2027.1.0'), 'minor') // calver: never "major"
  assert.equal(versionGap('4.0.20.3014', '4.0.21.3020'), 'patch')
  assert.equal(versionGap('2.0.0', '1.9.9'), 'ahead')
  assert.equal(versionGap('stable', 'beta'), 'unknown')
  assert.equal(compareVersions('16-alpine', '18-alpine'), -1)
  assert.equal(tagShape('16-alpine'), tagShape('18-alpine'))
  assert.notEqual(tagShape('16-alpine'), tagShape('16.4-alpine'))
})

test('image reference: official Hub, ghcr, lscr → ghcr, default tag', () => {
  assert.deepEqual(parseImageRef('postgres:16-alpine'), { registry: 'docker.io', repo: 'library/postgres', tag: '16-alpine' })
  assert.deepEqual(parseImageRef('axllent/mailpit:v1.21'), { registry: 'docker.io', repo: 'axllent/mailpit', tag: 'v1.21' })
  assert.deepEqual(parseImageRef('lscr.io/linuxserver/sonarr'), { registry: 'ghcr.io', repo: 'linuxserver/sonarr', tag: 'latest' })
  assert.deepEqual(parseImageRef('localhost:5000/app:1.2@sha256:abc'), { registry: 'localhost:5000', repo: 'app', tag: '1.2' })
})

test('releases: latest stable, skipped versions, security, same major', () => {
  const rels = [
    { tag: 'v2.0.0-rc1', prerelease: true, body: '' },
    { tag: 'v1.3.0', body: '## Security\nFixes CVE-2026-1234 in auth', url: 'u130' },
    { tag: 'v1.2.1', body: 'BREAKING: config renamed' },
    { tag: 'v1.2.0', body: '' },
    { tag: 'v1.1.0', body: '' },
  ]
  const r = fromReleases(rels, '1.1.0')
  assert.equal(r.latest, 'v1.3.0')
  assert.equal(r.skipped, 3)
  assert.equal(r.breaking, 1)
  assert.equal(r.security, true)
  assert.equal(r.cve, 'CVE-2026-1234')
  // a security product that talks about "security headers" is not a fix
  assert.equal(fromReleases([{ tag: '1.1', body: 'new security headers plugin' }], '1.0').security, false)
  assert.equal(fromReleases(rels, '1.1.0', { tagPattern: '^v1\\.2' }).latest, 'v1.2.1')
})

test('end of life: past, near, unknown', () => {
  const now = Date.parse('2026-10-18')
  const cycles = [{ cycle: '8', eol: '2026-08-31' }, { cycle: '9', eol: '2026-12-01' }, { cycle: '10', eol: false }]
  assert.equal(eolInfo(cycles, '8', now).passed, true)
  assert.equal(eolInfo(cycles, '9', now).soon, true)
  assert.equal(eolInfo(cycles, '10', now).passed, false)
  assert.equal(eolInfo(cycles, '7', now), null)
})

function setup(extra = {}) {
  const raw = {
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }],
    hosts: [{ id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 1, ip: '10.0.0.1', env: 'prod', agent: 'ssh' }],
    services: [{ id: 'app', name: 'App', group: 'g', host: 'web', url: 'http://x', version: { current: { from: 'agent', package: 'app' }, latest: { from: 'github', repo: 'o/app' } } }],
    gitea: { owner: 'x' },
    ...extra,
  }
  raw.proxmox = [{ id: 'prod', label: 'p', host: 'https://pve:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }]
  const parsed = parseConfig(raw)
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const dir = tmpDir('dash-updates-')
  const store = trackStore(openDb(dir), dir)
  const releases = { list: [{ tag: 'v1.1.0', body: '' }, { tag: 'v1.0.0', body: '' }] }
  const upstream = {
    github: async () => releases.list, githubTags: async () => [], eol: async () => [], node: async () => [],
    errors: () => [], stats: () => ({}),
  }
  const installed = { app: '1.0.0' }
  const agents = {
    hosts: parsed.config.hosts.filter(h => h.agent),
    get: () => ({ ok: true, at: Date.now(), fast: { osId: 'alpine', docker: null }, slow: { versions: installed } }),
  }
  const sources = { pveVersions: async () => [] }
  const updates = createUpdates({ cfg: parsed.config, store, agents, sources, collector: { snap: {} }, upstream, log: { error() {} } })
  return { updates, releases, installed }
}

test('each new version is announced only once in the digest', async () => {
  const { updates, releases } = setup()
  await updates.refresh()
  const c = updates.view().components.find(x => x.id === 'svc:app')
  assert.equal(c.gap, 'minor')
  assert.equal(c.latest, '1.1.0', 'same prefix convention as the installed version')
  assert.match(updates.digestLines({ mark: true }).join('\n'), /^🆕 1 nouvelle version\n {2}App .* 1\.0\.0 → 1\.1\.0/)
  assert.equal(updates.digestLines().length, 0, 'already announced')
  await updates.refresh()
  assert.equal(updates.digestLines().length, 0, 'still announced only once')
  releases.list.unshift({ tag: 'v1.2.0', body: 'security fix for CVE-2026-9999' })
  await updates.refresh()
  assert.match(updates.digestLines({ mark: true })[1], /→ 1\.2\.0/)
  const sig = updates.signals()
  assert.deepEqual(sig.map(s => s.key), ['security_release:svc:app@1.2.0'])
  assert.equal(sig[0].noRepeat, true)
})

test('installed security version: signal cleared right away (resolution notified)', async () => {
  const { updates, releases, installed } = setup()
  releases.list.unshift({ tag: 'v1.2.0', body: 'security fix for CVE-2026-9999' })
  await updates.refresh()
  assert.equal(updates.signals().find(s => s.key === 'security_release:svc:app@1.2.0').cond, true)
  installed.app = '1.2.0'
  await updates.refresh()
  const sig = updates.signals().find(s => s.key === 'security_release:svc:app@1.2.0')
  assert.equal(sig?.cond, false)
})

test('ignore a version, postpone, pin a major', async () => {
  const ignore = (rule) => setup({ updates: { ignore: [rule] } })
  let { updates } = ignore({ id: 'svc:app', version: 'v1.1.0', reason: 'attendre la 1.2' })
  await updates.refresh()
  let c = updates.view().components.find(x => x.id === 'svc:app')
  assert.equal(c.ignored.reason, 'attendre la 1.2')
  assert.equal(updates.digestLines().length, 0)
  assert.equal(updates.counts().ignored, 1)

  ;({ updates } = ignore({ id: 'svc:*', until: '2000-01-01' })) // expired postponement: no effect
  await updates.refresh()
  assert.equal(updates.view().components.find(x => x.id === 'svc:app').ignored, undefined)

  const s = setup({ updates: { ignore: [{ id: 'svc:app', pin: 'major' }] } })
  s.releases.list.unshift({ tag: 'v2.0.0', body: '' })
  await s.updates.refresh()
  c = s.updates.view().components.find(x => x.id === 'svc:app')
  assert.equal(c.latest, '1.1.0', 'pinned on 1.x')
  assert.equal(c.gap, 'minor')
  assert.equal(c.pinned.hidden, '2.0.0')
})

test('config: version read by the agent on a host without an agent → refused', () => {
  const r = parseConfig({
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }],
    hosts: [{ id: 'h', name: 'h', kind: 'appliance', env: 'prod' }],
    services: [{ id: 's', name: 'S', group: 'g', host: 'h', url: 'http://x', version: { current: { from: 'agent', package: 'x' } } }],
    gitea: { owner: 'x' },
  })
  assert.match(r.errors.join('\n'), /has no agent/)
})

test('pinned on its major: a new image of the floating tag stays reported', async () => {
  const raw = {
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'prod', label: 'p', host: 'https://pve:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
    hosts: [{ id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 1, ip: '10.0.0.1', env: 'prod', agent: 'ssh' }],
    services: [], gitea: { owner: 'x' },
    updates: { ignore: [{ id: 'docker:web/db', pin: 'major', reason: 'reste en 16' }] },
  }
  const parsed = parseConfig(raw)
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const store = tmpStore('dash-updates-')
  const remote = { digest: 'sha256:old' }
  const upstream = {
    remoteDigest: async () => remote,
    remoteTags: async () => [{ tag: '16-alpine' }, { tag: '17-alpine' }, { tag: '18-alpine' }],
    github: async () => [], githubTags: async () => [], eol: async () => [], node: async () => [],
    errors: () => [], stats: () => ({}),
  }
  const agents = {
    hosts: parsed.config.hosts,
    get: () => ({
      ok: true, at: Date.now(),
      fast: { osId: 'alpine', docker: { containers: [{ name: 'db', image: 'postgres:16-alpine', imageId: 'sha256:img' }] } },
      slow: { images: [{ id: 'sha256:img', digests: ['postgres@sha256:old'] }], versions: {} },
    }),
  }
  const updates = createUpdates({ cfg: parsed.config, store, agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  await updates.refresh()
  let c = updates.view().components.find(x => x.id === 'docker:web/db')
  assert.equal(c.gap, 'same', '18 hidden by the pin')
  assert.equal(c.pinned.hidden, '18-alpine')
  remote.digest = 'sha256:new' // new build of 16
  await updates.refresh()
  c = updates.view().components.find(x => x.id === 'docker:web/db')
  assert.equal(c.gap, 'digest')
  assert.match(c.detail, /nouvelle image/)
})

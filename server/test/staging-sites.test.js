// Two staging sites (docker-b, dev host) monitored like their prod. TEST config
// validated by the schema (no longer the prod config.json), same shape as the prod; real
// createMonitor (probe ids and TLS agent) and real createRules, FAKE probe results: a staging
// that is down fires service_down as a warning (dev host), like appli-staging.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../lib/config.js'
import { createMonitor } from '../lib/monitor.js'
import { createRules } from '../lib/alerts/rules.js'
import { checkAgent } from '../lib/checks.js'
import { tlsCategory } from '../lib/tls.js'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const site = (id, host, url, body, extra = {}) => ({ id, name: id, group: 'sites', host, url, checks: [{ type: 'http', url, expect: { status: 200, body } }], ...extra })
const repo = () => {
  const p = parseConfig({
    version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'sites', name: 'Sites' }],
    proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }, { id: 'dev', label: 'Dev', host: 'http://192.0.2.168:8006', env: 'PVE' }],
    hosts: [
      { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', env: 'dev' },
      { id: 'docker-b', name: 'docker-b', kind: 'vm', pve: 'dev', vmid: 102, ip: '192.0.2.146', parent: 'pve-b', env: 'dev' },
      { id: 'docker-c', name: 'docker-c', kind: 'vm', pve: 'dev', vmid: 103, ip: '192.0.2.147', parent: 'pve-b', env: 'dev' },
      { id: 'hebergeur', name: 'hébergeur', kind: 'external', env: 'prod' },
    ],
    services: [
      site('site-a-prod', 'hebergeur', 'https://site-a.example.net', 'Site A'),
      site('site-b-prod', 'hebergeur', 'https://site-b.example.net', 'Site B'),
      site('site-a-staging', 'docker-b', 'https://site-a.vigie.example.net', 'Site A', { container: 'site-a-php' }),
      site('site-b-staging', 'docker-b', 'https://site-b.vigie.example.net', 'Site B', { container: 'site-b-php' }),
      site('appli-staging', 'docker-c', 'https://appli.vigie.example.net', 'Appli'),
    ],
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}

test('staging probes: one http probe per site (no tls), prod keyword, host name with the strict agent', () => {
  const cfg = repo()
  const svc = id => cfg.services.find(s => s.id === id)
  for (const [id, prodId] of [['site-a-staging', 'site-a-prod'], ['site-b-staging', 'site-b-prod']]) {
    const [c] = svc(id).checks
    assert.equal(svc(id).checks.length, 1)
    assert.deepEqual([c.type, c.expect], ['http', { status: 200, body: svc(prodId).checks[0].expect.body }])
    // host name: strict agent (Node CA store), no tls exception
    assert.equal(c.tls, undefined)
    assert.equal(tlsCategory(c.url, { tls: c.tls }), 'strict')
  }
  const monitor = createMonitor(cfg)
  const ids = monitor.checks.filter(c => c.serviceId.endsWith('-staging') && c.serviceId !== 'appli-staging')
  assert.deepEqual(ids.map(c => c.id), ['site-a-staging#0', 'site-b-staging#0'])
  assert.ok(ids.every(c => checkAgent(c) === checkAgent({ url: 'https://example.net' })))
})

test('service_down of a staging (docker-b, dev): warning like appli-staging; the prod of the same site stays critical', () => {
  const cfg = repo()
  const real = createMonitor(cfg)
  const down = new Set(['site-a-staging', 'site-b-staging', 'appli-staging', 'site-a-prod'])
  const monitor = {
    checks: real.checks,
    result: id => {
      const c = real.checks.find(x => x.id === id)
      return down.has(c.serviceId)
        ? { state: 'crit', fails: cfg.alerts.failAfter, oks: 0, code: 500 }
        : { state: 'ok', fails: 0, oks: cfg.alerts.recoverAfter }
    },
  }
  const out = createRules(cfg, monitor).evaluate({}, NOW)
  const s = key => out.find(x => x.key === key)
  for (const id of ['site-a-staging', 'site-b-staging', 'appli-staging']) {
    const x = s(`service_down:${id}`)
    assert.deepEqual([x.cond, x.severity, x.env, x.hostId], [true, 'warning', 'dev', id === 'appli-staging' ? 'docker-c' : 'docker-b'], id)
  }
  assert.equal(s('service_down:site-a-staging').detail, 'site-a.vigie.example.net : HTTP 500')
  assert.ok(s('service_down:site-a-staging').parents.includes('guest_stopped:docker-b'))
  assert.ok(s('service_down:site-a-staging').parents.includes('pve_unreachable:dev'))
  assert.deepEqual([s('service_down:site-a-prod').cond, s('service_down:site-a-prod').severity], [true, 'critical'])
  assert.equal(s('service_down:site-b-prod').cond, false)
})

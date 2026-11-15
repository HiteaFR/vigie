// A maintenance window only suppresses the
// alerts it targets (criteria under match). Real engine, signals driven by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../lib/config.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { tmpStore } from './tmpdir.js'

const T = Date.parse('2026-10-27T10:00:00Z') // 11:00 in Paris
const DANS = { start: '10:00', end: '12:00' }
const HORS = { start: '22:00', end: '23:00' }

const raw = maintenance => ({
  version: 2, title: 't', proxmox: [], gitea: { owner: 'o' }, groups: [{ id: 'g', name: 'G' }],
  hosts: [
    { id: 'nas', name: 'NAS', kind: 'appliance', env: 'prod', ip: '192.0.2.9' },
    { id: 'forge', name: 'Forge', kind: 'appliance', env: 'prod', ip: '192.0.2.10' },
  ],
  services: [
    { id: 'plex', name: 'Plex', group: 'g', host: 'nas', url: 'http://192.0.2.9:32400' },
    { id: 'gitea', name: 'Gitea', group: 'g', host: 'forge', url: 'http://192.0.2.10:3000' },
  ],
  maintenance,
})

// signals: a service of nas, a service of forge, a stopped guest of nas
const SIGS = [
  { key: 'service_down:plex', rule: 'service_down', entity: 'plex', hostId: 'nas' },
  { key: 'service_down:gitea', rule: 'service_down', entity: 'gitea', hostId: 'forge' },
  { key: 'guest_stopped:nas', rule: 'guest_stopped', entity: 'nas', hostId: 'nas' },
]
function run(maintenance) {
  const { config: cfg, errors } = parseConfig(raw(maintenance))
  assert.ok(!errors, errors?.join('\n'))
  const sent = []
  const notifier = { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }
  const rules = { evaluate: () => SIGS.map(s => ({ ...s, title: s.key, env: 'prod', severity: 'warning', parents: [], cond: true, noRepeat: true })), impacted: () => ({}) }
  const engine = createEngine({ cfg, store: tmpStore('dash-maint-'), rules, notifier, clock: createClock('Europe/Paris'), startedAt: T - 3600_000 })
  engine.evaluate({}, T)
  const masked = engine.active().filter(a => a.suppressed).map(a => a.key).sort()
  return { sent: sent.sort(), masked }
}

test('match host nas: the nas service suppressed; service_down:gitea (other host) notified', () => {
  const r = run([{ ...DANS, match: { host: 'nas' }, reason: 'disques' }])
  assert.deepEqual(r.masked, ['guest_stopped:nas', 'service_down:plex'])
  assert.deepEqual(r.sent, ['open:service_down:gitea'])
})

test('match service gitea: only service_down:gitea suppressed', () => {
  const r = run([{ ...DANS, match: { service: 'gitea' } }])
  assert.deepEqual(r.masked, ['service_down:gitea'])
  assert.deepEqual(r.sent, ['open:guest_stopped:nas', 'open:service_down:plex'])
})

test('match host nas and rule service_down: guest_stopped of nas is not suppressed', () => {
  const r = run([{ ...DANS, match: { host: 'nas', rule: 'service_down' } }])
  assert.deepEqual(r.masked, ['service_down:plex'])
  assert.deepEqual(r.sent, ['open:guest_stopped:nas', 'open:service_down:gitea'])
})

test('outside the window: nothing is suppressed', () => {
  const r = run([{ ...HORS, match: { host: 'nas' } }])
  assert.deepEqual(r.masked, [])
  assert.equal(r.sent.length, 3)
})

test('config: match on unknown host or service → rejected', () => {
  const host = parseConfig(raw([{ ...DANS, match: { host: 'fantome' } }]))
  assert.match((host.errors ?? []).join('\n'), /maintenance\[0\]: unknown host "fantome"/)
  const svc = parseConfig(raw([{ ...DANS, match: { service: 'fantome' } }]))
  assert.match((svc.errors ?? []).join('\n'), /maintenance\[0\]: unknown service "fantome"/)
  assert.ok(!parseConfig(raw([{ ...DANS, match: { host: 'nas', service: 'plex' } }])).errors)
})

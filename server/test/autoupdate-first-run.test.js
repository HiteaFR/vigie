// autoupdate_failed "no run recorded" on a freshly equipped host. Nothing shown
// (cond null, no visible pending state) as long as auto updates have been seen active for less
// than autoUpdateMaxAgeHours; then fires without waiting. First-seen date: real agent memory
// (kv of a real test database), reread at restart, cleared when the host is no longer active.
// Real createRules and real engine; FAKE agents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createAgentMemory, AUTO_KEY } from '../lib/agentmemory.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const MIN = 60_000
const T0 = Date.parse('2026-11-02T09:30:00Z') // wave 2 rollout, after the 06:00 run
const CFG = parseConfig({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'PVE', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve.pem' }],
  hosts: [
    { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
    { id: 'p1', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, ip: '192.0.2.158', parent: 'pve', env: 'prod', agent: 'ssh' },
    { id: 'p2', name: 'gitea', kind: 'lxc', pve: 'prod', vmid: 106, ip: '192.0.2.143', parent: 'pve', env: 'prod', agent: 'ssh' },
  ],
}).config
const AU = { installed: true, enabled: true, securityOnly: true, lastRunAt: null, lastResult: null, applied: [] }
// cleaned slow report (cleanSlow) produced at t
const slowOf = (t, au = {}, version = 7) => cleanSlow({
  version, ts: Math.floor(t / 1000),
  apt: { listsAt: Math.floor(t / 1000), upgradable: 0, security: 0, packages: [] },
  ...(version >= 7 ? { autoUpdate: { ...AU, ...au } } : {}),
})
const fast = { fs: [], docker: null, reboot: { required: false }, systemd: null }
// agent state: fast report fresh at now, slow report produced on each full hour (slowAt);
// au and version depend on slowAt (the content only changes with a new report)
const hourOf = now => now - (now % H)
const stateAt = (now, au, version) => ({ ok: true, at: now - 30_000, fast, slow: slowOf(hourOf(now), au, version), slowAt: hourOf(now) })

// bench: real database (kv), real memory, real engine; au(t) gives the autoUpdate block of p1 in
// the slow report produced at t (full hour)
function bench(t, { store = tmpStore('dash-l16-', t), au = () => ({}), version = () => 7, start = T0 } = {}) {
  const sent = []
  let now = start
  let next = start
  const agents = {
    hosts: CFG.hosts.filter(h => h.agent),
    get: id => (id === 'p1' ? stateAt(now, au(hourOf(now)), version(hourOf(now))) : stateAt(now, { lastRunAt: Math.floor((now - H) / 1000), lastResult: 'success' }, 8)),
  }
  const memory = createAgentMemory({ db: store.db, kv: store.kv, hostIds: CFG.hosts.filter(h => h.agent).map(h => h.id) })
  const rules = createRules(CFG, { checks: [], result: () => null }, agents, null, null, null, memory)
  const engine = createEngine({ cfg: CFG, store, rules, notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: start - 3 * H })
  // like index.js, memory then engine, at each step (15 min here); the clock stays on the
  // last pass played (≤ until)
  const advance = until => {
    for (; next <= until; next += 15 * MIN) {
      now = next
      memory.observe(agents, now)
      engine.evaluate({}, now)
    }
  }
  const sig = () => rules.evaluate({}, now).find(s => s.key === 'autoupdate_failed:p1')
  const visible = () => engine.active().some(a => a.key === 'autoupdate_failed:p1')
  return { store, memory, engine, sent, advance, sig, visible, get now() { return now } }
}

test('freshly equipped host, never run: nothing shown for 48 h (cond null, no pending alert), then fires without waiting and is notified once', t => {
  const b = bench(t)
  for (const h of [0, 1, 12, 24, 47.75]) {
    b.advance(T0 + h * H)
    assert.equal(b.visible(), false, `${h} h: nothing shown`)
    assert.deepEqual([b.sig().cond, b.sig().detail], [null, null], `${h} h`)
  }
  assert.equal(b.memory.autoActiveSince('p1'), T0)
  assert.deepEqual(b.sent, [])
  b.advance(T0 + 48 * H)
  const s = b.sig()
  assert.deepEqual([s.cond, s.forSec, s.detail, s.severity], [true, undefined, 'aucun passage enregistré', 'warning'])
  assert.deepEqual(b.sent, ['open:autoupdate_failed:p1'])
  // at the latest autoUpdateMaxAgeHours after first seen (plus one collection cycle)
  assert.ok(b.engine.get('autoupdate_failed:p1').firedAt <= T0 + 48 * H + 15 * MIN)
  // the other hosts (already run): nothing
  assert.equal(b.engine.active().some(a => a.key === 'autoupdate_failed:p2'), false)
})

test('a lastRunAt that appears settles it: during the delay → cond false, nothing; after firing → resolved', t => {
  // first run the next morning (06:00, 20 h 30 after the rollout)
  const ran = T0 + 20.5 * H
  const b = bench(t, { au: now => (now >= ran ? { lastRunAt: Math.floor(ran / 1000), lastResult: 'success' } : {}) })
  b.advance(T0 + 60 * H)
  assert.equal(b.sig().cond, false)
  assert.deepEqual(b.sent, [])
  // fired then late run: resolved
  const late = T0 + 50 * H
  const c = bench(t, { au: now => (now >= late ? { lastRunAt: Math.floor(late / 1000), lastResult: 'success' } : {}) })
  c.advance(T0 + 49 * H)
  assert.deepEqual(c.sent, ['open:autoupdate_failed:p1'])
  c.advance(T0 + 52 * H)
  assert.equal(c.sig().cond, false)
  assert.deepEqual(c.sent, ['open:autoupdate_failed:p1', 'resolve:autoupdate_failed:p1'])
})

test('first-seen date persisted (kv): a restart does not reset the delay; corrupted value or host removed from the config: ignored, purged', t => {
  const store = tmpStore('dash-l16-', t)
  const a = bench(t, { store })
  a.advance(T0 + 30 * H)
  assert.deepEqual(JSON.parse(store.kv.get(AUTO_KEY)), { p1: T0, p2: T0 })
  // dashboard restart at T0 + 30 h: new memory, new engine, same database
  const b = bench(t, { store, start: T0 + 30.25 * H })
  assert.equal(b.memory.autoActiveSince('p1'), T0, 'read back from the kv before any report')
  b.advance(T0 + 47.75 * H)
  assert.deepEqual([b.sig().cond, b.visible()], [null, false])
  b.advance(T0 + 48 * H)
  assert.equal(b.memory.autoActiveSince('p1'), T0)
  assert.equal(b.sig().cond, true, 'fires at T0 + 48 h, not at restart + 48 h')
  // corrupted kv or invalid values: ignored without error
  const s2 = tmpStore('dash-l16-', t)
  s2.kv.set(AUTO_KEY, '{pas du json')
  assert.equal(createAgentMemory({ db: s2.db, kv: s2.kv, hostIds: ['p1'] }).autoActiveSince('p1'), null)
  s2.kv.set(AUTO_KEY, JSON.stringify({ p1: 'hier', p2: T0, retire: T0 }))
  const m = createAgentMemory({ db: s2.db, kv: s2.kv, hostIds: ['p1', 'p2'] })
  assert.deepEqual([m.autoActiveSince('p1'), m.autoActiveSince('p2'), m.autoActiveSince('retire')], [null, T0, null])
  assert.deepEqual(JSON.parse(s2.kv.get(AUTO_KEY)), { p2: T0 }, 'removed host purged')
})

test('first-seen date reset: auto updates turned off, not limited to security, or agent back to v6 → date cleared; re-enabled → new full delay', t => {
  for (const [name, off] of [
    ['turned off', { au: { enabled: false } }],
    ['not limited to security', { au: { securityOnly: false } }],
    ['uninstalled', { au: { installed: false } }],
    ['agent v6', { version: 6 }],
  ]) {
    // full hours (slow reports): 20:00 then 06:00
    const OFF = T0 + 10.5 * H
    const ON = T0 + 20.5 * H
    const offNow = now => now >= OFF && now < ON
    const b = bench(t, { au: now => (offNow(now) ? off.au ?? {} : {}), version: now => (offNow(now) ? off.version ?? 7 : 7) })
    b.advance(T0 + 12.5 * H)
    assert.equal(b.memory.autoActiveSince('p1'), null, `${name}: cleared`)
    assert.equal(JSON.parse(b.store.kv.get(AUTO_KEY)).p1, undefined, `${name}: cleared from the kv`)
    b.advance(T0 + 21.5 * H)
    assert.equal(b.memory.autoActiveSince('p1'), ON, `${name}: restarts from the re-enabling`)
    // T0 + 48 h would be exceeded with the old date: still nothing
    b.advance(ON + 47.75 * H)
    assert.equal(b.visible(), false, `${name}: nothing before ON + 48 h`)
    // (turning off auto updates fires autoupdate_off, out of scope here)
    const failedSent = () => b.sent.filter(x => x.endsWith(':autoupdate_failed:p1'))
    assert.deepEqual(failedSent(), [], name)
    b.advance(ON + 48 * H)
    assert.deepEqual(failedSent(), ['open:autoupdate_failed:p1'], name)
  }
})

test('the other cases do not change: failure or last run too old → fires right away, even on a recently seen host; v7 is enough', t => {
  const b = bench(t, { au: () => ({ lastRunAt: Math.floor((T0 - 49 * H) / 1000), lastResult: 'success' }) })
  b.advance(T0)
  assert.equal(b.memory.autoActiveSince('p1'), T0)
  assert.deepEqual([b.sig().cond, b.sig().forSec ?? 0], [true, 0])
  assert.deepEqual(b.sent, ['open:autoupdate_failed:p1'])
  const c = bench(t, { au: () => ({ lastRunAt: Math.floor((T0 - H) / 1000), lastResult: 'failed' }) })
  c.advance(T0)
  assert.deepEqual([c.sig().cond, c.sig().detail], [true, 'dernier passage en échec'])
  // without agent memory (alerts-preview simulation): never run → no information
  const st = stateAt(T0, {}, 7)
  const s = createRules(CFG, { checks: [], result: () => null }, { hosts: CFG.hosts.filter(h => h.agent), get: () => st }, null).evaluate({}, T0)
  assert.equal(s.find(x => x.key === 'autoupdate_failed:p1').cond, null)
})

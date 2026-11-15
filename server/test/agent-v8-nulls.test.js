// The three "null" values of the fixed v8 agent (infra 13b26aa): when information is missing,
// the agent sends null, never a default value. restart null (processes unreadable),
// posture.ssh null (sshd -T failed), posture.firewall null (nft or ufw present but unreadable):
// unknown, so no badge, no memory, no alert, and an ongoing alert is not force-resolved.
// Unchanged: firewall { type: 'none', active: false } when no tool exists (a real gap).
// Fake data; real database and real engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { createAgentMemory, postureOf } from '../lib/agentmemory.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const T0 = Date.parse('2026-11-03T08:00:00Z')
const CFG = parseConfig({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [{ id: 'prod', label: 'p', host: 'https://192.0.2.155:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
  hosts: [{ id: 'p1', name: 'mailpit', kind: 'lxc', pve: 'prod', vmid: 235, ip: '192.0.2.146', env: 'prod', agent: 'ssh' }],
}).config
const STD = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const slow = (t, over) => cleanSlow({ version: 8, ts: Math.floor(t / 1000), posture: STD, restart: { units: ['cron.service'], processes: 2 }, listening: [], ...over })
const live = (s, t) => ({ ok: true, at: t, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow: s, slowAt: t })

test('null values: allowlist — restart null, ssh null, firewall null stay null (never a default value)', () => {
  const s = slow(T0, { restart: null, posture: { ssh: null, firewall: null } })
  assert.equal(s.restart, null)
  assert.deepEqual(s.posture, { ssh: null, firewall: null })
  assert.deepEqual(slow(T0, { posture: { ssh: STD.ssh, firewall: null } }).posture, { ssh: STD.ssh, firewall: null })
  assert.deepEqual(postureOf({ ssh: STD.ssh, firewall: null }), { ssh_root: true, ssh_password: true, firewall: null })
  assert.deepEqual(postureOf({ ssh: null, firewall: STD.firewall }), { ssh_root: null, ssh_password: null, firewall: true })
  // no tool: real information (gap), distinct from null
  assert.equal(postureOf({ ssh: STD.ssh, firewall: { type: 'none', active: false } }).firewall, false)
})

test('null values: restart null → restart_required without information (cond null); an ongoing alert is NOT force-resolved', t => {
  const store = tmpStore('dash-l12-null-', t)
  const states = { p1: live(slow(T0), T0) }
  const agents = { hosts: CFG.hosts, get: id => states[id] }
  const sent = []
  const engine = createEngine({ cfg: CFG, store, rules: createRules(CFG, { checks: [], result: () => null }, agents), notifier: { enqueue: (k, st) => { sent.push(`${k}:${st.key}`); return 'digest' } }, clock: createClock('Europe/Paris'), startedAt: T0 - 3 * H })
  engine.evaluate({}, T0)
  engine.evaluate({}, T0 + 1000)
  assert.ok(engine.active().some(a => a.key === 'restart_required:p1' && a.state === 'firing'))
  // next report: processes unreadable → restart null
  for (const dt of [H, 2 * H, 3 * H]) {
    states.p1 = live(slow(T0 + dt, { restart: null }), T0 + dt)
    const sig = createRules(CFG, { checks: [], result: () => null }, agents).evaluate({}, T0 + dt).find(x => x.key === 'restart_required:p1')
    assert.deepEqual([sig.cond, sig.detail], [null, null])
    engine.evaluate({}, T0 + dt)
  }
  assert.ok(engine.active().some(a => a.key === 'restart_required:p1' && a.state === 'firing'), 'still firing')
  assert.ok(!sent.some(x => x.startsWith('resolve:')), 'no forced resolution')
})

test('null values: ssh null or firewall null → unknown criterion: no badge, no memory, no alert, even after being seen compliant', t => {
  const store = tmpStore('dash-l12-null-', t)
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['p1'] })
  const states = {}
  const agents = { hosts: CFG.hosts, get: id => states[id] }
  const rules = () => createRules(CFG, { checks: [], result: () => null }, agents, null, null, null, mem)
  const reg = now => rules().evaluate({}, now).find(x => x.key === 'posture_regression:p1')
  // never seen: ssh and firewall unreadable from the first v8 report
  states.p1 = live(slow(T0, { posture: { ssh: null, firewall: null } }), T0)
  mem.observe(agents, T0)
  for (const c of ['ssh_root', 'ssh_password', 'firewall']) assert.equal(mem.postureRow('p1', c), null, c)
  assert.deepEqual(Object.values(mem.postureView('p1', states.p1.slow.posture)).map(v => v.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(reg(T0).cond, false)
  // seen compliant, then unreadable: the memory does not move, and nothing fires
  states.p1 = live(slow(T0 + H), T0 + H)
  mem.observe(agents, T0 + H)
  const before = ['ssh_root', 'ssh_password', 'firewall'].map(c => mem.postureRow('p1', c).last_ok)
  states.p1 = live(slow(T0 + 2 * H, { posture: { ssh: null, firewall: null } }), T0 + 2 * H)
  mem.observe(agents, T0 + 2 * H)
  assert.deepEqual(['ssh_root', 'ssh_password', 'firewall'].map(c => mem.postureRow('p1', c).last_ok), before)
  assert.deepEqual([reg(T0 + 2 * H).cond, reg(T0 + 2 * H).detail], [false, null])
  // only firewall unreadable, SSH in gap (seen compliant): only the SSH regression counts
  states.p1 = live(slow(T0 + 3 * H, { posture: { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: true }, firewall: null } }), T0 + 3 * H)
  mem.observe(agents, T0 + 3 * H)
  const r = reg(T0 + 3 * H)
  assert.deepEqual([r.cond, r.detail], [true, 'mot de passe SSH accepté (conforme jusqu\'au 03/11)'])
  assert.equal(mem.postureView('p1', states.p1.slow.posture).firewall.state, 'unknown')
  // accepting an unknown criterion: refused
  assert.throws(() => mem.accept('p1', 'firewall', 'motif valable', 'admin', states.p1.slow.posture), e => e.status === 409 && /inconnu/.test(e.message))
  // no tool (none/false): gap shown, distinct from unknown
  states.p1 = live(slow(T0 + 4 * H, { posture: { ssh: STD.ssh, firewall: { type: 'none', active: false } } }), T0 + 4 * H)
  mem.observe(agents, T0 + 4 * H)
  assert.equal(mem.postureView('p1', states.p1.slow.posture).firewall.state, 'gap')
})

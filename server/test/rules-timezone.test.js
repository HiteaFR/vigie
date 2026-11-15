// The short date of posture_regression ("compliant until 03/11") follows alerts.timezone,
// and no longer Europe/Paris hardcoded in rules.js. Instant chosen near midnight: 2026-11-04
// 02:00 UTC, i.e. 04/11 in Paris and in UTC, but still 03/11 in New York.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../lib/config.js'
import { createRules } from '../lib/alerts/rules.js'
import { cleanSlow } from '../lib/agents.js'
import { createAgentMemory } from '../lib/agentmemory.js'
import { tmpStore } from './tmpdir.js'

const LAST_OK = Date.parse('2026-11-04T02:00:00Z')
const LATER = LAST_OK + 2 * 86400_000
const STD = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: false }, firewall: { type: 'nftables', active: true } }
const GAP = { ssh: { permitRootLogin: 'prohibit-password', passwordAuth: true }, firewall: { type: 'nftables', active: true } }

const cfgFor = alerts => parseConfig({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' }, proxmox: [],
  hosts: [{ id: 'p1', name: 'h1', kind: 'appliance', ip: '192.0.2.10', env: 'prod', agent: 'ssh' }],
  ...(alerts ? { alerts } : {}),
}).config

function detailWith(t, cfg) {
  const store = tmpStore('dash-rules-tz-', t)
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['p1'] })
  const states = {}
  const agents = { hosts: cfg.hosts, get: id => states[id] ?? { ok: null } }
  const report = (at, posture) => {
    const slow = cleanSlow({ version: 8, ts: Math.floor(at / 1000), posture, listening: [] })
    states.p1 = { ok: true, at, fast: { fs: [], docker: null, reboot: { required: false }, systemd: null }, slow, slowAt: at }
    mem.observe(agents, at)
  }
  report(LAST_OK, STD)
  report(LATER, GAP)
  const sig = createRules(cfg, { checks: [], result: () => null }, agents, null, null, null, mem)
    .evaluate({}, LATER + 1000).find(x => x.key === 'posture_regression:p1')
  return sig.detail
}

test('timezone: posture_regression dates the last compliant state in alerts.timezone', t => {
  assert.equal(cfgFor().alerts.timezone, 'Europe/Paris', 'schema default unchanged')
  assert.equal(detailWith(t, cfgFor()), "mot de passe SSH accepté (conforme jusqu'au 04/11)")
  assert.equal(detailWith(t, cfgFor({ timezone: 'America/New_York' })), "mot de passe SSH accepté (conforme jusqu'au 03/11)")
})

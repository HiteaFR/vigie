// Monitoring of automatic security updates (unattended-upgrades). The OS patches,
// the agent monitors: autoUpdate block of the v7 slow report. Dummy data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSlow, cleanAutoUpdate, AU_APPLIED_MAX } from '../lib/agents.js'

const AU = { installed: true, enabled: true, securityOnly: true, lastRunAt: 1_800_000_000, lastResult: 'success', applied: [{ name: 'openssl', version: '3.0.17-1~deb12u3' }] }

test('nominal autoUpdate in v7, field by field', () => {
  const out = cleanSlow({ version: 7, ts: 1, autoUpdate: AU })
  assert.equal(out.version, 7)
  assert.deepEqual(out.autoUpdate, AU)
  assert.deepEqual(cleanSlow({ version: 7, autoUpdate: { ...AU, lastResult: 'failed', lastRunAt: null } }).autoUpdate.lastResult, 'failed')
})

test('v6 or missing → null (unknown), even if a block is present; apt missing (null) → null', () => {
  assert.equal(cleanSlow({ version: 6, autoUpdate: AU }).autoUpdate, null)
  assert.equal(cleanSlow({ autoUpdate: AU }).autoUpdate, null)
  assert.equal(cleanSlow({ version: '7x', autoUpdate: AU }).autoUpdate, null)
  assert.equal(cleanSlow({ version: 7 }).autoUpdate, null)
  assert.equal(cleanSlow({ version: 7, autoUpdate: null }).autoUpdate, null)
  for (const bad of ['oui', 1, true, [AU]]) assert.equal(cleanAutoUpdate(bad), null, JSON.stringify(bad))
})

test('rejection — unknown field, non-strict boolean, unknown result, control character, list too long', () => {
  // unknown field: absent from the output (including in applied)
  const out = cleanAutoUpdate({ ...AU, Env: 'secret', log: 'x', applied: [{ name: 'curl', version: '8.5.0-2', from: 'x', origin: 'Debian-Security' }] })
  assert.deepEqual(Object.keys(out).sort(), ['applied', 'enabled', 'installed', 'lastResult', 'lastRunAt', 'securityOnly'])
  assert.deepEqual(out.applied, [{ name: 'curl', version: '8.5.0-2' }])
  // booleans: only true is true; lastRunAt: finite number only; lastResult outside the list → null
  const loose = cleanAutoUpdate({ installed: 'true', enabled: 1, securityOnly: 'yes', lastRunAt: '1800000000', lastResult: 'ok' })
  assert.deepEqual(loose, { installed: false, enabled: false, securityOnly: false, lastRunAt: null, lastResult: null, applied: [] })
  assert.equal(cleanAutoUpdate({ ...AU, lastRunAt: -5 }).lastRunAt, null)
  assert.equal(cleanAutoUpdate({ ...AU, lastRunAt: Infinity }).lastRunAt, null)
  // control character, non-Debian shape, wrong type: entry REMOVED, never repaired
  const applied = [
    { name: 'ok-pkg', version: '1.2.3-1' },
    { name: 'evil\u001b[31m', version: '1' },
    { name: 'libc6', version: '2.36\n-9' },
    { name: 'Upper', version: '1' },
    { name: '<img src=x>', version: '1' },
    { name: 'tzdata', version: 2024 },
    { name: 'perl', version: '5.36_0' }, // "_" outside the v7 agent shape
    { name: 'zlib1g', version: '' },
    { name: 'a'.repeat(101), version: '1' },
    null,
    'texte',
  ]
  assert.deepEqual(cleanAutoUpdate({ ...AU, applied }).applied, [{ name: 'ok-pkg', version: '1.2.3-1' }])
  assert.deepEqual(cleanAutoUpdate({ ...AU, applied: 'openssl' }).applied, [])
  // list too long: 50 at most, the first ones
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `pkg${i}`, version: '1.0' }))
  const kept = cleanAutoUpdate({ ...AU, applied: many }).applied
  assert.equal(AU_APPLIED_MAX, 50)
  assert.equal(kept.length, 50)
  assert.equal(kept.at(-1).name, 'pkg49')
})


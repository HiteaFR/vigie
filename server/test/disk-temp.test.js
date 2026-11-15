// Disk temperature of the Proxmox nodes (disk_temp). Thresholds alerts.diskTemp
// (75 / 80 °C by default, warn < crit), 2 °C hysteresis like guest_disk, critical through
// severity() (warning in dev), same entity and same parents as smart_failed; unknown
// temperature: no information. FAKE disks; real config, real rules, real engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseConfig } from '../lib/config.js'
import { createRules, RULE_LABEL } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { tmpStore } from './tmpdir.js'

const H = 3600_000
const T0 = Date.parse('2026-11-03T08:00:00Z')
const raw = (alerts = {}) => ({
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  proxmox: [
    { id: 'prod', label: 'PVE prod', host: 'https://192.0.2.155:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem' },
    { id: 'dev', label: 'PVE dev', host: 'https://192.0.2.168:8006', env: 'PVE', ca: 'pki/pve-b.pem' },
  ],
  hosts: [
    { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '192.0.2.155', env: 'prod' },
    { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', ip: '192.0.2.168', env: 'dev' },
  ],
  alerts,
})
const cfgOf = alerts => {
  const p = parseConfig(raw(alerts))
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
const disk = (temp, over = {}) => ({ node: 'pve', devpath: '/dev/nvme0n1', model: 'NVME FACTICE', health: 'PASSED', wearout: 90, temp, ...over })
const snapOf = (prod, dev = []) => ({ disks: { data: [{ id: 'prod', disks: prod }, { id: 'dev', disks: dev }] } })
const sigs = (snap, cfg = cfgOf()) => Object.fromEntries(createRules(cfg, { checks: [], result: () => null }).evaluate(snap, T0).map(s => [s.key, s]))
const K = 'disk_temp:prod/pve/dev/nvme0n1'

test('diskTemp schema: defaults 75 / 80; warn ≥ crit refused; unknown key or non-numeric value refused; config.example.json valid, at the defaults', () => {
  assert.deepEqual(cfgOf().alerts.diskTemp, { warn: 75, crit: 80 })
  assert.deepEqual(cfgOf({ diskTemp: { warn: 60 } }).alerts.diskTemp, { warn: 60, crit: 80 })
  for (const bad of [{ warn: 80, crit: 80 }, { warn: 85 }, { crit: 70 }, { warn: 75, crit: 80, hyst: 2 }, { warn: '75' }]) {
    const p = parseConfig(raw({ diskTemp: bad }))
    assert.ok(!p.config && p.errors?.length, JSON.stringify(bad))
  }
  assert.match(parseConfig(raw({ diskTemp: { warn: 80, crit: 80 } })).errors.join('\n'), /warn must be lower than crit/)
  const repo = parseConfig(JSON.parse(fs.readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8')))
  assert.ok(repo.config, repo.errors?.join('\n'))
  assert.deepEqual(repo.config.alerts.diskTemp, { warn: 75, crit: 80 })
  assert.equal(RULE_LABEL.disk_temp, 'Température du disque')
})

test('disk_temp: thresholds 75 (warning) and 80 (critical in prod), 2 °C hysteresis; same entity and same parents as smart_failed', () => {
  const at = (t, d = {}) => sigs(snapOf([disk(t, d)]))[K]
  assert.deepEqual([at(68).cond, at(68).detail], [false, '68 °C (seuils 75 / 80 °C)']) // the prod NVMe today
  assert.deepEqual([at(74.9).cond, at(75).cond, at(75).severity], [null, true, 'warning'])
  assert.deepEqual([at(79).severity, at(80).severity, at(91).severity], ['warning', 'critical', 'critical'])
  // hysteresis: between 73 and 75 excluded, no information (the current state is kept); below 73: false
  assert.deepEqual([at(74).cond, at(73).cond, at(72.9).cond, at(72).cond], [null, null, false, false])
  const s = sigs(snapOf([disk(76)]))
  assert.equal(s[K].entity, s['smart_failed:prod/pve/dev/nvme0n1'].entity)
  assert.deepEqual(s[K].parents, s['smart_failed:prod/pve/dev/nvme0n1'].parents)
  assert.deepEqual(s[K].parents, ['pve_unreachable:prod'])
  assert.equal(s[K].rule, 'disk_temp')
  assert.match(s[K].title, /^Température NVME FACTICE \(\/dev\/nvme0n1 · pve\)$/)
})

test('disk_temp: dev → warning even at 90 °C; config thresholds applied to all disks of both nodes; null, missing or non-numeric temperature → no information', () => {
  const s = sigs(snapOf([disk(90)], [disk(90, { node: 'pve-b', devpath: '/dev/sda' })]))
  assert.deepEqual([s[K].severity, s['disk_temp:dev/pve-b/dev/sda'].severity], ['critical', 'warning'])
  assert.equal(s['disk_temp:dev/pve-b/dev/sda'].cond, true)
  const c = sigs(snapOf([disk(62), disk(55, { devpath: '/dev/sda' })], [disk(66, { node: 'pve-b', devpath: '/dev/sdb' })]), cfgOf({ diskTemp: { warn: 60, crit: 65 } }))
  assert.deepEqual([c[K].cond, c[K].severity, c['disk_temp:prod/pve/dev/sda'].cond, c['disk_temp:dev/pve-b/dev/sdb'].cond, c['disk_temp:dev/pve-b/dev/sdb'].severity], [true, 'warning', false, true, 'warning'])
  for (const t of [null, undefined, Number.NaN, '81']) {
    const d = disk(t)
    if (t === undefined) delete d.temp
    const x = sigs(snapOf([d]))[K]
    assert.deepEqual([x.cond, x.detail], [null, null], String(t))
  }
  // disk source in error: no disk rule
  assert.equal(sigs({ disks: { data: [{ id: 'prod', error: 'HTTP 500' }] } })[K], undefined)
})

test('disk_temp through the engine: 76 → fires (warning); 81 → critical; 74 then 73 → still firing (hysteresis); 72 → resolved', t => {
  const cfg = cfgOf()
  const snap = { value: snapOf([disk(68)]) }
  const sent = []
  const engine = createEngine({ cfg, store: tmpStore('dash-l14-temp-', t), rules: createRules(cfg, { checks: [], result: () => null }),
    notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}:${st.severity}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: T0 - 3 * H })
  const step = (min, temp) => {
    snap.value = snapOf([disk(temp)])
    engine.evaluate(snap.value, T0 + min * 60_000)
  }
  step(0, 68)
  step(1, 76)
  assert.deepEqual(sent, [`open:${K}:warning`])
  step(2, 81)
  assert.equal(engine.active().find(a => a.key === K)?.severity, 'critical')
  for (const [m, v] of [[3, 74], [4, 73]]) step(m, v)
  assert.ok(engine.active().some(a => a.key === K && a.state === 'firing'), 'still firing between 73 and 75')
  assert.ok(!sent.some(x => x.startsWith('resolve:')))
  step(5, 72)
  assert.ok(sent.some(x => x.startsWith(`resolve:${K}`)), sent.join(' '))
})

// CUSTOM critical threshold, away from warn + 5 (otherwise a mutant
// "t >= T.warn + 5" would pass with the 75 / 80 defaults)
test('disk_temp, custom thresholds { warn: 60, crit: 70 }: 68 °C → warning, 70 °C → critical in prod, 70 °C → warning in dev', () => {
  const cfg = cfgOf({ diskTemp: { warn: 60, crit: 70 } })
  const at = (t, node = 'pve', id = 'prod') => {
    const d = disk(t, { node, devpath: '/dev/sdc' })
    const s = sigs(id === 'prod' ? snapOf([d]) : snapOf([], [d]), cfg)[`disk_temp:${id}/${node}/dev/sdc`]
    return [s.cond, s.severity]
  }
  assert.deepEqual(at(68), [true, 'warning'])
  assert.deepEqual(at(69.9), [true, 'warning'])
  assert.deepEqual(at(70), [true, 'critical'])
  assert.deepEqual(at(70, 'pve-b', 'dev'), [true, 'warning'])
})

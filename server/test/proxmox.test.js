// SMART reading (NVMe as text, SATA as attributes), coverage of
// backup jobs, orphans, vzdump logs and node rules.
// Samples taken from real responses of two Proxmox nodes (PVE 9.2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSmart, diskView, backupJob, coverage, runsFromLog, orphans, nodeStatus, memPct, taskView } from '../lib/proxmox.js'
import { createRules } from '../lib/alerts/rules.js'
import { parseConfig } from '../lib/config.js'
import { createSources } from '../lib/sources.js'
import { testPkiDir } from './tls-fixtures.js'
import { prodConfig as rrdConfig } from './network-fixture.js'

const NVME = {
  health: 'PASSED', type: 'text', wearout: 79,
  text: [
    'SMART/Health Information (NVMe Log 0x02)',
    'Critical Warning:                   0x00',
    'Temperature:                        48 Celsius',
    'Available Spare:                    100%',
    'Percentage Used:                    21%',
    'Power On Hours:                     2,059',
    'Unsafe Shutdowns:                   25',
    'Media and Data Integrity Errors:    0',
    'Warning  Comp. Temperature Time:    0',
  ].join('\n'),
}
const SATA = {
  health: 'PASSED', type: 'ata',
  attributes: [
    { id: '  5', name: 'Reallocated_Sector_Ct', raw: '0' },
    { id: '  9', name: 'Power_On_Hours', raw: '25600' },
    { id: '187', name: 'Uncorrectable_Error_Cnt', raw: '0' },
    { id: '194', name: 'Temperature_Celsius', raw: '37 (Min/Max 10/66)' },
    { id: '197', name: 'Current_Pending_Sector', raw: '2' },
  ],
}

test('SMART: NVMe (smartctl text) and SATA (attributes)', () => {
  assert.deepEqual(parseSmart(NVME), { temp: 48, powerOnHours: 2059, percentUsed: 21, mediaErrors: 0, reallocated: null, pending: null, uncorrectable: null, criticalWarning: 0 })
  const s = parseSmart(SATA)
  assert.equal(s.temp, 37)
  assert.equal(s.powerOnHours, 25600)
  assert.equal(s.pending, 2)
  assert.equal(s.uncorrectable, 0)
  // wearout from /disks/list = remaining life; "N/A" for a hard drive
  assert.equal(diskView('pve', { devpath: '/dev/nvme0n1', wearout: 79, model: 'MTFDHBA256TCK-1AS1AABHA' }, NVME).wearout, 79)
  assert.equal(diskView('pve-b', { devpath: '/dev/sdb', wearout: 'N/A', type: 'hdd' }, SATA).wearout, null)
  assert.equal(diskView('pve', { devpath: '/dev/sda' }, { error: 'Proxmox 500' }).smartError, 'Proxmox 500')
})

test('backup jobs: all except excluded, explicit list, disabled job', () => {
  const all = backupJob({ id: 'a', all: 1, exclude: '104,110', node: 'pve', 'next-run': 1792522800, schedule: '21:00', storage: 'backups' })
  const some = backupJob({ id: 'b', vmid: '200,201', enabled: 0 })
  assert.deepEqual([all.exclude, all.nextRun, some.enabled], [[104, 110], 1792522800, false])
  assert.deepEqual(coverage([all], { vmid: 100, node: 'pve' }), { covered: true, job: 'a' })
  assert.deepEqual(coverage([all], { vmid: 104, node: 'pve' }), { covered: false, excluded: true })
  assert.deepEqual(coverage([all], { vmid: 100, node: 'autre' }), { covered: false, excluded: false })
  assert.deepEqual(coverage([some], { vmid: 200, node: 'pve' }), { covered: false, excluded: false }, 'job disabled')
  assert.deepEqual(coverage([backupJob({ id: 'p', pool: 'web' })], { vmid: 1, node: 'pve' }), { covered: null })
})

test('vzdump log and orphaned backups', () => {
  const r = runsFromLog([
    'INFO: Starting Backup of VM 200 (lxc)',
    'INFO: Finished Backup of VM 200 (00:01:02)',
    'ERROR: Backup of VM 202 failed - unable to open file',
  ])
  assert.deepEqual([...r], [[200, true], [202, false]])
  const o = orphans([
    { vmid: 200, ctime: 10, size: 5, notes: 'gitea' },
    { vmid: 210, ctime: 20, size: 7, notes: 'ancien-ct', subtype: 'lxc' },
    { vmid: 210, ctime: 30, size: 3, notes: 'ancien-ct\nligne 2' },
  ], new Set([200]))
  assert.deepEqual(o, [{ vmid: 210, count: 2, size: 10, last: 30, first: 20, name: 'ancien-ct', type: 'lxc' }])
})

test('node: memory excluding cache, task in warning', () => {
  const n = nodeStatus('pve', { pveversion: 'pve-manager/9.2.21/4f6e', kversion: 'Linux 7.0.14-24-pve #1 SMP', memory: { total: 100, used: 98, available: 40 }, swap: { total: 10, used: 1 }, loadavg: ['0.78', '0.74', '0.73'] })
  assert.equal(n.pveVersion, '9.2.21')
  assert.equal(n.kernel, '7.0.14-24-pve')
  assert.deepEqual(n.load, [0.78, 0.74, 0.73])
  assert.equal(memPct(n), 60, 'the cache (available) does not count')
  assert.equal(taskView({ type: 'qmstart', status: 'WARNINGS: 1', starttime: 1 }).level, 'warn')
  assert.equal(taskView({ type: 'vzdump', status: 'job errors', starttime: 1 }).level, 'error')
})

function rules() {
  const raw = {
    version: 2, title: 't',
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', ip: '10.0.0.1', env: 'prod' },
      { id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 101, ip: '10.0.0.2', parent: 'pve', env: 'prod' },
      { id: 'old', name: 'old', kind: 'lxc', pve: 'prod', vmid: 104, ip: '10.0.0.3', parent: 'pve', env: 'prod' },
    ],
    proxmox: [{ id: 'prod', label: 'PVE prod', host: 'https://10.0.0.1:8006', env: 'PVE_PROD', ca: 'pki/pve-prod.pem', backups: { mode: 'tasks', node: 'pve' } }],
    groups: [{ id: 'g', name: 'G' }], services: [], gitea: { owner: 'x' },
  }
  const parsed = parseConfig(raw)
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  return createRules(parsed.config, { checks: [], result: () => null })
}

test('rules: node memory and swap, SMART, wear, guest without backup', () => {
  const now = Date.now()
  const snap = {
    nodes: { data: [{ id: 'prod', nodes: [{ node: 'pve', mem: { total: 100, used: 99, available: 3 }, swap: { total: 100, used: 60 } }] }] },
    disks: { data: [{ id: 'prod', disks: [
      { node: 'pve', devpath: '/dev/nvme0n1', model: 'MTFDHBA256', health: 'PASSED', wearout: 8, percentUsed: 92 },
      { node: 'pve', devpath: '/dev/sda', model: 'SAMSUNG', health: 'FAILED', wearout: 89, reallocated: 12 },
    ] }] },
    backups: { data: [{ id: 'prod', mode: 'tasks', items: [{ vmid: 101, last: now / 1000, count: 3, failed: false }], coverage: [
      { vmid: 101, covered: true, job: 'a' }, { vmid: 104, covered: false, excluded: true },
    ] }] },
  }
  const sig = Object.fromEntries(rules().evaluate(snap, now).map(s => [s.key, s]))
  assert.equal(sig['node_mem:prod/pve'].cond, true)
  assert.equal(sig['node_mem:prod/pve'].severity, 'critical', '97 % ≥ critical threshold')
  assert.equal(sig['node_swap:prod/pve'].cond, true)
  assert.equal(sig['smart_failed:prod/pve/dev/sda'].cond, true)
  assert.match(sig['smart_failed:prod/pve/dev/sda'].detail, /12 secteurs réalloués/)
  assert.equal(sig['smart_failed:prod/pve/dev/nvme0n1'].cond, false)
  assert.equal(sig['disk_wear:prod/pve/dev/nvme0n1'].cond, true)
  assert.match(sig['disk_wear:prod/pve/dev/nvme0n1'].detail, /vie restante 8 %/)
  assert.equal(sig['disk_wear:prod/pve/dev/sda'].cond, false)
  assert.equal(sig['not_backed_up:web'].cond, false)
  assert.equal(sig['not_backed_up:old'].cond, true)
  assert.equal(sig['not_backed_up:old'].detail, 'exclu du job de sauvegarde')
})

// --- /api/rrd without a PVE call for an unknown node or guest ---

function rrdBench({ down = false, rrdFails = false } = {}) {
  const calls = []
  const clock = { t: Date.parse('2026-10-27T10:00:00Z') }
  const fetch = async url => {
    const p = String(url).replace(/^https:\/\/[^/]+\/api2\/json/, '')
    calls.push(p)
    if (down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (p.startsWith('/cluster/resources')) {
      return new Response(JSON.stringify({ data: [{ type: 'node', node: 'pve', status: 'online' }, { type: 'qemu', vmid: 100, node: 'pve', name: 'docker', status: 'running', maxcpu: 4, maxmem: 8 }] }), { status: 200 })
    }
    if (p.includes('/rrddata')) {
      if (rrdFails) return new Response('{"data":null}', { status: 500 })
      return new Response(JSON.stringify({ data: [{ time: 1, cpu: 0.5, memused: 1, memtotal: 2, mem: 1, maxmem: 2 }] }), { status: 200 })
    }
    return new Response('{"data":null}', { status: 404 })
  }
  // test CA (plus the production CAs in server/pki)
  const s = createSources(rrdConfig(), { PVE_PROD_TOKEN_ID: 'id', PVE_PROD_TOKEN_SECRET: 'secret' }, { fetch, now: () => clock.t, pkiDir: testPkiDir() })
  return { s, calls, clock, rrdCalls: () => calls.filter(c => c.includes('/rrddata')).length }
}
const statusOf = p => p.then(() => 200, e => ({ status: e.status, message: e.message }))

test('unknown node → 404 "unknown node", 0 rrddata call', async () => {
  const b = rrdBench()
  assert.deepEqual(await statusOf(b.s.rrd('prod', 'inexistant')), { status: 404, message: 'nœud inconnu' })
  assert.deepEqual(await statusOf(b.s.rrd('prod', '../../access/users')), { status: 404, message: 'nœud inconnu' })
  assert.equal(b.rrdCalls(), 0)
  assert.deepEqual(await statusOf(b.s.rrd('fantome', 'pve')), { status: 404, message: 'cluster inconnu' })
})

test('unknown vmid → 404 "unknown guest", 0 rrddata call', async () => {
  const b = rrdBench()
  for (let i = 0; i < 3; i++) assert.deepEqual(await statusOf(b.s.guestRrd('prod', 9000 + i)), { status: 404, message: 'invité inconnu' })
  assert.equal(b.rrdCalls(), 0)
  // the cluster view is cached: a single /cluster/resources for these three requests
  assert.equal(b.calls.filter(c => c.startsWith('/cluster/resources')).length, 1)
})

test('known node, PVE in error: 5 GETs in 10 s → 1 rrddata call; after 30 s → 1 more', async () => {
  const b = rrdBench({ rrdFails: true })
  for (let i = 0; i < 5; i++) {
    const r = await statusOf(b.s.rrd('prod', 'pve'))
    assert.notEqual(r, 200)
    assert.notEqual(r.status, 404)
    b.clock.t += 2000
  }
  assert.equal(b.rrdCalls(), 1)
  b.clock.t += 30_000
  await statusOf(b.s.rrd('prod', 'pve'))
  assert.equal(b.rrdCalls(), 2)
})

test('known node and guest, PVE answers → points (unchanged)', async () => {
  const b = rrdBench()
  const pts = await b.s.rrd('prod', 'pve')
  assert.ok(Array.isArray(pts) && pts.length === 1)
  const g = await b.s.guestRrd('prod', 100)
  assert.deepEqual([g.vmid, g.node, g.type, g.points.length], [100, 'pve', 'qemu', 1])
})

test('Proxmox unreachable (cluster() in error) → 502 "Proxmox unreachable", 0 rrddata call', async () => {
  const b = rrdBench({ down: true })
  assert.deepEqual(await statusOf(b.s.rrd('prod', 'pve')), { status: 502, message: 'Proxmox injoignable' })
  assert.deepEqual(await statusOf(b.s.guestRrd('prod', 100)), { status: 502, message: 'Proxmox injoignable' })
  assert.equal(b.rrdCalls(), 0)
  // the routes: 404 for an unknown one, 502 otherwise
  const src = (await import('node:fs')).readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal((src.match(/res\.status\(e\.status === 404 \? 404 : 502\)/g) ?? []).length, 2)
})

// --- proxmox[].backups strict, storage required in storage mode ---
test('storage mode without storage → refused; typo (job) → refused; the repository config.example.json is valid', async () => {
  const fs = await import('node:fs')
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/config.reference.json', import.meta.url), 'utf8'))
  const withBackups = backups => ({ ...raw, proxmox: raw.proxmox.map((p, i) => (i === 0 ? { ...p, backups } : p)) })
  const b1 = parseConfig(withBackups({ mode: 'storage', node: 'pve-b' }))
  assert.ok(b1.errors, 'storage required')
  assert.match(b1.errors.join('\n'), /proxmox\.0\.backups\.storage/)
  const b2 = parseConfig(withBackups({ mode: 'tasks', node: 'pve', job: 10 }))
  assert.ok(b2.errors, 'unknown key refused')
  assert.match(b2.errors.join('\n'), /job/)
  assert.ok(parseConfig(withBackups({ mode: 'other', node: 'pve' })).errors, 'unknown mode')
  assert.ok(!parseConfig(withBackups({ mode: 'storage', node: 'pve-b', storage: 'backup-dev' })).errors)
  const b3 = parseConfig(raw)
  assert.ok(!b3.errors, b3.errors?.join('\n'))
})

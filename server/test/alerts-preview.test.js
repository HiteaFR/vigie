// Rules simulation (scripts/alerts-preview.mjs). Static: GET only, no import of the notifier,
// the database, the engine or Telegram. Functional: against a FAKE local API (127.0.0.1, dummy
// data), the alerts of the rules are listed with their severity and their suppressing parents;
// nothing is written, nothing is sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(SERVER, 'scripts/alerts-preview.mjs')
const SRC = fs.readFileSync(SCRIPT, 'utf8')
// code only (the header comments describe precisely what is absent)
const CODE = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('simulation, static: GET only; no import of the notifier, the database, the engine, Telegram or the environment', () => {
  const imports = [...SRC.matchAll(/^import .* from '([^']+)'$/gm)].map(m => m[1]).sort()
  assert.deepEqual(imports, ['../lib/alerts/rules.js', '../lib/config.js', '../lib/i18n.js', '../lib/monitor.js', 'node:path', 'node:url'] /* i18n, config language */)
  assert.doesNotMatch(CODE, /notif|telegram|engine|openDb|node:sqlite|\.env|process\.env|ALERTS_DRY_RUN/i)
  assert.doesNotMatch(CODE, /import\(/)
  const methods = [...CODE.matchAll(/method: '([A-Z]+)'/g)].map(m => m[1])
  assert.deepEqual(methods, ['GET'])
  assert.equal((CODE.match(/fetch\(/g) || []).length, 1, 'a single network call, the one in get()')
})

// script launched asynchronously (the fake API answers in this process)
const runScript = (args, env = { PATH: process.env.PATH }) => new Promise(resolve => {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env })
  let stdout = ''
  let stderr = ''
  c.stdout.on('data', d => { stdout += d })
  c.stderr.on('data', d => { stderr += d })
  c.on('close', status => resolve({ status, stdout, stderr }))
})

// fake API: dummy answers, any method other than GET refused and counted
async function fakeApi(t, data) {
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (req.method !== 'GET' || !data[req.url]) { res.writeHead(req.method === 'GET' ? 404 : 405); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data[req.url]))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return { base: `http://127.0.0.1:${srv.address().port}`, seen }
}

test('simulation, functional (fake local API): alerts listed by rule, severity, suppressing parents; GETs only', async t => {
  const dir = tmpDir('dash-preview-', t)
  const cfgPath = path.join(dir, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({
    version: 2, title: 't', locale: 'fr', gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD', ignoreGuests: [150] }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', env: 'prod' },
      { id: 'pihole', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, env: 'prod', agent: 'ssh', ip: '192.0.2.5' },
      { id: 'sans-agent', name: 'sans-agent', kind: 'lxc', pve: 'prod', vmid: 120, env: 'prod' },
      // STOPPED CT without agent: no information (cond null), never listed
      { id: 'arrete', name: 'arrete', kind: 'lxc', pve: 'prod', vmid: 121, env: 'prod' },
      { id: 'docker-a', name: 'docker-a', kind: 'vm', pve: 'prod', vmid: 101, env: 'prod', agent: 'ssh', ip: '192.0.2.156' },
    ],
    services: [{
      id: 'gluetun', name: 'Gluetun', group: 'g', host: 'docker-a', container: 'gluetun',
      widget: { url: 'http://192.0.2.156:8000', fields: [
        { label: 'VPN', path: '/v1/vpn/status', json: 'status', format: 'text' },
        { label: 'Opérateur', path: '/v1/publicip/ip', json: 'organization', format: 'text' },
      ] },
      checks: [{ type: 'http', url: 'http://192.0.2.156:8000/v1/publicip/ip', label: 'control server' }],
      vpn: { type: 'gluetun', homeIsp: 'FAI-Maison' },
    }],
    // no essential units by default anymore; pihole-FTL declared to keep the critical case
    alerts: { criticalUnits: ['pihole-FTL'] },
  }))
  const now = new Date().toISOString()
  const fast = systemd => ({ fs: [], docker: null, reboot: { required: false }, systemd })
  const api = await fakeApi(t, {
    '/api/agents': { hosts: [
      { id: 'pihole', agent: 'ssh', ok: true, at: Date.now() - 30_000, fast: fast({ failed: ['logrotate.service', 'pihole-FTL.service'], watched: [] }) },
      // slow v7 report, auto updates disabled (dummy data)
      { id: 'docker-a', agent: 'ssh', ok: true, at: Date.now() - 30_000, fast: fast({ failed: [], watched: [] }), slowAt: Date.now() - 60_000, slow: { version: 7, ts: Math.floor(Date.now() / 1000), apt: null, autoUpdate: { installed: true, enabled: false, securityOnly: true, lastRunAt: null, lastResult: null, applied: [] } } },
      { id: 'sans-agent', agent: null },
    ] },
    '/api/cluster': [{ id: 'prod', guests: [
      { vmid: 101, name: 'docker-a', type: 'qemu', status: 'running', disk: 0, maxdisk: 0 },
      { vmid: 105, name: 'pihole', type: 'lxc', status: 'running', disk: 1, maxdisk: 10 },
      { vmid: 120, name: 'sans-agent', type: 'lxc', status: 'running', disk: 9.6, maxdisk: 10 },
      { vmid: 121, name: 'arrete', type: 'lxc', status: 'stopped', disk: 9.9, maxdisk: 10 },
      { vmid: 130, name: 'inconnu', type: 'lxc', status: 'running', disk: 1, maxdisk: 10 },
      { vmid: 150, name: 'ignore', type: 'qemu', status: 'stopped', disk: 0, maxdisk: 0 },
    ], storages: [] }],
    '/api/services': { services: [{ id: 'gluetun', checks: [{ id: 'gluetun#0', state: 'ok' }], widget: { fields: [{ label: 'VPN', value: 'running' }, { label: 'Opérateur', value: 'AS64500 FAI-Maison SA' }], error: null, at: now } }] },
    '/api/backups': [],
    // node disks (dummy), one at 76 °C, one at 68 °C
    '/api/proxmox': { clusters: [{ id: 'prod', disks: [
      { node: 'pve', devpath: '/dev/nvme0n1', model: 'NVME FACTICE', health: 'PASSED', wearout: 90, temp: 68 },
      { node: 'pve', devpath: '/dev/sda', model: 'SSD FACTICE', health: 'PASSED', wearout: 90, temp: 76 },
    ], disksError: null }] },
  })
  const r = await runScript(['--api', api.base, '--config', cfgPath])
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout
  assert.match(out, /^systemd_failed \(Unité systemd\): 1 alert\(s\)\n {2}critical systemd_failed:pihole · Unités systemd · pihole · pihole-FTL\.service, logrotate\.service$/m)
  assert.match(out, /^guest_disk \(Disque\): 1 alert\(s\)\n {2}critical guest_disk:sans-agent:\/ · Disque \/ · sans-agent · 96 % utilisés \(d'après Proxmox\)$/m)
  assert.doesNotMatch(out, /arrete/, 'cond null: never listed')
  assert.match(out, /^vpn_down \(VPN arrêté\): none$/m)
  assert.match(out, /^ {2}critical vpn_leak:gluetun · Fuite VPN Gluetun · IP publique chez « AS64500 FAI-Maison SA » \(FAI de la maison\)$/m)
  assert.match(out, /^guest_undeclared \(Invité non déclaré\): 1 alert\(s\)\n {2}info {4} guest_undeclared:prod:130 · CT 130 inconnu non déclaré/m)
  // auto update rules listed; disabled on docker-a (v7) → warning, nothing else
  assert.match(out, /^autoupdate_off \(MAJ automatiques coupées\): 1 alert\(s\)\n {2}warning  autoupdate_off:docker-a · MAJ automatiques · docker-a · MAJ automatiques désactivées$/m)
  assert.match(out, /^autoupdate_failed \(MAJ automatiques en échec\): none$/m)
  // vpn_noinfo listed with the other rules; known operator → none
  assert.match(out, /^vpn_noinfo \(IP du VPN inconnue\): none$/m)
  // disk_temp listed; only the disk at 76 °C, as a warning
  assert.match(out, /^disk_temp \(Température du disque\): 1 alert\(s\)\n {2}warning  disk_temp:prod\/pve\/dev\/sda · Température SSD FACTICE \(\/dev\/sda · pve\) · 76 °C \(seuils 75 \/ 80 °C\)$/m)
  assert.ok(api.seen.length === 5 && api.seen.every(x => x.startsWith('GET ')), JSON.stringify(api.seen))
  // API unreachable or failing: message, exit code 1
  const empty = await fakeApi(t, {})
  const e = await runScript(['--api', empty.base, '--config', cfgPath])
  assert.equal(e.status, 1)
  assert.match(e.stderr, /^✗ preview: GET \/api\/agents → HTTP 404/)
})

// Alert rules. Same method in prod and in dev (severity() brings critical down to
// warning in dev), existing rules and mechanisms reused. Real createRules, config validated by
// the schema, DUMMY agents, Proxmox and widgets; real engine for the parents (cascade).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRules } from '../lib/alerts/rules.js'
import { createEngine } from '../lib/alerts/engine.js'
import { createClock } from '../lib/clock.js'
import { parseConfig } from '../lib/config.js'
import { tmpStore } from './tmpdir.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const NOW = Date.parse('2026-10-29T20:00:00Z')
const noMonitor = { checks: [], result: () => null }
// no default list in the schema any more; these tests declare their critical units
const UNITS = ['pihole-FTL', 'unbound', 'traefik', 'docker', 'tailscaled', 'gitea', 'mariadb', 'nginx', 'php8.4-fpm', 'postfix', 'ssh', 'nftables', 'ufw']

// minimal v2 config: one prod cluster and one dev cluster, hosts passed as a parameter
export function l7Config(over = {}) {
  const p = parseConfig({
    version: 2, title: 't', gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD' }, { id: 'dev', label: 'Dev', host: 'http://192.0.2.156:8006', env: 'PVE' }],
    hosts: [
      { id: 'pve', name: 'pve', kind: 'pve-node', pve: 'prod', env: 'prod' },
      { id: 'pve-b', name: 'pve-b', kind: 'pve-node', pve: 'dev', env: 'dev' },
      ...(over.hosts ?? []),
    ],
    services: over.services ?? [],
    alerts: { criticalUnits: UNITS, ...over.alerts },
    ...(over.extra ?? {}),
  })
  assert.ok(p.config, p.errors?.join('\n'))
  return p.config
}
// dummy agents: fresh (fast) report per host
function agentsOf(cfg, fastById) {
  const hosts = cfg.hosts.filter(h => h.agent)
  return { hosts, get: id => ({ ok: true, at: NOW - 30_000, fast: fastById[id] ?? null, slow: null }) }
}
const fastWith = (systemd, over = {}) => ({ fs: [], docker: null, reboot: { required: false }, systemd, ...over })
const sig = (list, key) => list.find(s => s.key === key)

test('systemd_failed: warning by default; critical if a critical unit has failed, listed first; dev brought down to warning; host override takes precedence', () => {
  const cfg = l7Config({
    hosts: [
      { id: 'pihole', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, env: 'prod', agent: 'ssh', ip: '192.0.2.11' },
      { id: 'lab', name: 'lab', kind: 'lxc', pve: 'dev', vmid: 120, env: 'dev', agent: 'ssh', ip: '192.0.2.12' },
      { id: 'proxy', name: 'proxy', kind: 'lxc', pve: 'prod', vmid: 110, env: 'prod', agent: 'ssh', ip: '192.0.2.13', alerts: { severity: 'warning' } },
      { id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 111, env: 'prod', agent: 'ssh', ip: '192.0.2.14' },
    ],
  })
  const fast = {
    // failed logrotate alone: warning (the case of the evening of 29/10)
    pihole: fastWith({ failed: ['logrotate.service'], watched: [{ unit: 'pihole-FTL.service', active: 'active' }] }),
    lab: fastWith({ failed: ['logrotate.service', 'mariadb.service'], watched: [] }),
    proxy: fastWith({ failed: [], watched: [{ unit: 'traefik.service', active: 'failed' }] }),
    web: fastWith({ failed: ['logrotate.service', 'certbot.timer'], watched: [{ unit: 'docker.service', active: 'inactive' }, { unit: 'nginx.service', active: 'active' }] }),
  }
  const out = createRules(cfg, noMonitor, agentsOf(cfg, fast)).evaluate({}, NOW)
  const p = sig(out, 'systemd_failed:pihole')
  assert.deepEqual([p.cond, p.severity, p.detail], [true, 'warning', 'logrotate.service'])
  const w = sig(out, 'systemd_failed:web')
  assert.deepEqual([w.severity, w.detail], ['critical', 'docker.service, logrotate.service, certbot.timer'])
  // dev: critical brought down to warning by severity(), critical unit still first
  const l = sig(out, 'systemd_failed:lab')
  assert.deepEqual([l.severity, l.detail], ['warning', 'mariadb.service, logrotate.service'])
  // host override (alerts.severity) takes precedence
  assert.equal(sig(out, 'systemd_failed:proxy').severity, 'warning')
  assert.deepEqual(sig(out, 'systemd_failed:pihole').parents, ['agent_unreachable:pihole', 'guest_stopped:pihole', 'pve_unreachable:prod'])
})

test('criticalUnits: none by default; exact name or + .service; provided list applied as is; invalid names rejected', () => {
  const bare = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], gitea: { owner: 'x' } })
  assert.deepEqual(bare.config.alerts.criticalUnits, [], 'schema default: no critical unit')
  assert.deepEqual(l7Config().alerts.criticalUnits, UNITS)
  const host = { id: 'h', name: 'h', kind: 'lxc', pve: 'prod', vmid: 130, env: 'prod', agent: 'ssh', ip: '192.0.2.15' }
  const run = (criticalUnits, failed) => {
    const cfg = l7Config({ hosts: [host], alerts: criticalUnits ? { criticalUnits } : undefined })
    return sig(createRules(cfg, noMonitor, agentsOf(cfg, { h: fastWith({ failed, watched: [] }) })).evaluate({}, NOW), 'systemd_failed:h').severity
  }
  assert.equal(run(null, ['ssh.service']), 'critical')
  assert.equal(run(null, ['ssh']), 'critical')
  assert.equal(run(null, ['sshd.service']), 'warning', 'no prefix match')
  assert.equal(run(null, ['agent-gateway.service']), 'warning')
  assert.equal(run(null, ['tigervncserver@:10.service']), 'warning')
  assert.equal(run(['backup.timer'], ['backup.timer']), 'critical')
  assert.equal(run(['backup'], ['backup.timer']), 'warning', 'a .timer must be named explicitly')
  assert.equal(run(['docker-housekeeping'], ['docker-housekeeping.timer']), 'warning')
  assert.equal(run(['backup.timer'], ['docker.service']), 'warning', 'provided list: replaces the default')
  assert.equal(run([], ['docker.service']), 'warning')
  assert.equal(run([], ['ssh.service']), 'warning', 'empty list: no critical unit')
  for (const bad of [['a b'], [''], ['-x'], [42], 'ssh']) {
    assert.ok(parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [], services: [], gitea: { owner: 'x' }, alerts: { criticalUnits: bad } }).errors, JSON.stringify(bad))
  }
})

// dummy Proxmox: cluster guests (sources.cluster format)
const guest = (vmid, name, type, disk, maxdisk, status = 'running') => ({ vmid, name, type, status, node: 'n', cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk, maxdisk, uptime: 1 })
const clusterSnap = (prod, dev = []) => ({ cluster: { data: [{ id: 'prod', guests: prod, storages: [] }, { id: 'dev', guests: dev, storages: [] }] } })
const GB = 1024 ** 3

test('disk of CTs without agent according to Proxmox: same key and same thresholds as guest_disk (85 / 95 %, hysteresis), source in the detail; prod critical, dev warning', () => {
  const cfg = l7Config({
    hosts: [
      { id: 'ct-a', name: 'ct-a', kind: 'lxc', pve: 'prod', vmid: 201, env: 'prod' },
      { id: 'ct-b', name: 'ct-b', kind: 'lxc', pve: 'prod', vmid: 202, env: 'prod' },
      { id: 'ct-c', name: 'ct-c', kind: 'lxc', pve: 'prod', vmid: 203, env: 'prod' },
      { id: 'ct-d', name: 'ct-d', kind: 'lxc', pve: 'dev', vmid: 204, env: 'dev' },
      { id: 'ct-e', name: 'ct-e', kind: 'lxc', pve: 'prod', vmid: 205, env: 'prod' },
    ],
  })
  const out = createRules(cfg, noMonitor).evaluate(clusterSnap(
    [guest(201, 'ct-a', 'lxc', 9 * GB, 10 * GB), guest(202, 'ct-b', 'lxc', 9.6 * GB, 10 * GB), guest(203, 'ct-c', 'lxc', 8.4 * GB, 10 * GB), guest(205, 'ct-e', 'lxc', 8.2 * GB, 10 * GB)],
    [guest(204, 'ct-d', 'lxc', 9.7 * GB, 10 * GB)],
  ), NOW)
  const a = sig(out, 'guest_disk:ct-a:/')
  assert.deepEqual([a.rule, a.cond, a.severity, a.detail, a.title, a.entity, a.link], ['guest_disk', true, 'warning', '90 % utilisés (d\'après Proxmox)', 'Disque / · ct-a', 'ct-a', '/infra?h=ct-a'])
  assert.deepEqual(a.parents, ['guest_stopped:ct-a', 'pve_unreachable:prod'])
  assert.deepEqual([sig(out, 'guest_disk:ct-b:/').cond, sig(out, 'guest_disk:ct-b:/').severity], [true, 'critical'])
  assert.equal(sig(out, 'guest_disk:ct-c:/').cond, null, 'hysteresis: between 83 and 85 %')
  assert.equal(sig(out, 'guest_disk:ct-e:/').cond, false)
  assert.deepEqual([sig(out, 'guest_disk:ct-d:/').cond, sig(out, 'guest_disk:ct-d:/').severity], [true, 'warning'], 'dev: warning')
})

test('no duplicate and no false measurement: host with agent (agent measurement only), VM without agent excluded, CT stopped or without maxdisk → cond null, CT missing → null, cluster in error → nothing', () => {
  const cfg = l7Config({
    hosts: [
      { id: 'agentful', name: 'agentful', kind: 'lxc', pve: 'prod', vmid: 210, env: 'prod', agent: 'ssh', ip: '192.0.2.30' },
      { id: 'home-assistant', name: 'home-assistant', kind: 'vm', pve: 'prod', vmid: 100, env: 'prod' },
      { id: 'arrete', name: 'arrete', kind: 'lxc', pve: 'prod', vmid: 211, env: 'prod' },
      { id: 'vide', name: 'vide', kind: 'lxc', pve: 'prod', vmid: 212, env: 'prod' },
      { id: 'absent', name: 'absent', kind: 'lxc', pve: 'prod', vmid: 213, env: 'prod' },
    ],
  })
  const agents = agentsOf(cfg, { agentful: fastWith({ failed: [], watched: [] }, { fs: [{ mount: '/', size: 10, used: 5, avail: 5 }] }) })
  const out = createRules(cfg, noMonitor, agents).evaluate(clusterSnap([
    guest(210, 'agentful', 'lxc', 9.9 * GB, 10 * GB), guest(100, 'home-assistant', 'qemu', 9.9 * GB, 10 * GB),
    guest(211, 'arrete', 'lxc', 9.9 * GB, 10 * GB, 'stopped'), guest(212, 'vide', 'lxc', 0, 0),
  ]), NOW)
  const disks = out.filter(s => s.rule === 'guest_disk')
  assert.deepEqual(disks.filter(s => s.key === 'guest_disk:agentful:/').map(s => s.detail), ['50 % utilisés'], 'a single measurement: the agent one')
  assert.equal(disks.some(s => s.hostId === 'home-assistant'), false, 'VM excluded')
  assert.deepEqual(['arrete', 'vide', 'absent'].map(id => sig(out, `guest_disk:${id}:/`).cond), [null, null, null])
  const err = createRules(cfg, noMonitor).evaluate({ cluster: { data: [{ id: 'prod', error: 'connect ETIMEDOUT' }, { id: 'dev', guests: [], storages: [] }] } }, NOW)
  assert.equal(err.some(s => s.rule === 'guest_disk'), false)
})

// dummy Gluetun widget: fields VPN, Pays (country), Opérateur (provider)
const GLUETUN = {
  id: 'gluetun', name: 'Gluetun', group: 'g', host: 'docker-a', container: 'gluetun',
  widget: { url: 'http://192.0.2.156:8000', auth: { type: 'header', name: 'X-API-Key', secretEnv: 'GLUETUN_KEY' }, fields: [
    { label: 'VPN', path: '/v1/vpn/status', json: 'status', format: 'text' },
    { label: 'Pays', path: '/v1/publicip/ip', json: 'country', format: 'text' },
    { label: 'Opérateur', path: '/v1/publicip/ip', json: 'organization', format: 'text' },
  ] },
  checks: [{ type: 'http', url: 'http://192.0.2.156:8000/v1/publicip/ip', label: 'control server' }],
  vpn: { type: 'gluetun', homeIsp: 'FAI-Maison' },
}
const DOCKER = env => ({ id: 'docker-a', name: 'docker-a', kind: 'vm', pve: env === 'dev' ? 'dev' : 'prod', vmid: 101, env, agent: 'ssh', ip: '192.0.2.156' })
const widgetsOf = (values, { error = null, ageMs = 30_000, stale = false } = {}) => ({
  get: id => (id === 'gluetun' && values ? { fields: values.map((value, i) => ({ label: ['VPN', 'Pays', 'Opérateur'][i], value })), error, stale, at: new Date(NOW - ageMs).toISOString() } : null),
})
const vpnRun = ({ values, env = 'prod', vpn = GLUETUN.vpn, widget = {} }) => {
  const cfg = l7Config({ hosts: [DOCKER(env)], services: [{ ...GLUETUN, vpn }] })
  return createRules(cfg, noMonitor, null, null, null, widgetsOf(values, widget)).evaluate({}, NOW)
}
const vpnOf = out => ({ down: sig(out, 'vpn_down:gluetun'), leak: sig(out, 'vpn_leak:gluetun') })

test('VPN: tunnel up at a VPN provider → nothing; IP at the home ISP (case ignored, substring) → critical leak, warning in dev; tunnel stopped → vpn_down warning', () => {
  const ok = vpnOf(vpnRun({ values: ['running', 'Netherlands', 'AS9009 M247 Europe SRL'] }))
  assert.deepEqual([ok.down.cond, ok.leak.cond], [false, false])
  const leak = vpnOf(vpnRun({ values: ['running', 'France', 'AS64500 FAI-Maison SA'] })).leak
  assert.deepEqual([leak.cond, leak.severity, leak.detail, leak.title, leak.rule], [true, 'critical', 'IP publique chez « AS64500 FAI-Maison SA » (FAI de la maison)', 'Fuite VPN Gluetun', 'vpn_leak'])
  assert.equal(vpnOf(vpnRun({ values: ['running', 'France', 'as64500 FAI-MAISON sa'] })).leak.cond, true)
  // status compared case-insensitively ("Running" equals "running": no false vpn_down)
  for (const st of ['Running', 'RUNNING', ' running ']) assert.equal(vpnOf(vpnRun({ values: [st, 'Netherlands', 'AS9009 M247'] })).down.cond, false, st)
  assert.deepEqual([vpnOf(vpnRun({ env: 'dev', values: ['running', 'France', 'AS64500 FAI-Maison SA'] })).leak.severity], ['warning'])
  const down = vpnOf(vpnRun({ values: ['stopped', '—', '—'] }))
  assert.deepEqual([down.down.cond, down.down.severity, down.down.detail, down.down.forSec, down.leak.cond], [true, 'warning', 'tunnel : stopped', 120, null])
  assert.deepEqual(down.down.parents, ['service_down:gluetun', 'container_restarting:docker-a/gluetun', 'container_unhealthy:docker-a/gluetun', 'agent_unreachable:docker-a', 'guest_stopped:docker-a', 'pve_unreachable:prod'])
})

test('VPN countries (optional): without the key, the country does not count; with it, a country outside the list = leak (case ignored); home ISP always takes precedence', () => {
  assert.equal(vpnOf(vpnRun({ values: ['running', 'Germany', 'AS9009 M247'] })).leak.cond, false, 'without countries')
  const nl = { type: 'gluetun', homeIsp: 'FAI-Maison', countries: ['Netherlands'] }
  assert.equal(vpnOf(vpnRun({ vpn: nl, values: ['running', 'netherlands', 'AS9009 M247'] })).leak.cond, false)
  const de = vpnOf(vpnRun({ vpn: nl, values: ['running', 'Germany', 'AS9009 M247'] })).leak
  assert.deepEqual([de.cond, de.detail], [true, 'pays de sortie Germany (attendu : Netherlands)'])
  assert.match(vpnOf(vpnRun({ vpn: nl, values: ['running', 'Netherlands', 'AS64500 FAI-Maison'] })).leak.detail, /FAI de la maison/)
})

test('VPN countries with several countries (Gluetun exits through NL, CH and SE since 2026-11-05): each is accepted, another country is still a leak, the home ISP too', () => {
  const trois = { type: 'gluetun', homeIsp: 'FAI-Maison', countries: ['Netherlands', 'Switzerland', 'Sweden'] }
  for (const pays of ['Netherlands', 'Switzerland', 'Sweden']) assert.equal(vpnOf(vpnRun({ vpn: trois, values: ['running', pays, 'AS9009 M247 Europe SRL'] })).leak.cond, false, pays)
  const de = vpnOf(vpnRun({ vpn: trois, values: ['running', 'Germany', 'AS9009 M247 Europe SRL'] })).leak
  assert.deepEqual([de.cond, de.detail], [true, 'pays de sortie Germany (attendu : Netherlands, Switzerland, Sweden)'])
  assert.match(vpnOf(vpnRun({ vpn: trois, values: ['running', 'Switzerland', 'AS64500 FAI-Maison'] })).leak.detail, /FAI de la maison/)
})

test('VPN without information → cond null (never an invented alert): widget missing, old (> 5 min), empty values', () => {
  for (const [what, run] of [
    ['missing', vpnRun({ values: null })],
    ['old', vpnRun({ values: ['stopped', 'France', 'FAI-Maison'], widget: { ageMs: 6 * 60_000 } })],
    ['empty', vpnRun({ values: ['—', '', '—'] })],
  ]) {
    const v = vpnOf(run)
    assert.deepEqual([v.down.cond, v.leak.cond], [null, null], what)
  }
})

test('VPN, widget IN ERROR (key rejected, API changed) → vpn_down warning with the error in the detail (monitoring does not go silent); leak: no information', () => {
  for (const widget of [{ error: '/v1/vpn/status → HTTP 401' }, { error: 'timeout', stale: true }]) {
    const v = vpnOf(vpnRun({ values: ['running', 'Netherlands', 'AS9009 M247'], widget }))
    assert.deepEqual([v.down.cond, v.down.severity, v.down.detail, v.leak.cond], [true, 'warning', `widget en erreur (surveillance du tunnel impossible) : ${widget.error}`, null])
  }
  assert.equal(vpnOf(vpnRun({ env: 'dev', values: ['running', '—', '—'], widget: { error: 'HTTP 401' } })).down.severity, 'warning')
})

test('VPN, no cascade (real engine): control server unreachable (service_down ongoing) and widget in error → vpn_down suppressed, not notified; only service_down is sent', () => {
  const cfg = l7Config({ hosts: [DOCKER('prod')], services: [GLUETUN], alerts: { startupGraceSec: 0 } })
  const check = { id: 'gluetun#0', serviceId: 'gluetun', type: 'http', label: 'control server' }
  const monitor = { checks: [check], result: () => ({ state: 'crit', fails: 5, oks: 0, code: 0, error: 'ECONNREFUSED' }) }
  const rules = createRules(cfg, monitor, null, null, null, widgetsOf(['stopped', '—', '—'], { error: 'ECONNREFUSED' }))
  const sent = []
  const engine = createEngine({ cfg, store: tmpStore('dash-l7-'), rules, notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: NOW - 3600_000 })
  for (let t = NOW; t <= NOW + 10 * 60_000; t += 15_000) engine.evaluate({}, t)
  const active = engine.active()
  const down = active.find(a => a.key === 'vpn_down:gluetun')
  assert.equal(active.find(a => a.key === 'service_down:gluetun').state, 'firing')
  assert.ok(down && down.suppressed, JSON.stringify(down))
  assert.deepEqual(sent.filter(x => x.startsWith('open')), ['open:service_down:gluetun'])
})

test('VPN, widget in error WITHOUT service_down (real engine): vpn_down notified after 2 min', () => {
  const cfg = l7Config({ hosts: [DOCKER('prod')], services: [GLUETUN], alerts: { startupGraceSec: 0 } })
  const monitor = { checks: [{ id: 'gluetun#0', serviceId: 'gluetun', type: 'http', label: 'control server (sans clé)' }], result: () => ({ state: 'ok', fails: 0, oks: 5, code: 401 }) }
  const rules = createRules(cfg, monitor, null, null, null, widgetsOf(['running', 'Netherlands', 'AS9009 M247'], { error: '/v1/vpn/status → HTTP 401' }))
  const sent = []
  const engine = createEngine({ cfg, store: tmpStore('dash-l7-'), rules, notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'now' } }, clock: createClock('Europe/Paris'), startedAt: NOW - 3600_000 })
  for (let t = NOW; t <= NOW + 5 * 60_000; t += 15_000) engine.evaluate({}, t)
  assert.deepEqual(sent.filter(x => x.startsWith('open')), ['open:vpn_down:gluetun'])
  assert.match(engine.get('vpn_down:gluetun').detail, /widget en erreur/)
})

test('vpn schema: homeIsp required, countries optional but not empty, gluetun type only, unknown key rejected; widget fields required (text format), host required', async () => {
  const base = vpn => ({ version: 2, title: 't', proxmox: [], gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }], hosts: [{ id: 'docker-a', name: 'd', kind: 'appliance', env: 'prod' }], services: [{ ...GLUETUN, vpn }] })
  assert.ok(parseConfig(base({ type: 'gluetun', homeIsp: 'FAI-Maison' })).config)
  assert.ok(parseConfig(base({ type: 'gluetun', homeIsp: 'FAI-Maison', countries: ['Netherlands'] })).config)
  for (const bad of [{ type: 'gluetun' }, { type: 'gluetun', homeIsp: 'B' }, { type: 'wireguard', homeIsp: 'FAI-Maison' }, { type: 'gluetun', homeIsp: 'FAI-Maison', countries: [] }, { type: 'gluetun', homeIsp: 'FAI-Maison', ip: '1.2.3.4' }]) {
    assert.ok(parseConfig(base(bad)).errors, JSON.stringify(bad))
  }
  const noOrg = base({ type: 'gluetun', homeIsp: 'FAI-Maison' })
  noOrg.services[0].widget = { ...GLUETUN.widget, fields: GLUETUN.widget.fields.slice(0, 2) }
  assert.deepEqual(parseConfig(noOrg).errors, ['service gluetun: vpn requires a widget field /v1/publicip/ip (json organization)'])
  const withCountries = base({ type: 'gluetun', homeIsp: 'FAI-Maison', countries: ['Netherlands'] })
  withCountries.services[0].widget = { ...GLUETUN.widget, fields: [GLUETUN.widget.fields[0], GLUETUN.widget.fields[2]] }
  assert.deepEqual(parseConfig(withCountries).errors, ['service gluetun: vpn requires a widget field /v1/publicip/ip (json country)'])
  const num = base({ type: 'gluetun', homeIsp: 'FAI-Maison' })
  num.services[0].widget = { ...GLUETUN.widget, fields: [{ ...GLUETUN.widget.fields[0], format: 'number' }, ...GLUETUN.widget.fields.slice(1)] }
  assert.deepEqual(parseConfig(num).errors, ['service gluetun: widget field /v1/vpn/status (json status) must use the text format'])
  const noHost = base({ type: 'gluetun', homeIsp: 'FAI-Maison' })
  noHost.services[0] = { ...noHost.services[0], host: undefined, env: 'prod' }
  delete noHost.services[0].host
  assert.ok(parseConfig(noHost).errors.includes('service gluetun: vpn requires a host'))
  const fs = await import('node:fs')
  // plus the signals of the notification channels
  assert.match(fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8'), /createRules\(cfg, monitor, agents, updates, null, widgets, memory, \{ host, channels: \(\) => notifier\.channelSignals\(\) \}\)/)
})

test('undeclared guest: info in prod as in dev, key guest_undeclared:<cluster>:<vmid>, name and type in the title; declared or ignored → cond false; parent pve_unreachable', () => {
  const cfg = l7Config({
    hosts: [{ id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 201, env: 'prod' }],
    extra: { proxmox: [{ id: 'prod', label: 'Prod', host: 'http://192.0.2.155:8006', env: 'PVE_PROD', ignoreGuests: [250] }, { id: 'dev', label: 'Dev', host: 'http://192.0.2.156:8006', env: 'PVE' }] },
  })
  const out = createRules(cfg, noMonitor).evaluate(clusterSnap(
    [guest(201, 'web', 'lxc', 1, 10), guest(210, 'proxy', 'lxc', 1, 10), guest(250, 'essai', 'qemu', 0, 0)],
    [guest(210, 'proxy-dev', 'qemu', 0, 0, 'stopped')],
  ), NOW)
  const u = out.filter(s => s.rule === 'guest_undeclared')
  assert.deepEqual(u.map(s => [s.key, s.cond]), [['guest_undeclared:prod:201', false], ['guest_undeclared:prod:210', true], ['guest_undeclared:prod:250', false], ['guest_undeclared:dev:210', true]])
  const p = sig(out, 'guest_undeclared:prod:210')
  assert.deepEqual([p.title, p.severity, p.env, p.parents, p.entity], ['CT 210 proxy non déclaré', 'info', 'prod', ['pve_unreachable:prod'], 'prod/210'])
  const d = sig(out, 'guest_undeclared:dev:210')
  assert.deepEqual([d.title, d.severity, d.env], ['VM 210 proxy-dev non déclaré', 'info', 'dev'])
  assert.match(d.detail, /état Proxmox : stopped/)
  // cluster unreachable: no signal (no cascade)
  const err = createRules(cfg, noMonitor).evaluate({ cluster: { data: [{ id: 'prod', error: 'connect EHOSTUNREACH' }, { id: 'dev', guests: [], storages: [] }] } }, NOW)
  assert.equal(err.some(s => s.rule === 'guest_undeclared'), false)
})

test('lifecycle (real engine): undeclared → info alert; declared → resolved; gone from Proxmox → forgotten without message; ignoreGuests: schema and warning', () => {
  const mk = hosts => l7Config({ hosts, alerts: { startupGraceSec: 0 } })
  let cfg = mk([])
  let guests = [guest(110, 'proxy', 'lxc', 1, 10), guest(111, 'tmp', 'lxc', 1, 10)]
  const sent = []
  const store = tmpStore('dash-l7-undeclared-')
  let rules = createRules(cfg, noMonitor)
  const engine = createEngine({ cfg, store, rules: { evaluate: (s, t) => rules.evaluate(s, t), impacted: () => ({ services: [], guests: 0 }) }, notifier: { enqueue: (kind, st) => { sent.push(`${kind}:${st.key}`); return 'digest' } }, clock: createClock('Europe/Paris'), startedAt: NOW - 3600_000 })
  let t = NOW
  const step = (n = 1) => { for (let i = 0; i < n; i++) { engine.evaluate(clusterSnap(guests), t); t += 15_000 } }
  step(2)
  assert.deepEqual(engine.active().map(a => [a.key, a.state, a.severity]).sort(), [['guest_undeclared:prod:110', 'firing', 'info'], ['guest_undeclared:prod:111', 'firing', 'info']])
  // 110 declared: resolved on the next cycle
  cfg = mk([{ id: 'proxy', name: 'proxy', kind: 'lxc', pve: 'prod', vmid: 110, env: 'prod' }])
  rules = createRules(cfg, noMonitor)
  step()
  assert.deepEqual(engine.active().map(a => a.key), ['guest_undeclared:prod:111'])
  // 111 deleted from Proxmox: no more signal, forgotten after 10 min, without a recovery message
  guests = guests.filter(g => g.vmid !== 111)
  const before = sent.length
  step(45)
  assert.deepEqual(engine.active(), [])
  assert.deepEqual(sent.slice(before).filter(x => x.includes(':prod:111')), [])
  // schema: vmids are positive integers; a vmid both ignored AND declared → warning
  const raw = ignoreGuests => ({ version: 2, title: 't', gitea: { owner: 'x' }, groups: [], services: [], proxmox: [{ id: 'prod', label: 'P', host: 'http://192.0.2.155:8006', env: 'PVE_PROD', ignoreGuests }], hosts: [{ id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 101, env: 'prod' }] })
  for (const bad of [[0], [-1], [1.5], ['110'], 110]) assert.ok(parseConfig(raw(bad)).errors, JSON.stringify(bad))
  assert.deepEqual(parseConfig(raw([110])).warnings ?? [], [])
  assert.deepEqual(parseConfig(raw([101])).warnings, ['proxmox prod: guest 101 declared both in hosts[] and in ignoreGuests'])
  assert.deepEqual(l7Config().proxmox.map(p => p.ignoreGuests), [[], []])
})

test('criticalUnits applies to BOTH lists: failed unwatched unit, and inactive watched unit; normalised name (pihole-FTL = pihole-FTL.service)', () => {
  const host = { id: 'pihole', name: 'pihole', kind: 'lxc', pve: 'prod', vmid: 105, env: 'prod', agent: 'ssh', ip: '192.0.2.5' }
  const cfg = l7Config({ hosts: [host] })
  const run = systemd => sig(createRules(cfg, noMonitor, agentsOf(cfg, { pihole: fastWith(systemd) })).evaluate({}, NOW), 'systemd_failed:pihole')
  // failure of an UNWATCHED unit (failed list), critical unit: critical
  assert.deepEqual([run({ failed: ['pihole-FTL.service'], watched: [] }).severity, run({ failed: ['pihole-FTL.service'], watched: [] }).cond], ['critical', true])
  // inactive WATCHED unit (watched list), critical unit: critical
  assert.equal(run({ failed: [], watched: [{ unit: 'pihole-FTL.service', active: 'inactive' }] }).severity, 'critical')
  // unwatched and not critical (the logrotate of 29/10): warning
  assert.equal(run({ failed: ['logrotate.service'], watched: [{ unit: 'pihole-FTL.service', active: 'active' }] }).severity, 'warning')
  // same unit in both lists: only once
  assert.equal(run({ failed: ['unbound.service'], watched: [{ unit: 'unbound.service', active: 'failed' }] }).detail, 'unbound.service')
})

test('undeclared guest across clusters: declared guests are those of the SAME cluster (a vmid declared in the other cluster still raises the alert)', () => {
  // the real case: vmid 101 and 106 exist in prod AND in dev
  const cfg = l7Config({ hosts: [{ id: 'd101', name: 'd101', kind: 'vm', pve: 'dev', vmid: 101, env: 'dev' }, { id: 'p106', name: 'p106', kind: 'lxc', pve: 'prod', vmid: 106, env: 'prod' }] })
  const out = createRules(cfg, noMonitor).evaluate(clusterSnap([guest(101, 'en-prod', 'qemu', 0, 0), guest(106, 'p106', 'lxc', 1, 10)], [guest(101, 'd101', 'qemu', 0, 0), guest(106, 'en-dev', 'lxc', 1, 10)]), NOW)
  assert.deepEqual(out.filter(s => s.rule === 'guest_undeclared').map(s => [s.key, s.cond]), [
    ['guest_undeclared:prod:101', true], ['guest_undeclared:prod:106', false],
    ['guest_undeclared:dev:101', false], ['guest_undeclared:dev:106', true],
  ])
})

test('RULE_LABEL: server (Telegram, bot /mute) and client have exactly the same keys and the same labels; both cover every rule emitted by the server', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { RULE_LABEL: core } = await import('../lib/alerts/rules.js')
  const { RULE_LABEL: client } = await import('../../client/src/lib/alerts.js')
  // server labels = those of the core and those of the plugins (merged at startup, index.js)
  const { createHost } = await import('../lib/plugins/host.js')
  const { PLUGINS } = await import('../plugins/index.js')
  const server = { ...core, ...createHost({ cfg: {}, log: { log() {}, warn() {}, error() {} }, plugins: PLUGINS }).labels(core) }
  assert.deepEqual(Object.keys(server).sort(), Object.keys(client).sort())
  for (const k of Object.keys(server)) assert.equal(server[k], client[k], k)
  const lib = new URL('../lib/', import.meta.url).pathname
  // except the example plugin (server/plugins/example), absent from the active list: its labels
  // are checked by example-plugin.test.js
  const plug = new URL('../plugins/', import.meta.url).pathname
  const files = [...fs.readdirSync(lib, { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join(lib, f)), ...fs.readdirSync(plug, { recursive: true }).filter(f => f.endsWith('.js') && !f.startsWith('example')).map(f => path.join(plug, f))]
  const rules = new Set(files.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/rule: '([a-z_]+)'/g)].map(m => m[1])))
  assert.ok(rules.size >= 30, `${rules.size} rules`)
  assert.deepEqual([...rules].filter(r => !server[r]).sort(), [], 'rule without a server label')
  assert.deepEqual(Object.keys(server).filter(k => !rules.has(k)).sort(), [], 'label without a rule')
})

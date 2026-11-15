// Network module: alert signals (lib/network/rules.js), pure function. Double view, stale
// Pi-hole → null (never a silent loss), signals always emitted, severities, unknown
// sources before their first reading, "to review" without effect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { networkSignals } from '../lib/network/rules.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const MIN = 60_000
const since = T - 3600_000
const dev = (id, f = {}) => [id, { id, state: 'new', origin: 'scan', created_at: T - 10 * MIN, review: 0, disp_name: `appareil-${id}`, primary_mac: `00:00:5e:00:53:0${id}`, ...f }]
const mac = (m, device, f = {}) => [m, { mac: m, device_id: device, grade: 'strong', random: 0, attach: null, confirmed_at: null, ...f }]
const seen = (m, t) => [`${m}|pihole`, { mac: m, source: 'pihole', last_seen: t }]
const okSources = { pihole: { ok: true, stale: false }, dhcp: { ok: true, stale: false }, neigh: { ok: true, stale: false }, pve: { ok: true, stale: false } }
const sig = (state, opts = {}) => networkSignals({ sources: okSources, ...state }, { now: T, alertsSince: since, ...opts })
const by = (list, key) => list.find(s => s.key === key)

test('net_new: double view, alertsSince, scan origin, review without effect', () => {
  const devices = new Map([
    dev(1), // seen only once: not yet
    dev(2), // seen again 3 min after its creation: new
    dev(3, { created_at: since - 1 }), // born before alertsSince: never
    dev(4, { origin: 'detach' }), // detached by a human: no alert
    dev(5, { state: 'known', review: 1 }), // to review: never a condition
  ])
  const macs = new Map([1, 2, 3, 4, 5].map(i => mac(`00:00:5e:00:53:0${i}`, i)))
  const seenRows = new Map([seen('00:00:5e:00:53:01', T - 10 * MIN), seen('00:00:5e:00:53:02', T - 7 * MIN),
    seen('00:00:5e:00:53:03', T), seen('00:00:5e:00:53:04', T), seen('00:00:5e:00:53:05', T)])
  const out = sig({ devices, macs, seen: seenRows })
  assert.deepEqual([1, 2, 3, 4, 5].map(i => by(out, `net_new:${i}`).cond), [false, true, false, false, false])
  const s = by(out, 'net_new:2')
  assert.deepEqual([s.severity, s.noRepeat, s.quietResolve, s.parents, s.link], ['warning', true, true, ['source_error:network/pihole'], '/network?d=2'])
  assert.equal(s.title, 'Nouvel appareil : appareil-2')
  // without a name: vendor or "unnamed device", with the record number, never the MAC alone
  const anon = sig({ devices: new Map([dev(6, { disp_name: null, vendor: 'Amazon Technologies Inc' }), dev(7, { disp_name: null })]),
    macs: new Map([mac('00:00:5e:00:53:06', 6), mac('00:00:5e:00:53:07', 7)]), seen: new Map() })
  assert.equal(by(anon, 'net_new:6').title, 'Nouvel appareil : Amazon Technologies Inc (fiche 6)')
  assert.equal(by(anon, 'net_new:7').title, 'Nouvel appareil : appareil sans nom (fiche 7)')
  assert.doesNotMatch(s.detail, /192\.0\.2/)
  // adjustable severity (network.alerts.newSeverity)
  assert.equal(by(sig({ devices, macs, seen: seenRows }, { severity: 'info' }), 'net_new:2').severity, 'info')
  // stale Pi-hole: null (the engine keeps the state, nothing is forgotten or resolved)
  const stale = sig({ devices, macs, seen: seenRows, sources: { ...okSources, pihole: { ok: false, stale: true } } })
  assert.equal(by(stale, 'net_new:2').cond, null)
  assert.equal(by(stale, 'net_new:3').cond, false) // outside the condition: still false
  // a pending MAC does not make the double view
  const pend = new Map([mac('00:00:5e:00:53:01', 1), mac('02:00:00:00:53:09', 1, { attach: 'name', grade: 'weak' })])
  const out2 = sig({ devices: new Map([dev(1)]), macs: pend, seen: new Map([seen('02:00:00:00:53:09', T)]) })
  assert.equal(by(out2, 'net_new:1').cond, false)
})

test('net_mac_added, flood, sources: always emitted, severities, null before the 1st reading', () => {
  const devices = new Map([dev(1, { state: 'known' })])
  const macs = new Map([
    mac('02:00:00:00:53:01', 1, { attach: 'name', grade: 'weak' }),
    mac('02:00:00:00:53:02', 1, { attach: 'ip', grade: 'weak' }),
    mac('02:00:00:00:53:03', 1, { attach: 'name', grade: 'weak', confirmed_at: T }), // confirmed
    mac('02:00:00:00:53:04', 1, { attach: 'detached', grade: 'weak' }),
    mac('00:00:5e:00:53:01', 1, { attach: 'pve', grade: 'hypervisor' }), // never
    mac('fe:00:00:00:53:05', 1, { attach: 'rule', grade: 'weak', confirmed_at: T - 3600_000 }), // family: 24 h as info
    mac('fe:00:00:00:53:06', 1, { attach: 'rule', grade: 'weak', confirmed_at: T - 25 * 3600_000 }),
  ])
  const out = sig({ devices, macs, seen: new Map() })
  assert.deepEqual(['01', '02', '03', '04'].map(x => by(out, `net_mac_added:02:00:00:00:53:${x}`)?.cond), [true, true, false, false])
  assert.equal(by(out, 'net_mac_added:00:00:5e:00:53:01'), undefined)
  assert.deepEqual([by(out, 'net_mac_added:fe:00:00:00:53:05').cond, by(out, 'net_mac_added:fe:00:00:00:53:05').severity], [true, 'info'])
  assert.equal(by(out, 'net_mac_added:fe:00:00:00:53:06').cond, false)
  assert.match(by(out, 'net_mac_added:fe:00:00:00:53:05').detail, /famille de MAC validée/)
  // key removed (merged record): emitted one last time as false
  const ret = sig({ devices, macs, seen: new Map(), retired: ['net_new:77', 'net_mac_added:02:00:00:00:53:01'] })
  assert.equal(by(ret, 'net_new:77').cond, false)
  assert.equal(ret.filter(s => s.key === 'net_mac_added:02:00:00:00:53:01').length, 1) // already emitted: no duplicate
  assert.equal(by(out, 'net_mac_added:02:00:00:00:53:01').severity, 'warning')
  assert.equal(by(out, 'net_mac_added:02:00:00:00:53:02').severity, 'info')
  assert.match(by(out, 'net_mac_added:02:00:00:00:53:02').detail, /même IP \(plage macvlan\)/)
  // flood: always emitted, true during the episode
  assert.equal(by(out, 'net_new_flood:lan').cond, false)
  const fl = sig({ devices, macs, seen: new Map(), flood: { refused: new Map([['x', {}]]), episode: { since: T, lastOver: T } } })
  assert.equal(by(fl, 'net_new_flood:lan').cond, true)
  assert.match(by(fl, 'net_new_flood:lan').detail, /1 MAC refusées/)
  // sources: null before the first reading, true when failing or stale, 10-min delay
  const src = sig({ devices, macs, seen: new Map(), sources: { pihole: { ok: null, stale: true }, dhcp: { ok: false, stale: false, error: 'ECONNREFUSED' }, neigh: { ok: true, stale: true } } })
  assert.deepEqual(['pihole', 'dhcp', 'neigh'].map(n => by(src, `source_error:network/${n}`).cond), [null, true, true])
  assert.equal(by(src, 'source_error:network/dhcp').forSec, 600)
  assert.equal(by(src, 'source_error:network/pve'), undefined) // source not configured
})

test('net_down (opt-in, null on a silent or failing probe, never null → 0), parents, recovery notified', () => {
  const P = { since: T - 3 * 3600_000, parentsOf: h => (h === 'g1' ? ['guest_stopped:g1', 'pve_unreachable:prod'] : []) }
  const seenSince = T - 3600_000
  const devices = new Map([
    dev(1, { state: 'known', alert_down: 1, online: 0, last_present: seenSince, host_id: 'g1' }), // seen then absent → true
    dev(2, { state: 'known', alert_down: 1, online: 0, last_present: null }), // never seen → null
    dev(3, { state: 'known', alert_down: 1, online: 0, last_present: P.since - 1 }), // seen only before the probe → null
    dev(4, { state: 'known', alert_down: 1, online: 1, last_present: T }), // online → false
    dev(5, { state: 'known', alert_down: 0, online: 0, last_present: seenSince }), // not monitored → false
    dev(7, { state: 'known', alert_down: 1, online: null, last_present: null }), // unknown → null
  ])
  const arpOk = { ...okSources, arp: { ok: true, stale: false } }
  const out = sig({ devices, macs: new Map(), seen: new Map(), sources: arpOk, presence: P })
  assert.deepEqual([1, 2, 3, 4, 5, 7].map(i => by(out, `net_down:${i}`).cond), [true, null, null, false, false, null])
  const s = by(out, 'net_down:1')
  assert.deepEqual([s.severity, s.forSec, s.noRepeat, s.quietResolve], ['warning', 0, undefined, undefined])
  assert.deepEqual(s.parents, ['guest_stopped:g1', 'pve_unreachable:prod', 'source_error:network/arp'])
  assert.equal(s.title, 'appareil-1 hors ligne')
  assert.equal(s.detail, 'vu pour la dernière fois il y a 1 h')
  // the record's severity
  devices.get(1).alert_severity = 'critical'
  assert.equal(by(sig({ devices, macs: new Map(), seen: new Map(), sources: arpOk, presence: P }), 'net_down:1').severity, 'critical')
  // silent probe, failed sweep, before the first sweep: null (the engine keeps the state)
  for (const [sources, presence] of [[{ ...okSources, arp: { ok: true, stale: true } }, P], [{ ...okSources, arp: { ok: false, stale: false, error: 'passerelle absente du balayage' } }, P], [{ ...okSources, arp: { ok: null, stale: true } }, { ...P, since: null }]]) {
    assert.equal(by(sig({ devices, macs: new Map(), seen: new Map(), sources, presence }), 'net_down:1').cond, null)
  }
  // without a configured probe: no presence signal
  assert.equal(by(sig({ devices, macs: new Map(), seen: new Map() }), 'net_down:1'), undefined)
})

test('net_ip_changed (expected IP, forSec 600, null when offline); arp source_error null before the 1st sweep', () => {
  const P = { since: T - 3 * 3600_000, parentsOf: () => [] }
  const devices = new Map([
    dev(1, { state: 'known', expected_ip: '192.0.2.10', last_ip: '192.0.2.11', online: 1 }),
    dev(2, { state: 'known', expected_ip: '192.0.2.12', last_ip: '192.0.2.12', online: 1 }),
    dev(3, { state: 'known', expected_ip: '192.0.2.13', last_ip: '192.0.2.99', online: 0 }),
    dev(4, { state: 'known', expected_ip: null, last_ip: '192.0.2.14', online: 1 }),
  ])
  const arpOk = { ...okSources, arp: { ok: true, stale: false } }
  const out = sig({ devices, macs: new Map(), seen: new Map(), sources: arpOk, presence: P })
  assert.deepEqual([1, 2, 3, 4].map(i => by(out, `net_ip_changed:${i}`).cond), [true, false, null, false])
  const s = by(out, 'net_ip_changed:1')
  assert.deepEqual([s.forSec, s.severity, s.parents, s.detail], [600, 'warning', ['source_error:network/arp'], 'IP attendue différente de l\'IP vue'])
  assert.doesNotMatch(`${s.title} ${s.detail}`, /192\.0\.2/)
  // arp source: null before presenceSince (not installed), true afterwards if silent or failing
  const arpOf = (arp, since) => by(sig({ devices: new Map(), macs: new Map(), seen: new Map(), sources: { ...okSources, arp }, presence: { ...P, since } }), 'source_error:network/arp')
  assert.equal(arpOf({ ok: null, stale: true }, null).cond, null)
  assert.equal(arpOf({ ok: false, stale: true, error: 'fichier de la sonde absent' }, null).cond, null)
  assert.equal(arpOf({ ok: false, stale: true, error: 'passerelle absente du balayage' }, null).cond, null)
  // gateway cannot be determined on a present file: reported even before the first valid sweep
  assert.equal(arpOf({ ok: false, stale: true, error: 'passerelle inconnue', gatewayUnknown: true }, null).cond, true)
  assert.equal(arpOf({ ok: null, stale: true }, T - 3600_000).cond, true)
  assert.equal(arpOf({ ok: true, stale: true }, T - 3600_000).cond, true)
  assert.equal(arpOf({ ok: true, stale: false }, T - 3600_000).cond, false)
  assert.equal(arpOf({ ok: true, stale: false }, T - 3600_000).forSec, 600)
})

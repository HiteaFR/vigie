// Network module: writes (lib/network/writes.js). Validations, required reason, full merge
// then undone, detach,
// replayed "Connu", audit of successes and refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNetStore } from '../lib/network/store.js'
import { createAudit } from '../lib/auth.js'
import { mergeSightings, emptyFlood } from '../lib/network/merge.js'
import { createNetworkWrites, validateEdit, validateReason, validatePrefix, validateIds, validateMac, DEVICE_TYPES, REASON_REQUIRED } from '../lib/network/writes.js'
import { prodConfig, prodLikeStore, GUESTS, MIN } from './network-fixture.js'
import { createNetwork } from '../lib/network/index.js'
import { effectiveParents } from '../lib/network/topology.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const who = { by: 'admin (192.0.2.5)', source: 'ui' }
function bench() {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const audit = createAudit(store)
  let clock = T
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit, now: () => clock })
  const audits = () => store.db.prepare('SELECT action, target, ok, detail FROM audit ORDER BY id').all().map(r => ({ ...r }))
  const byName = name => [...ns.load().devices.values()].find(d => d.disp_name === name)
  return { cfg, store, ns, W, audits, byName, tick: ms => { clock += ms } }
}

test('validations: reason, ids, MAC, prefix, input', () => {
  const cfg = prodConfig()
  for (const r of ['', 'ab', ' ab ', 'x'.repeat(201), null]) assert.throws(() => validateReason(r), /motif obligatoire/, String(r))
  assert.equal(validateReason('  ok ok '), 'ok ok')
  // cleaned before the check: control characters do not make a reason
  assert.throws(() => validateReason('\u0007\u0007\u0007\u0007'), /motif obligatoire/)
  assert.equal(validateReason('pas\u0007 de\ncontrôle'), 'pas de contrôle')
  assert.throws(() => validateIds([]), /ids/)
  assert.throws(() => validateIds(Array.from({ length: 201 }, (_, i) => i + 1)), /ids/)
  assert.throws(() => validateIds(['x']), /id invalide/)
  assert.throws(() => validateMac('zz'), /MAC invalide/)
  assert.throws(() => validatePrefix('fe:fd'), /3 octets/)
  assert.equal(validatePrefix('AE:00:53:*'), 'ae:00:53')
  assert.throws(() => validateEdit({ id: 1, type: 'fusée' }, cfg), /type inconnu/)
  assert.throws(() => validateEdit({ id: 1, hostId: 'inconnu' }, cfg), /hôte inconnu/)
  assert.throws(() => validateEdit({ id: 1, notes: 'x'.repeat(501) }, cfg), /500/)
  assert.throws(() => validateEdit({ id: 1, admin: true }, cfg), /champ inconnu/)
  assert.deepEqual(validateEdit({ id: 1, name: 'Salon.lan', type: 'tv', location: ' salon ', hostId: null }, cfg),
    { name: 'Salon', type: 'tv', location: 'salon', host_id: null, host_src: 'user' }) // intended dissociation, which holds
  assert.ok(DEVICE_TYPES.includes('phone'))
  // final rule: a single list; edit and restore without a reason
  assert.deepEqual([...REASON_REQUIRED].sort(), ['ack', 'addRule', 'confirm', 'delete', 'detach', 'dismiss', 'link', 'merge', 'removeRule', 'unlink', 'unwatch'])
})

test('edit: input, host already linked refused (409), event with the previous values', () => {
  const b = bench()
  const d = b.byName('poste-1')
  b.W.edit({ id: d.id, name: 'Poste salon', location: 'salon' }, who)
  const after = b.ns.device(d.id)
  assert.deepEqual([after.name, after.location, after.updated_by], ['Poste salon', 'salon', who.by])
  const ev = b.store.db.prepare("SELECT detail, actor FROM net_events WHERE type = 'edited'").get()
  assert.deepEqual(JSON.parse(ev.detail), { name: null, location: null })
  assert.throws(() => b.W.edit({ id: d.id, hostId: GUESTS[0].id }, who), e => e.status === 409)
  assert.deepEqual(b.audits().map(a => [a.action, a.ok]), [['network: edit', 1], ['network: edit', 0]])
})

test('"Connu": reason required, replayed → already handled without a new audit', () => {
  const b = bench()
  const d = b.byName('poste-2')
  assert.throws(() => b.W.ack({ ids: [d.id] }, who), /motif/)
  const r = b.W.ack({ ids: [d.id], reason: 'poste du bureau' }, who)
  assert.deepEqual([r.done, r.already], [[d.id], []])
  const after = b.ns.device(d.id)
  assert.deepEqual([after.state, after.review, after.acked_by], ['known', 0, who.by])
  const again = b.W.ack({ ids: [d.id], reason: 'poste du bureau' }, who)
  assert.deepEqual([again.done, again.already], [[], [d.id]])
  assert.deepEqual(b.audits().map(a => [a.action, a.ok]), [['network: known', 0], ['network: known', 1]])
})

test('full merge then undone by "Détacher"; refusals', () => {
  const b = bench()
  const into = b.byName('poste-4')
  const from = b.byName('poste-5')
  b.W.edit({ id: from.id, location: 'cuisine', notes: 'saisie de from' }, who)
  b.W.edit({ id: into.id, notes: 'saisie de into' }, who)
  const fromMac = from.primary_mac
  b.W.merge({ into: into.id, from: [from.id], reason: 'même appareil' }, who)
  const s = b.ns.load()
  assert.equal(s.devices.has(from.id), false)
  const m = s.macs.get(fromMac)
  assert.deepEqual([m.device_id, m.attach, m.confirmed_by], [into.id, 'merge', who.by])
  assert.equal(s.seen.get(`${fromMac}|pihole`).mac, fromMac) // the view follows the MAC
  const merged = b.ns.device(into.id)
  assert.deepEqual([merged.location, merged.notes], ['cuisine', 'saisie de into']) // inputs of into kept
  const ev = JSON.parse(b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'merged'").get().detail)
  assert.deepEqual(ev.from[0], { id: from.id, macs: [fromMac], saisie: { name: null, type: null, location: 'cuisine', notes: 'saisie de from', host_id: null } })
  // undo: the MAC goes back to a new "new" record (no alert: origin detach)
  const d = b.W.detachMac({ mac: fromMac, reason: 'erreur de fusion' }, who)
  const nd = b.ns.device(d.device)
  assert.deepEqual([nd.state, nd.origin, b.ns.load().macs.get(fromMac).attach], ['new', 'detach', 'detached'])
  // refusals: into itself, archived, different hosts, identity MAC, only MAC
  assert.throws(() => b.W.merge({ into: into.id, from: [into.id], reason: 'test test' }, who), /elle-même/)
  const g1 = b.byName(`invite-${GUESTS[0].id}`)
  const g2 = b.byName(`invite-${GUESTS[1].id}`)
  assert.throws(() => b.W.merge({ into: g1.id, from: [g2.id], reason: 'test test' }, who), /hôtes différents/)
  assert.throws(() => b.W.merge({ into: into.id, from: [g1.id], reason: 'test test' }, who), /identité/)
  assert.throws(() => b.W.detachMac({ mac: g1.primary_mac, reason: 'test test' }, who), /identité/)
  assert.throws(() => b.W.detachMac({ mac: nd.primary_mac, reason: 'test test' }, who), e => e.status === 409) // already detached
  assert.throws(() => b.W.detachMac({ mac: b.byName('poste-7').primary_mac, reason: 'test test' }, who), /seule MAC/)
  assert.ok(b.audits().filter(a => !a.ok).length >= 5)
})

test('MAC rules: safeguards; validated family with merge; confirm a pending MAC', () => {
  const b = bench()
  // bc:24:11-like: a prefix covering an identity MAC is refused; no more ignore action
  assert.throws(() => b.W.addRule({ prefix: GUESTS[5].mac.slice(0, 8), action: 'attach', deviceId: 21, name: 'X-Nom', reason: 'test test' }, who), /identité/)
  assert.throws(() => b.W.addRule({ prefix: 'fe:00:00', action: 'ignore', reason: 'test test' }, who), e => e.status === 400 && /attach seulement/.test(e.message))
  const broad = [...b.ns.load().devices.values()].filter(d => d.disp_name === 'Tab-Exemple').sort((x, y) => x.id - y.id)
  assert.equal(broad.length, 5)
  assert.throws(() => b.W.addRule({ prefix: 'fe:00', action: 'attach', deviceId: broad[0].id, reason: 'test test' }, who), /3 octets/)
  const guest = b.byName(`invite-${GUESTS[6].id}`)
  assert.throws(() => b.W.addRule({ prefix: 'fe:00:00', action: 'attach', deviceId: guest.id, name: 'Tab-Exemple', reason: 'test test' }, who), /liée à un hôte/)
  // a family without a DHCP name: refused (the prefix alone is public)
  assert.throws(() => b.W.addRule({ prefix: 'fe:00:00', action: 'attach', deviceId: broad[0].id, reason: 'test test' }, who), e => e.status === 400 && /exige le nom/.test(e.message))
  const r = b.W.addRule({ prefix: 'fe:00:00', action: 'attach', deviceId: broad[0].id, name: 'Tab-Exemple', mergeDevices: broad.map(d => d.id), reason: 'TAB qui tourne' }, who)
  const s = b.ns.load()
  assert.equal([...s.devices.values()].filter(d => d.disp_name === 'Tab-Exemple').length, 1)
  assert.equal([...s.macs.values()].filter(m => m.device_id === broad[0].id).length, 5)
  assert.deepEqual(s.rules.map(x => [x.prefix, x.action, x.device_id, x.name]), [['fe:00:00', 'attach', broad[0].id, 'Tab-Exemple']])
  // lifting a rule: reason required too (final rule)
  assert.throws(() => b.W.removeRule({ id: r.id }, who), /motif obligatoire/)
  b.W.removeRule({ id: r.id, reason: 'famille mal choisie' }, who)
  assert.equal(b.ns.load().rules.length, 0)
  assert.throws(() => b.W.removeRule({ id: r.id, reason: 'famille mal choisie' }, who), e => e.status === 404)
  // confirm: pending MAC → confirmed, record no longer "to review"; replay → 409
  const host = b.byName('poste-6')
  b.ns.applyOps([{ op: 'upsertMac', mac: '0a:00:00:00:5b:01', device: host.id, grade: 'weak', random: 1, first_seen: T, last_seen: T, attach: 'name' },
    { op: 'updateDevice', device: host.id, fields: { review: 1 } }])
  b.W.confirmMac({ mac: '0a:00:00:00:5b:01', reason: 'même tablette' }, who)
  assert.equal(b.ns.load().macs.get('0a:00:00:00:5b:01').confirmed_by, who.by)
  assert.equal(b.ns.device(host.id).review, 0)
  assert.throws(() => b.W.confirmMac({ mac: '0a:00:00:00:5b:01', reason: 'même tablette' }, who), e => e.status === 409)
  // dismiss a suggestion
  b.W.dismiss({ key: 'family:fe:00:00:tab-exemple', reason: 'pas maintenant' }, who)
  assert.deepEqual(JSON.parse(b.store.kv.get('network.dismissed')), ['family:fe:00:00:tab-exemple'])
  assert.throws(() => b.W.dismiss({ key: 'autre', reason: 'test test' }, who), /suggestion invalide/)
})

test('after a merge: alerts of the vanished records resolved; conflicting links → 409; error after writing', async () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const net = createNetwork({ cfg, store, audit: createAudit(store), now: () => T, log: { warn() {}, error() {} } })
  const into = [...ns.load().devices.values()].find(d => d.disp_name === 'poste-9')
  const from = [...ns.load().devices.values()].find(d => d.disp_name === 'poste-10')
  // two records that each have a topology link: clean 409, nothing written, refusal logged
  ns.applyOps([{ op: 'insertLink', device: into.id, parent: 'internet', kind: 'uplink', by: 'test', ts: T },
    { op: 'insertLink', device: from.id, parent: 'internet', kind: 'uplink', by: 'test', ts: T }])
  assert.throws(() => net.writes.merge({ into: into.id, from: [from.id], reason: 'même appareil' }, who), e => e.status === 409)
  assert.ok(ns.device(from.id))
  store.db.prepare("UPDATE net_links SET removed_at = ? WHERE child = ?").run(T, `dev:${from.id}`)
  // the engine evaluation fails afterwards: the write is done and answers OK
  let evaluated = 0
  net.onWrite(() => {
    evaluated++
    throw new Error('moteur en panne')
  })
  const r = net.writes.merge({ into: into.id, from: [from.id], reason: 'même appareil' }, who)
  assert.equal(r.id, into.id)
  assert.equal(evaluated, 1)
  assert.deepEqual(store.db.prepare("SELECT ok FROM audit WHERE action = 'network: merge' ORDER BY id").all().map(x => x.ok), [0, 1])
  // net_new of the absorbed record: emitted one last time as false
  assert.equal(net.signals(T).find(s => s.key === `net_new:${from.id}`).cond, false)
})

test('host dissociation: holds over 3 readings; manual reassociation → link restored', () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T })
  const guest = [...ns.load().devices.values()].find(d => d.host_id === GUESTS[3].id)
  W.edit({ id: guest.id, hostId: null }, who)
  assert.deepEqual([ns.device(guest.id).host_id, ns.device(guest.id).host_src], [null, 'user'])
  let flood = emptyFlood()
  for (let i = 1; i <= 3; i++) {
    const t = T + i * 5 * MIN
    const m = mergeSightings({ ...ns.load(), flood }, [
      { mac: GUESTS[3].mac, ip: GUESTS[3].ip, source: 'pve', ts: t, presence: false, hostId: GUESTS[3].id, name: `invite-${GUESTS[3].id}` },
      { mac: GUESTS[3].mac, ip: GUESTS[3].ip, source: 'pihole', ts: t, presence: true },
    ], { cfg, now: t })
    ns.applyOps(m.ops)
    flood = m.flood
    assert.deepEqual([ns.device(guest.id).host_id, ns.device(guest.id).host_src], [null, 'user'], `poll ${i}`)
  }
  assert.equal(ns.load().macs.get(GUESTS[3].mac).device_id, guest.id) // the Proxmox MAC stays on the record
  W.edit({ id: guest.id, hostId: GUESTS[3].id }, who)
  assert.deepEqual([ns.device(guest.id).host_id, ns.device(guest.id).host_src], [GUESTS[3].id, 'user'])
})

test('write and audit in the same transaction: an impossible audit rolls back the write', () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  let calls = 0
  const audit = { log: () => { if (++calls === 1) throw new Error('disque plein') } }
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit, now: () => T })
  const d = [...ns.load().devices.values()].find(x => x.disp_name === 'poste-8')
  assert.throws(() => W.delete({ ids: [d.id], reason: 'bruyant' }, who), /disque plein/)
  assert.equal(ns.device(d.id).state, 'known') // nothing written: the record is still there
  assert.equal(calls, 2) // the refusal is logged separately
})

test('profile, expected IP, offline alert and severity; unchecking an active alert requires a reason', () => {
  const cfg = prodConfig()
  const { store, ns } = prodLikeStore({ T })
  let firing = false
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T, isFiring: key => firing && key.startsWith('net_down:') })
  const d = [...ns.load().devices.values()].find(x => x.disp_name === 'poste-3')
  W.edit({ id: d.id, profile: 'sleepy', expectedIp: '192.0.2.102', alertDown: true, alertSeverity: 'critical' }, who)
  assert.deepEqual(['profile', 'expected_ip', 'alert_down', 'alert_severity'].map(k => ns.device(d.id)[k]), ['sleepy', '192.0.2.102', 1, 'critical'])
  // refusals: values outside the list, IP outside the LAN, boolean expected
  for (const body of [{ profile: 'always' }, { expectedIp: '198.51.100.1' }, { expectedIp: '192.0.2.300' }, { alertDown: 1 }, { alertSeverity: 'urgent' }]) {
    assert.throws(() => W.edit({ id: d.id, ...body }, who), e => e.status === 400, JSON.stringify(body))
  }
  // reset: null everywhere
  W.edit({ id: d.id, profile: null, expectedIp: null, alertSeverity: null }, who)
  assert.deepEqual(['profile', 'expected_ip', 'alert_severity'].map(k => ns.device(d.id)[k]), [null, null, null])
  // unchecking while net_down is active: 400 without a reason, accepted with one, reason in the event
  firing = true
  assert.throws(() => W.edit({ id: d.id, alertDown: false }, who), e => e.status === 400 && /motif/.test(e.message))
  assert.equal(ns.device(d.id).alert_down, 1)
  W.edit({ id: d.id, alertDown: false, reason: 'appareil débranché pour de bon' }, who)
  assert.equal(ns.device(d.id).alert_down, 0)
  const ev = store.db.prepare("SELECT detail FROM net_events WHERE device_id = ? AND type = 'edited' ORDER BY id DESC").get(d.id)
  assert.match(ev.detail, /"motif":"appareil débranché pour de bon"/)
  // no active alert: no reason needed
  firing = false
  W.edit({ id: d.id, alertDown: true }, who)
  W.edit({ id: d.id, alertDown: false }, who)
  assert.equal(ns.device(d.id).alert_down, 0)
})

// --- 409 message of the identity host, map parent from the record
test('host already linked → 409, exact message; hostile name literal, without control characters, capped at 32, full instruction', () => {
  const b = bench()
  const d = b.byName('poste-1')
  const g = GUESTS[0]
  const guest = [...b.ns.load().devices.values()].find(x => x.host_id === g.id)
  const host = b.cfg.hosts.find(h => h.id === g.id)
  const err = (() => { try { b.W.edit({ id: d.id, hostId: g.id }, who) } catch (e) { return e } })()
  assert.equal(err.status, 409)
  assert.equal(err.message, `${host.name} est déjà la fiche ${guest.id} (${guest.disp_name}) : un hôte ne correspond qu'à une seule fiche. Pour placer cet appareil sous ${host.name} sur la carte, utilisez « Parent sur la carte ».`)
  // hostile display name, with a control character
  b.store.db.prepare('UPDATE net_devices SET disp_name = ? WHERE id = ?').run('<img src=x onerror=alert(1)>\u0007\u001b[31m', guest.id)
  const e2 = (() => { try { b.W.edit({ id: d.id, hostId: g.id }, who) } catch (e) { return e } })()
  assert.equal(e2.status, 409)
  assert.ok(e2.message.includes('(<img src=x onerror=alert(1)>[31m)'), e2.message)
  assert.doesNotMatch(JSON.stringify({ error: e2.message }), /\\u00(0|1)|\\u007f/)
  // long hostile name: capped at 32 ("…"), the instruction is never cut
  b.store.db.prepare('UPDATE net_devices SET disp_name = ? WHERE id = ?').run(`<script>\u0007${'x'.repeat(250)}`, guest.id)
  const e3 = (() => { try { b.W.edit({ id: d.id, hostId: g.id }, who) } catch (e) { return e } })()
  assert.equal(e3.status, 409)
  assert.ok(e3.message.includes(`(<script>${'x'.repeat(23)}…)`), e3.message)
  assert.ok(e3.message.endsWith('utilisez « Parent sur la carte ».'), e3.message)
  assert.ok(e3.message.length <= 260)
  assert.doesNotMatch(JSON.stringify({ error: e3.message }), /\\u00(0|1)|\\u007f/)
})

test('link entered from the record then removed → the service parent comes back; replacement refused then restored', () => {
  const b = bench()
  // speedtest service declared on g1, literal URL = IP of the speedtest record (confirmed MACs)
  b.cfg.services.push({ id: 'speedtest', name: 'speedtest', host: GUESTS[0].id, url: 'http://192.0.2.193/', checks: [] })
  const sp = b.byName('speedtest')
  const parentOf = () => effectiveParents({ cfg: b.cfg, devices: b.ns.load().devices, links: b.ns.load().links, macs: b.ns.load().macs, gateway: '192.0.2.40' }).parents.get(`dev:${sp.id}`)
  assert.deepEqual([parentOf().parent, parentOf().origin, parentOf().originService], [`host:${GUESTS[0].id}`, 'service', 'speedtest'])
  const l1 = b.W.link({ child: `dev:${sp.id}`, parent: 'host:a1', kind: 'wifi', port: 'p1', note: 'au salon', reason: 'branché au salon' }, who)
  assert.deepEqual([parentOf().parent, parentOf().origin], ['host:a1', 'manual'])
  b.W.unlink({ id: l1.id, reason: 'débranché' }, who)
  assert.deepEqual([parentOf().parent, parentOf().origin], [`host:${GUESTS[0].id}`, 'service'])
  // service link → cycle: host:g1 under dev:speedtest refused (400)
  assert.throws(() => b.W.link({ child: `host:${GUESTS[0].id}`, parent: `dev:${sp.id}`, kind: 'other', reason: 'essai essai' }, who), e => e.status === 400 && /cycle/.test(e.message))
  // one-step replacement (UI sequence): remove, links refused (cycle), restore
  b.W.link({ child: 'host:a2', parent: `dev:${sp.id}`, kind: 'other', reason: 'switch derrière' }, who)
  const l2 = b.W.link({ child: `dev:${sp.id}`, parent: 'host:a1', kind: 'wifi', port: 'p1', note: 'au salon', reason: 'branché au salon' }, who)
  const before = b.audits().length
  const reason = 'nouvel emplacement'
  b.W.unlink({ id: l2.id, reason }, who)
  assert.throws(() => b.W.link({ child: `dev:${sp.id}`, parent: 'host:a2', kind: 'uplink', reason }, who), e => e.status === 400)
  b.W.link({ child: `dev:${sp.id}`, parent: 'host:a1', kind: 'wifi', port: 'p1', note: 'au salon', reason: `${reason} (restauration)` }, who)
  const after = b.audits().slice(before)
  assert.deepEqual(after.map(a => [a.action, a.ok]), [['network: unlink', 1], ['network: link', 0], ['network: link', 1]])
  const active = b.ns.load().links.filter(l => l.child === `dev:${sp.id}`)
  assert.deepEqual(active.map(l => [l.parent, l.kind, l.port, l.note]), [['host:a1', 'wifi', 'p1', 'au salon']])
})

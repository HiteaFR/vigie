// Persisted codes (lib/codes.js): written in English; a database written by an earlier version
// keeps its French codes, never rewritten, and every reader maps them to the current value. These
// tests use databases holding the former values and check that the behavior and the displayed
// labels are those of before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  AUDIT, NET_VERB, netAction, auditLabel, auditAction, auditActionValues, auditRow, AUDIT_DETAIL, silenceDetail,
  DROPPED, droppedCode, KNOWN_BY_BOOTSTRAP, knownBy, KV, kvGet, eventDetail, MIGRATION_ACTOR, PROXY_NO_XFF,
} from '../lib/codes.js'
import { arpDetail, arpKey, arpConflict, whyDetail, macAddedDetail, probedDetail, returnedDetail, detachedDetail, newDetail, isIpHandover, isAdminProbe, eventText } from '../lib/network/events.js'
import { createAudit, createAuth } from '../lib/auth.js'
import { createAgentMemory } from '../lib/agentmemory.js'
import { openDb } from '../lib/db.js'
import { setLocale } from '../lib/i18n.js'
import { tmpDir } from './tmpdir.js'

const inEnglish = fn => {
  setLocale('en')
  try {
    return fn()
  } finally {
    setLocale('fr')
  }
}
// former values (French) of each action, as an older version wrote them
const OLD_ACTIONS = {
  'fin de silence': AUDIT.SILENCE_END, 'rafraîchir': AUDIT.REFRESH, 'connexion': AUDIT.LOGIN, 'déconnexion': AUDIT.LOGOUT,
  'refusé': AUDIT.REFUSED, 'écart accepté': AUDIT.POSTURE_ACCEPT, 'acceptation retirée': AUDIT.POSTURE_UNACCEPT,
  'port connu': AUDIT.PORT_KNOWN, 'décision MAJ': AUDIT.UPDATE_DECISION, 'décision MAJ levée': AUDIT.UPDATE_DECISION_LIFT,
  'réseau : modifier': netAction(NET_VERB.EDIT), 'réseau : connu': netAction(NET_VERB.KNOWN), 'réseau : supprimer': netAction(NET_VERB.DELETE),
  'réseau : lier': netAction(NET_VERB.LINK), 'réseau : délier': netAction(NET_VERB.UNLINK), 'réseau : fusionner': netAction(NET_VERB.MERGE),
  'réseau : même appareil': netAction(NET_VERB.SAME_DEVICE), 'réseau : détacher': netAction(NET_VERB.DETACH),
  'réseau : règle de MAC': netAction(NET_VERB.MAC_RULE), 'réseau : lever la règle': netAction(NET_VERB.LIFT_RULE),
  'réseau : sonder': netAction(NET_VERB.PROBE), 'réseau : sonder tout': netAction(NET_VERB.PROBE_ALL),
  'réseau : écarter une suggestion': netAction(NET_VERB.DISMISS), 'réseau : ignorer': netAction(NET_VERB.IGNORE),
  'réseau : purge R4': netAction(NET_VERB.PURGE_R4),
}

test('audit codes: English values; each former value maps to its new code, and both display the same label (fr: the former text, en: the catalog)', () => {
  assert.deepEqual({ ...AUDIT }, {
    ACK: 'ack', UNACK: 'unack', SILENCE: 'silence', SILENCE_END: 'silence end', REFRESH: 'refresh', LOGIN: 'login', LOGOUT: 'logout',
    REFUSED: 'refused', POSTURE_ACCEPT: 'deviation accepted', POSTURE_UNACCEPT: 'acceptance withdrawn', PORT_KNOWN: 'port known',
    UPDATE_DECISION: 'update decision', UPDATE_DECISION_LIFT: 'update decision lifted',
  })
  assert.equal(netAction(NET_VERB.SAME_DEVICE), 'network: same device')
  // every current code has a former value (none forgotten), and the table is one-to-one
  const current = [...Object.values(AUDIT).filter(a => !['ack', 'unack', 'silence'].includes(a)), ...Object.values(NET_VERB).map(netAction)]
  assert.deepEqual([...new Set(Object.values(OLD_ACTIONS))].sort(), current.sort())
  for (const [old, now] of Object.entries(OLD_ACTIONS)) {
    assert.equal(auditAction(old), now, old)
    assert.equal(auditLabel(old), old, `fr label of ${old}: the former text, as before`)
    assert.equal(auditLabel(now), old, `fr label of ${now}`)
    assert.equal(inEnglish(() => auditLabel(old)), inEnglish(() => auditLabel(now)), now)
    assert.ok(auditActionValues(now).includes(old) && auditActionValues(now)[0] === now, now)
  }
  // unchanged codes and unknown actions: as they are
  for (const a of ['ack', 'unack', 'silence', 'GET /api/audit', 'action d\'un plugin']) assert.equal(auditAction(a), a)
  assert.deepEqual(inEnglish(() => ['rafraîchir', 'réseau : purge R4', 'connexion'].map(auditLabel)), ['refresh', 'network: legacy states purge', 'login'])
})

test('/api/audit rows: the former codes of an old row (action, target, detail, actor) come back at their new value; new rows unchanged', t => {
  const store = openDb(tmpDir('p5c-audit-', t))
  t.after(() => store.db.close())
  const ins = store.db.prepare('INSERT INTO audit (at, actor, source, action, target, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
  ins.run(1, 'migration:r4', 'script', 'réseau : purge R4', 'dev:3', 'purge R4 : archivée', 1)
  ins.run(2, 'tg:7', 'telegram', 'réseau : connu', '3 appareils', 'déjà traité', 0)
  ins.run(3, 'admin', 'ui', 'réseau : sonder tout', 'réseau', 'motif', 1)
  ins.run(4, 'admin', 'ui', 'réseau : lier', 'lien:dev:3', 'a → b', 1)
  ins.run(5, 'proxy-sans-xff', 'ui', 'connexion', null, 'compte ou chat non autorisé', 0)
  ins.run(6, 'admin', 'ui', 'silence', 'hôte vps', "migration (jusqu'à 2026-11-13T10:00:00.000Z)", 1)
  ins.run(7, 'admin', 'ui', 'silence', 'règle x', 'gelé (sans fin)', 1)
  const audit = createAudit(store, { tickMs: 0 })
  audit.log({ actor: 'admin', source: 'ui', action: AUDIT.SILENCE, target: 'règle y', detail: silenceDetail('gelé', null), at: 8 })
  const rows = audit.list(20).map(auditRow).sort((a, b) => a.at - b.at).map(r => [r.actor, r.action, r.target, r.detail])
  assert.deepEqual(rows, [
    [MIGRATION_ACTOR, 'network: legacy states purge', 'dev:3', 'purge R4 : archivée'],
    ['tg:7', 'network: known', '3 devices', AUDIT_DETAIL.ALREADY],
    ['admin', 'network: probe all', 'network', 'motif'],
    ['admin', 'network: link', 'link:dev:3', 'a → b'],
    [PROXY_NO_XFF, 'login', null, AUDIT_DETAIL.UNAUTHORIZED],
    ['admin', 'silence', 'hôte vps', 'migration (until 2026-11-13T10:00:00.000Z)'],
    ['admin', 'silence', 'règle x', 'gelé (no end)'],
    ['admin', 'silence', 'règle y', 'gelé (no end)'],
  ])
  // the route returns the normalized row and its label, computed from the stored code
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /res\.json\(audit\.list\(200\)\.map\(r => \(\{ \.\.\.auditRow\(r\), label: auditLabel\(r\.action\) \}\)\)\)/)
})

test('login lock: an IP that logged in under the former code ("connexion") is still known, like one that logged in under "login"', t => {
  const store = openDb(tmpDir('p5c-lock-', t))
  t.after(() => store.db.close())
  const T = Date.parse('2026-11-13T10:00:00Z')
  const ins = store.db.prepare('INSERT INTO audit (at, actor, source, action, target, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
  ins.run(T - 86400_000, '192.0.2.10', 'ui', 'connexion', null, null, 1)
  ins.run(T - 86400_000, '192.0.2.11', 'ui', 'login', null, null, 1)
  ins.run(T - 86400_000, '192.0.2.12', 'ui', 'connexion', null, null, 0)
  ins.run(T - 86400_000, '192.0.2.13', 'ui', 'déconnexion', null, null, 1)
  const auth = createAuth({ store, audit: createAudit(store), env: {}, now: () => T, log: { log() {}, warn() {}, error() {} } })
  assert.deepEqual(['192.0.2.10', '192.0.2.11', '192.0.2.12', '192.0.2.13', '192.0.2.14'].map(auth.isKnown), [true, true, false, false, false])
})

test('outbox: rows dropped under a former code are never sent again; dry-run (unchanged value) still excluded', () => {
  assert.deepEqual({ ...DROPPED }, { EXPIRED: 'expired', REJECTED: 'rejected', FILTERED: 'filtered', DRY_RUN: 'dry-run' })
  assert.deepEqual(['expiré', 'rejeté', 'filtré', 'dry-run', 'expired', null].map(droppedCode), ['expired', 'rejected', 'filtered', 'dry-run', 'expired', null])
  // readers only test IS NULL and DRY_RUN: no literal of a dropped code in the notifier
  const src = fs.readFileSync(new URL('../lib/notify/notifier.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /dropped (?:=|<>|IN) '(?!\$\{DROPPED\.DRY_RUN\})/)
  assert.match(src, /o\.dropped <> '\$\{DROPPED\.DRY_RUN\}'/)
})

test('host_ports: a port known at bootstrap under the former value ("amorçage") is still a bootstrap port', t => {
  assert.equal(KNOWN_BY_BOOTSTRAP, 'bootstrap')
  assert.deepEqual(['amorçage', 'bootstrap', 'admin', null].map(knownBy), ['bootstrap', 'bootstrap', 'admin', null])
  const store = openDb(tmpDir('p5c-ports-', t))
  t.after(() => store.db.close())
  const ins = store.db.prepare('INSERT INTO host_ports (host, proto, port, first_seen, last_seen, closed_at, known_at, known_by, known_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  ins.run('h1', 'tcp', 22, 1, 1, null, 1, 'amorçage', null)
  ins.run('h1', 'tcp', 80, 1, 1, null, 1, 'admin', 'web')
  const mem = createAgentMemory({ db: store.db, kv: store.kv, hostIds: ['h1'] })
  const listening = [{ proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd' }, { proto: 'tcp', addr: '0.0.0.0', port: 80, process: 'nginx' }]
  const ports = mem.portsView('h1', listening).map(p => [p.port, p.known?.bootstrap, p.known?.by])
  assert.deepEqual(ports, [[22, true, 'bootstrap'], [80, false, 'admin']])
})

test('kv: a key written under its former name is read when the new one is absent; the new one wins', () => {
  const m = new Map()
  const kv = { get: k => m.get(k) }
  assert.deepEqual({ ...KV }, { IP_HANDOVER: 'network.ipHandover', LEGACY_PURGE: 'network.legacyPurge', LEGACY_PURGE_DIGESTED: 'network.legacyPurgeDigested' })
  m.set('network.l1', 'old').set('network.purgeR4', 'p').set('network.purgeR4Digested', 'd')
  assert.deepEqual([kvGet(kv, KV.IP_HANDOVER), kvGet(kv, KV.LEGACY_PURGE), kvGet(kv, KV.LEGACY_PURGE_DIGESTED)], ['old', 'p', 'd'])
  m.set('network.ipHandover', 'new')
  assert.equal(kvGet(kv, KV.IP_HANDOVER), 'new')
  assert.equal(kvGet(kv, 'network.other'), undefined)
})

test('net_events: English formats written, read back by the code (keys, IP handover, admin probe)', () => {
  const M = '00:00:5e:00:53:01'
  const N = '00:00:5e:00:53:02'
  assert.equal(arpDetail.header(M, N), `MAC ${M}: Ethernet header ${N}`)
  assert.equal(arpDetail.dup(M, 1), `MAC ${M}: 1 duplicate reply`)
  assert.equal(arpDetail.dup(M, 3), `MAC ${M}: 3 duplicate replies`)
  assert.equal(arpDetail.ip('192.0.2.9', [M, N]), `IP 192.0.2.9: 2 MAC (${M}, ${N})`)
  assert.equal(arpDetail.wide(M, 7), `MAC ${M}: answers for 7 IP`)
  assert.equal(whyDetail.ipHandover('192.0.2.9'), 'IP handover: same IP 192.0.2.9 (macvlan range, handover at scan)')
  assert.equal(whyDetail.pending(whyDetail.agent('web', 'docker-a', 'lan')), 'agent: container web on docker-a (network lan), pending')
  assert.equal(probedDetail('admin', 1, 0, 0, 12), 'admin · 1 open port · HTTP: 0 requests, 0 4xx · 12 ms')
  assert.equal(returnedDetail(M, '2026-10-20 09:00', 'motif'), `${M} returned after deletion on 2026-10-20 09:00: motif`)
  assert.equal(detachedDetail(M, 12, 'motif'), `${M} → record 12: motif`)
  assert.equal(newDetail('scan', true), 'scan, bootstrap')
  // old and new detail of the same fact: same key, same marker
  assert.equal(arpKey(arpDetail.ip('192.0.2.9', [M, N])), 'IP 192.0.2.9')
  assert.equal(arpKey(`IP 192.0.2.9 : 2 MAC (${M}, ${N})`), 'IP 192.0.2.9')
  assert.equal(arpKey(`MAC ${M} : répond pour 7 IP`), arpKey(arpDetail.wide(M, 7)))
  assert.equal(isIpHandover(macAddedDetail(M, whyDetail.ipHandover('192.0.2.9'))), true)
  assert.equal(isIpHandover(`${M} : L1 : même IP 192.0.2.9 (plage macvlan, passation au balayage)`), true)
  assert.equal(isIpHandover(macAddedDetail(M, whyDetail.sameIp('192.0.2.9'))), false)
  assert.equal(isIpHandover(`${M} : même IP 192.0.2.9 (plage macvlan)`), false)
  assert.equal(isAdminProbe(probedDetail('admin (192.0.2.1)', 0, 0, 0, 1)), true)
  assert.equal(isAdminProbe('admin (192.0.2.1) · 0 port ouvert · HTTP : 0 requête, 0 en 4xx · 1 ms'), true)
  assert.equal(isAdminProbe('planned · 0 port ouvert · HTTP : 0 requête, 0 en 4xx · 1 ms'), false)
})

test('net_events: an old row of each format displays exactly as before (fr: the former text, en: the catalog), and like the same fact written today', () => {
  const M = '00:00:5e:00:53:01'
  // [type, detail written by an earlier version, same fact written today, English display]
  const rows = [
    ['arp_conflict', `MAC ${M} : en-tête Ethernet 00:00:5e:00:53:02`, arpDetail.header(M, '00:00:5e:00:53:02'), `MAC ${M}: Ethernet header 00:00:5e:00:53:02`],
    ['arp_conflict', `MAC ${M} : 1 réponse en double`, arpDetail.dup(M, 1), `MAC ${M}: 1 duplicate reply`],
    ['arp_conflict', `MAC ${M} : 4 réponses en double`, arpDetail.dup(M, 4), `MAC ${M}: 4 duplicate replies`],
    ['arp_conflict', `IP 192.0.2.9 : 2 MAC (${M}, 00:00:5e:00:53:02)`, arpDetail.ip('192.0.2.9', [M, '00:00:5e:00:53:02']), `IP 192.0.2.9: 2 MACs (${M}, 00:00:5e:00:53:02)`],
    ['arp_conflict', `MAC ${M} : répond pour 6 IP`, arpDetail.wide(M, 6), `MAC ${M}: answers for 6 IPs`],
    ['mac_added', `${M} : L1 : même IP 192.0.2.9 (plage macvlan, passation au balayage)`, macAddedDetail(M, whyDetail.ipHandover('192.0.2.9')), `${M}: L1: same IP 192.0.2.9 (macvlan range, handover at scan)`],
    ['mac_added', `${M} : même IP 192.0.2.9 (plage macvlan)`, macAddedDetail(M, whyDetail.sameIp('192.0.2.9')), `${M}: same IP 192.0.2.9 (macvlan range)`],
    ['mac_added', `${M} : même nom « tel-a »`, macAddedDetail(M, whyDetail.sameName('tel-a')), `${M}: same name “tel-a”`],
    ['mac_added', `${M} : famille fe:00:00 « Tab »`, macAddedDetail(M, whyDetail.family('fe:00:00', 'Tab')), `${M}: family fe:00:00 “Tab”`],
    ['mac_added', `${M} : famille fe:00:00`, macAddedDetail(M, whyDetail.family('fe:00:00', null)), `${M}: family fe:00:00`],
    ['mac_added', `${M} : agent : conteneur web sur docker-a (réseau lan), en attente`, macAddedDetail(M, whyDetail.pending(whyDetail.agent('web', 'docker-a', 'lan'))), `${M}: agent: container web on docker-a (network lan), pending`],
    ['returned', `${M} revenue après suppression du 2026-10-20 09:00 : téléphone prêté`, returnedDetail(M, '2026-10-20 09:00', 'téléphone prêté'), `${M} back after deletion on 2026-10-20 09:00: téléphone prêté`],
    ['mac_detached', `${M} → fiche 12 : autre appareil`, detachedDetail(M, 12, 'autre appareil'), `${M} → device 12: autre appareil`],
    ['probed', 'admin · 1 port ouvert · HTTP : 0 requête, 0 en 4xx · 12 ms', probedDetail('admin', 1, 0, 0, 12), 'admin · 1 open port · HTTP: 0 requests, 0 in 4xx · 12 ms'],
    ['probed', 'planned · 3 ports ouverts · HTTP : 5 requêtes, 1 en 4xx · 900 ms', probedDetail('planned', 3, 5, 1, 900), 'planned · 3 open ports · HTTP: 5 requests, 1 in 4xx · 900 ms'],
    ['new', 'scan, amorçage', newDetail('scan', true), 'scan, bootstrap'],
    ['new', 'scan', newDetail('scan', false), 'scan'],
    ['ip_changed', '192.0.2.8 → 192.0.2.9', '192.0.2.8 → 192.0.2.9', '192.0.2.8 → 192.0.2.9'],
  ]
  for (const [type, old, now, en] of rows) {
    assert.equal(eventText(type, old), old, `fr, old row: the former text (${type})`)
    assert.equal(eventText(type, now), old, `fr, new row: same display (${type})`)
    assert.equal(eventDetail(type, old), now, `old detail read at the current format (${type})`)
    assert.equal(inEnglish(() => eventText(type, old)), en, type)
    assert.equal(inEnglish(() => eventText(type, now)), en, type)
  }
  // agent conflict, both shapes; a detail of another shape stays as it is
  const other = 'conteneur g1/web/lan : déjà associé à la fiche 4 ; rattachement par identité suspendu'
  const current = 'conteneur g1/web/lan : fiche déjà associée à g1/web/lan ; rattachement par identité suspendu'
  assert.deepEqual([eventText('agent_conflict', other), eventText('agent_conflict', current)], [other, current])
  for (const free of ['texte libre : sans format connu', 'IP 192.0.2.9 : autre chose']) assert.equal(eventText('arp_conflict', free), free)
  assert.equal(eventText('probed', null), null)
  // digest: MAC → record label, old and new detail
  const label = m => (m === M ? 'tel-a (fiche 3)' : m)
  const ip = { key: 'IP 192.0.2.9', text: '2 MAC (tel-a (fiche 3), 00:00:5e:00:53:02)' }
  assert.deepEqual(arpConflict(`IP 192.0.2.9 : 2 MAC (${M}, 00:00:5e:00:53:02)`, label), ip)
  assert.deepEqual(arpConflict(arpDetail.ip('192.0.2.9', [M, '00:00:5e:00:53:02']), label), ip)
  assert.equal(arpConflict('IP 192.0.2.9 : autre chose', label), null)
})

test('well-known ports by default: the client gets a boolean, never the stored code', () => {
  const client = fs.readFileSync(new URL('../../client/src/components/AgentSecurity.jsx', import.meta.url), 'utf8')
  assert.match(client, /p\.known && !p\.known\.bootstrap/)
  assert.doesNotMatch(client, /amorçage|'bootstrap'/)
  const srv = fs.readFileSync(new URL('../lib/agentmemory.js', import.meta.url), 'utf8')
  assert.match(srv, /bootstrap: knownBy\(row\.known_by\) === KNOWN_BY_BOOTSTRAP/)
})

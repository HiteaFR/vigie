// Network module: family and merge suggestions (lib/network/suggest.js). Real Tab-A1 case
// (anonymized): 5 records with rotating MACs, 4 of them with the same lastSeen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestFamilies, suggestMerges } from '../lib/network/suggest.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const DAY = 86400_000
function state(list) {
  const devices = new Map()
  const macs = new Map()
  list.forEach(([macsOf, f], i) => {
    const id = i + 1
    devices.set(id, { id, state: 'known', host_id: null, first_seen: T - (10 - i) * DAY, ...f })
    for (const m of macsOf) macs.set(m, { mac: m, device_id: id, grade: parseInt(m.slice(0, 2), 16) & 2 ? 'weak' : 'strong' })
  })
  return { devices, macs, attrs: new Map() }
}

test('Tab-A1 family: 5 records, same prefix and same name → 1 family, target seen first', () => {
  const s = state([
    ...[1, 2, 3, 4, 5].map(i => [[`ae:00:53:00:00:0${i}`], { disp_name: 'Tab-Exemple', last_seen: i < 5 ? T - 20 * DAY : T }]),
    [['00:00:5e:00:53:01'], { disp_name: 'Tab-Exemple' }], // strong MAC: never
  ])
  const f = suggestFamilies(s)
  assert.deepEqual(f, [{ kind: 'family', key: 'family:ae:00:53:tab-exemple', prefix: 'ae:00:53', name: 'Tab-Exemple', macs: 5, devices: [1, 2, 3, 4, 5] }])
  // no duplicate as a merge suggestion
  assert.deepEqual(suggestMerges(s), [])
  // dismissed: does not come back
  assert.deepEqual(suggestFamilies(s, { dismissed: ['family:ae:00:53:tab-exemple'] }), [])
})

test('family on a single renamed record: 7 MACs with the same prefix → proposed with the DISCOVERED name; validated or fewer than 3 MACs → nothing', () => {
  const macsOf = n => Array.from({ length: n }, (_, i) => `ae:00:53:00:00:0${i}`)
  const one = n => {
    const s = state([[macsOf(n), { name: 'Tablette', disp_name: 'Tablette' }]])
    s.attrs.set(1, [{ attr: 'name', source: 'dhcp', value: 'Tab-A1', rank: 6, seen_at: T }])
    return s
  }
  const s = one(7)
  assert.deepEqual(suggestFamilies(s), [{ kind: 'family', key: 'family:ae:00:53:tab-a1', prefix: 'ae:00:53', name: 'Tab-A1', macs: 7, devices: [1] }])
  assert.deepEqual(suggestFamilies(one(2)), [])
  assert.deepEqual(suggestFamilies({ ...s, rules: [{ action: 'attach', prefix: 'ae:00:53', name: 'tab-a1', device_id: 1 }] }), [])
  assert.equal(suggestFamilies({ ...s, rules: [{ action: 'attach', prefix: 'ae:00:53', name: 'Autre', device_id: 1 }] }).length, 1)
})

test('family: two records with the same discovered name, only one renamed → same family; single-record family: the merge stays proposed for another prefix', () => {
  const found = [{ attr: 'name', source: 'dhcp', value: 'Tab-A1', rank: 6, seen_at: T }]
  const s = state([
    [['ae:00:53:00:00:01', 'ae:00:53:00:00:02'], { name: 'Tablette', disp_name: 'Tablette' }],
    [['ae:00:53:00:00:03'], { disp_name: 'Tab-A1' }],
  ])
  s.attrs.set(1, found)
  s.attrs.set(2, found)
  assert.deepEqual(suggestFamilies(s).map(f => [f.name, f.macs, f.devices]), [['Tab-A1', 3, [1, 2]]])
  assert.deepEqual(suggestMerges(s), [])
  const t = state([
    [['ae:00:53:00:00:01', 'ae:00:53:00:00:02', 'ae:00:53:00:00:03'], { disp_name: 'Tab-A1' }],
    [['06:00:00:00:00:04'], { disp_name: 'Tab-A1' }],
  ])
  assert.deepEqual(suggestFamilies(t).map(f => f.devices), [[1]])
  assert.deepEqual(suggestMerges(t).map(f => f.devices), [[1, 2]])
})

test('merge: two "Galaxy" records with weak MACs; generic names, strong MACs, linked records → nothing', () => {
  const s = state([
    [['06:00:00:00:00:01'], { disp_name: 'Galaxy-Exemple' }],
    [['0a:00:00:00:00:02'], { disp_name: 'Galaxy-Exemple' }],
    [['06:00:00:00:00:03'], { disp_name: 'docker' }],
    [['0a:00:00:00:00:04'], { disp_name: 'docker' }],
    [['00:00:5e:00:53:05'], { disp_name: 'Portable' }],
    [['00:00:5e:00:53:06'], { disp_name: 'Portable' }],
    [['06:00:00:00:00:07'], { disp_name: 'Hote-Lie', host_id: 'x' }],
    [['0a:00:00:00:00:08'], { disp_name: 'Hote-Lie' }],
  ])
  assert.deepEqual(suggestMerges(s), [{ kind: 'merge', key: 'merge:galaxy-exemple', name: 'Galaxy-Exemple', devices: [1, 2] }])
  assert.deepEqual(suggestFamilies(s), [])
  assert.deepEqual(suggestMerges(s, { dismissed: ['merge:galaxy-exemple'] }), [])
})

// --- suggestions by the DISCOVERED name, warnings ----------------
const D0 = Date.parse('2026-10-27T00:00:00Z')
const H = (h, m = 0) => D0 + h * 3600_000 + m * 60_000
const PHONE = 'Phone-de-alex'
// records 45 (MAC A) and 52 (MAC B); name: entered by hand; found: discovered name attributes; views: presence views
function phoneState({ name45 = 'Téléphone Nico', name52 = null, found45 = [['dhcp', PHONE]], found52 = [['dhcp', PHONE]], arpA = H(9, 33), arpB = H(16, 0), lastA = H(16, 0), host52 = null } = {}) {
  const A = '0a:00:00:00:45:01'
  const B = '5a:00:00:00:d0:16'
  const dev = (id, name, found, mac, first, last, host) => ({
    id, name, disp_name: name ?? found.find(([s]) => s !== 'mdns')?.[1] ?? found[0]?.[1] ?? null, state: 'known', host_id: host, first_seen: first, last_seen: last, primary_mac: mac,
  })
  const devices = new Map([[45, dev(45, name45, found45, A, D0 - 10 * DAY, lastA, null)], [52, dev(52, name52, found52, B, H(13, 4), H(16, 0), host52)]])
  const macs = new Map([
    [A, { mac: A, device_id: 45, grade: 'weak', first_seen: D0 - 10 * DAY, last_seen: lastA }],
    [B, { mac: B, device_id: 52, grade: 'weak', first_seen: H(13, 4), last_seen: H(16, 0) }],
  ])
  const attrs = new Map([[45, found45.map(([source, value]) => ({ attr: 'name', source, value, rank: 6, seen_at: H(9) }))], [52, found52.map(([source, value]) => ({ attr: 'name', source, value, rank: 6, seen_at: H(13) }))]])
  const seen = new Map([
    [`${A}|arp`, { mac: A, source: 'arp', last_seen: arpA }], [`${A}|pihole`, { mac: A, source: 'pihole', last_seen: lastA }],
    [`${B}|arp`, { mac: B, source: 'arp', last_seen: arpB }],
  ])
  return { devices, macs, attrs, seen }
}

test('45 renamed by hand, 52 with the same discovered name, disjoint lifetimes (probe) → one merge:phone-de-alex suggestion without a warning', () => {
  const s = phoneState()
  assert.deepEqual(suggestMerges(s, { probe: 'on' }), [{ kind: 'merge', key: 'merge:phone-de-alex', name: PHONE, devices: [45, 52] }])
  // without a probe, A's lifetime is measured on last_seen (Pi-hole view moved forward to 16:00): overlap
  assert.deepEqual(suggestMerges(s, { probe: 'off' })[0].warnings.map(w => w.kind), ['overlap'])
})

test('different names entered by hand, same discovered name → suggestion with a "names" warning and the list of names', () => {
  const [sug] = suggestMerges(phoneState({ name52: 'PHONE bureau' }), { probe: 'on' })
  assert.equal(sug.key, 'merge:phone-de-alex')
  assert.deepEqual(sug.warnings, [{ kind: 'names', names: ['Téléphone Nico', 'PHONE bureau'], text: 'noms saisis différents : “Téléphone Nico”, “PHONE bureau” : vérifier avant de fusionner' }])
  // same name entered by hand (up to case): no warning
  assert.equal(suggestMerges(phoneState({ name52: 'téléphone nico' }), { probe: 'on' })[0].warnings, undefined)
})

test('presences overlapping in arp (probe) → "overlap" warning; with different names entered by hand → both', () => {
  const both = phoneState({ arpA: H(13, 30), name52: 'PHONE bureau' })
  const [sug] = suggestMerges(both, { probe: 'on' })
  assert.deepEqual(sug.devices, [45, 52])
  assert.deepEqual(sug.warnings.map(w => w.kind), ['names', 'overlap'])
  assert.equal(sug.warnings[1].text, 'vues en même temps : sans doute deux appareils')
  const [one] = suggestMerges(phoneState({ arpA: H(13, 30) }), { probe: 'on' })
  assert.deepEqual(one.warnings.map(w => w.kind), ['overlap'])
})

test('dismissed then renamed → still dismissed; name discovered in mdns only → does not group; linked record → excluded', () => {
  const dismissed = ['merge:phone-de-alex']
  assert.deepEqual(suggestMerges(phoneState({ name45: null }), { probe: 'on', dismissed }), [])
  assert.deepEqual(suggestMerges(phoneState({ name45: 'Autre nom' }), { probe: 'on', dismissed }), [])
  assert.deepEqual(suggestMerges(phoneState({ name45: 'Autre nom' }), { probe: 'on' }).map(x => x.key), ['merge:phone-de-alex'])
  // 52: name discovered only through mDNS (forgeable) → out of the group
  assert.deepEqual(suggestMerges(phoneState({ name45: null, found52: [['mdns', PHONE]] }), { probe: 'on' }), [])
  // 52 linked to a host: excluded
  assert.deepEqual(suggestMerges(phoneState({ host52: 'g1' }), { probe: 'on' }), [])
})

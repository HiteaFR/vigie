// Reduced OUI database: lookup of a universal prefix, local MAC without a vendor, Pi-hole
// takes precedence (rank 4 versus 2); parsing of the IEEE registry on trapped lines
// (untrusted data): dropped and counted, no crash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOui, ouiOf } from '../lib/network/oui.js'
import { parseOuiCsv } from '../scripts/update-oui.js'
import { mergeSightings, emptyFlood, bestAttr } from '../lib/network/merge.js'
import { prodConfig } from './network-fixture.js'
import { tmpDir } from './tmpdir.js'

const T = Date.parse('2026-10-21T10:00:00Z')

test('prefix lookup; local MAC → no vendor; versioned database loaded', () => {
  const f = path.join(tmpDir('dash-oui-'), 'oui.tsv')
  fs.writeFileSync(f, '00005e\tICANN, IANA Department\n240ac4\tEspressif Inc.\nmauvaise ligne\n')
  const lookup = createOui(f)
  assert.equal(lookup('00:00:5E:00:53:01'), 'ICANN, IANA Department')
  assert.equal(lookup('24-0a-c4-00-53-02'), 'Espressif Inc.')
  assert.equal(lookup('02:00:5e:00:53:01'), null) // U/L bit: local MAC
  assert.equal(lookup('00:11:22:33:44:55'), null)
  assert.equal(createOui('/nonexistent/oui.tsv')('00:00:5e:00:53:01'), null)
  // the repository's database: more than 30,000 prefixes, IANA present
  assert.equal(ouiOf('00:00:5e:00:53:01'), 'ICANN, IANA Department')
})

test('merge: OUI vendor at rank 2, Pi-hole takes precedence, never for a local MAC', () => {
  const cfg = prodConfig()
  const state = { devices: new Map(), macs: new Map(), seen: new Map(), attrs: new Map(), addresses: new Map(), rules: [], flood: emptyFlood() }
  const oui = mac => (mac.startsWith('00:00:5e') ? 'IANA (OUI)' : 'Constructeur local')
  const m = mergeSightings(state, [
    { mac: '00:00:5e:00:53:31', ip: '192.0.2.31', source: 'arp', ts: T, presence: true },
    { mac: '00:00:5e:00:53:32', ip: '192.0.2.32', source: 'pihole', ts: T, presence: true, vendor: 'Vendeur Pi-hole' },
    { mac: '06:00:00:00:53:33', ip: '192.0.2.33', source: 'arp', ts: T, presence: true },
  ], { cfg, now: T, oui })
  const attrs = m.ops.filter(o => o.op === 'upsertAttr' && o.attr === 'vendor')
  const byDev = new Map()
  for (const a of attrs) byDev.set(a.device, [...(byDev.get(a.device) ?? []), { ...a, seen_at: a.seen_at }])
  const best = [...byDev.values()].map(list => bestAttr(list, 'vendor').value).sort()
  assert.deepEqual(best, ['IANA (OUI)', 'Vendeur Pi-hole'])
  assert.ok(!attrs.some(a => a.value === 'Constructeur local'))
  assert.deepEqual([...new Set(attrs.filter(a => a.source === 'oui').map(a => a.rank))], [2])
})

test('parseOuiCsv: trapped lines dropped and counted, no crash', () => {
  const lines = [
    'Registry,Assignment,Organization Name,Organization Address',
    'MA-L,00005E,"ICANN, IANA Department","12025 Waterfront Drive Los Angeles CA US 90094"',
    'MA-L,00005,Cinq caractères,adresse', // 5-character prefix
    'MA-L,00005EF,Sept caractères,adresse', // 7 characters
    'MA-L,00Z05E,Non hexadécimal,adresse',
    'MA-L,AA0001,"Nom\u0007contrôle",adresse',
    'MA-L,AA0002,"<script>alert(1)</script>",adresse',
    'MA-L,AA0003,"",adresse', // empty name
    'MA-L,AA0004,"   ",adresse',
    `MA-L,AA0005,${'x'.repeat(100 * 1024)},adresse`, // 100 KB line
    'MA-L,AA0006,"Guillemets déséquilibrés,adresse',
    'MA-L,AA0007,"Nom coupé', // line break inside a name: the line is cut
    'suite du nom",adresse',
    'MA-S,AA0008,Autre registre,adresse',
    'MA-L,AA0009,"Nom avec tabulation\t",adresse', // trailing tab (real case): cleaned
    `MA-L,AA000A,${'Nom très long '.repeat(10)},adresse`,
  ]
  const r = parseOuiCsv(lines.join('\r\n'))
  assert.deepEqual([...r.entries.keys()], ['00005e', 'aa0009', 'aa000a'])
  assert.equal(r.entries.get('00005e'), 'ICANN, IANA Department')
  assert.equal(r.entries.get('aa0009'), 'Nom avec tabulation')
  assert.ok(r.entries.get('aa000a').length <= 40)
  assert.equal(r.rejected, 12) // the 12 trapped lines (the cut name counts as 2)
  assert.deepEqual(parseOuiCsv('').entries.size, 0)
})

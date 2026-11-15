// Forged ARP: multiple replies, different Ethernet header, more than 4 MACs per IP, a MAC
// that answers for everything; one arp_conflict event per IP or MAC and per 24 h, one
// digest line, no alert.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArp } from '../lib/network/sources/arp.js'
import { parseCidr } from '../lib/net/ip.js'
import { deviceLabel } from '../lib/network/merge.js'
import { r3Bench, FIXTURE_HOSTS, MIN } from './network-fixture.js'

const T = Date.parse('2026-10-21T08:00:00Z')
const cidrs = [parseCidr('192.0.2.0/24')]
const h = (ip, mac, o = {}) => ({ ip, mac, hdrmac: mac, dup: 0, ...o })
const parse = hosts => parseArp(JSON.stringify({ v: 1, ts: T, ok: true, hosts }), { cidrs, now: T })

test('6 MACs on one IP → 4 kept, 2 counted; MAC answering for 10 IPs → no observation', () => {
  const six = parse(Array.from({ length: 6 }, (_, i) => h('192.0.2.60', `00:00:5e:00:53:6${i}`)))
  assert.deepEqual([six.hosts.length, six.anomalies.extraMacs, six.anomalies.multiMacIps], [4, 2, 1])
  const wide = parse(Array.from({ length: 10 }, (_, i) => h(`192.0.2.${70 + i}`, '00:00:5e:00:53:70')))
  assert.deepEqual([wide.hosts.length, wide.anomalies.wideMacs], [0, 1])
  assert.deepEqual(wide.anomalies.conflicts.map(c => c.detail), ['MAC 00:00:5e:00:53:70: answers for 10 IP'])
})

test('conflicts during the sweep: arp_conflict once per 24 h, digest line, no alert; "proxy" MAC without a record', async () => {
  const b = r3Bench({ T })
  const victim = FIXTURE_HOSTS[25] // a known device, cloned by an intruder
  const proxy = Array.from({ length: 10 }, (_, i) => h(`192.0.2.${200 + i}`, '00:00:5e:00:53:a0'))
  const forged = [...FIXTURE_HOSTS, { ip: victim.ip, mac: '00:00:5e:00:53:a1' }, { ...victim, hdrmac: '00:00:5e:00:53:a2' }, ...proxy]
  const lpBefore = () => b.devByMac(victim.mac).last_present
  await b.run(10, forged)
  const ev = b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'arp_conflict' ORDER BY id").all().map(r => r.detail)
  assert.deepEqual(ev.sort(), [
    'IP 192.0.2.193: 2 MAC (02:42:00:00:53:e1, 62:00:00:00:53:e2)', // legitimate macvlan of the fixture: reported too
    `IP ${victim.ip}: 2 MAC (${victim.mac}, 00:00:5e:00:53:a1)`,
    'MAC 00:00:5e:00:53:a0: answers for 10 IP',
    `MAC ${victim.mac}: Ethernet header 00:00:5e:00:53:a2`,
  ].sort())
  // the MAC answering for everything creates no record
  assert.equal(b.devByMac('00:00:5e:00:53:a0'), undefined)
  assert.ok(lpBefore() != null)
  assert.deepEqual(b.network.view().sources.arp.anomalies, { invalid: 0, extraMacs: 0, wideMacs: 1, multiMacIps: 2, hdrmac: 1, dup: 0 }) // including the fixture's macvlan
  const digest = b.digest(false)
  assert.match(digest, /conflits ARP \(24 h\) : /)
  // the digest names the records: neither "MAC x" nor the victim's MAC, its name instead
  const label = deviceLabel(b.devByMac(victim.mac))
  assert.ok(!digest.includes(victim.mac), digest)
  assert.ok(digest.includes(`${label} : en-tête Ethernet`) && digest.includes(`2 MAC (${label}, `), digest)
  // no alert: no message caused by the conflicts (the spoofing MAC itself is a new device)
  assert.ok(b.telegram.sent.every(m => !/conflit/i.test(m.text)))
  assert.ok(!b.engine.active().some(a => /arp/.test(a.rule)))
  // only 24 h later, a new event for the same IP
  b.clock.t += 23 * 60 * MIN
  await b.run(4, forged)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'arp_conflict'").get().n, 4)
  b.clock.t += 2 * 60 * MIN
  await b.run(2, forged)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'arp_conflict'").get().n, 8)
})

test('duplicate replies: isolated → no event; repeated (3 sweeps out of 10) → arp_conflict; a spoofing hint wins', async () => {
  const b = r3Bench({ T })
  const [late, clone] = [FIXTURE_HOSTS[20], FIXTURE_HOSTS[21]]
  const conflicts = () => b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'arp_conflict' ORDER BY id").all().map(r => r.detail)
  const withDup = (macs) => FIXTURE_HOSTS.map(x => (macs.includes(x.mac) ? { ...x, dup: 2 } : x))
  // a late reply once (crossed arp-scan retry), then once more 10 sweeps later
  let n = 0
  await b.run(40, () => withDup(n++ % 10 === 3 ? [late.mac] : []))
  assert.deepEqual(conflicts().filter(d => d.includes(late.mac)), [])
  assert.doesNotMatch(b.digest(false), /en double/) // the fixture's .193 macvlan stays reported
  // a MAC that duplicates in 3 sweeps out of 10: reported, once
  n = 0
  await b.run(20, () => withDup(n++ % 3 === 0 ? [clone.mac] : []))
  assert.deepEqual(conflicts().filter(d => /duplicate/.test(d)), [`MAC ${clone.mac}: 2 duplicate replies`])
  assert.match(b.digest(false), /conflits ARP \(24 h\) : .*2 réponses en double/)
  // different Ethernet header on a duplicate reply: spoofing hint, never filtered
  const both = parse([h('192.0.2.30', '00:00:5e:00:53:30', { dup: 2 }), h('192.0.2.30', '00:00:5e:00:53:30', { hdrmac: '00:00:5e:00:53:31' })])
  assert.deepEqual(both.anomalies.conflicts, [{ key: 'mac:00:00:5e:00:53:30', detail: 'MAC 00:00:5e:00:53:30: Ethernet header 00:00:5e:00:53:31', kind: 'spoof' }])
})

test('conflicts written by an earlier version (French details): same keys, no new event the same day, identical digest line', async () => {
  const b = r3Bench({ T })
  const victim = FIXTURE_HOSTS[25]
  const proxy = Array.from({ length: 10 }, (_, i) => h(`192.0.2.${200 + i}`, '00:00:5e:00:53:a0'))
  const forged = [...FIXTURE_HOSTS, { ip: victim.ip, mac: '00:00:5e:00:53:a1' }, { ...victim, hdrmac: '00:00:5e:00:53:a2' }, ...proxy]
  await b.run(10, forged)
  const digestNew = b.digest(false)
  // as an older version wrote them (test setup only: the code never rewrites a row)
  const french = d => d
    .replace(/^(MAC \S+): Ethernet header (\S+)$/, '$1 : en-tête Ethernet $2')
    .replace(/^(IP \S+): (\d+) MAC \((.*)\)$/, '$1 : $2 MAC ($3)')
    .replace(/^(MAC \S+): answers for (\d+) IP$/, '$1 : répond pour $2 IP')
  const rows = b.store.db.prepare("SELECT id, detail FROM net_events WHERE type = 'arp_conflict'").all()
  for (const r of rows) b.store.db.prepare('UPDATE net_events SET detail = ? WHERE id = ?').run(french(r.detail), r.id)
  assert.ok(b.store.db.prepare("SELECT detail FROM net_events WHERE type = 'arp_conflict'").all().every(r => r.detail.includes(' : ')))
  assert.equal(b.digest(false), digestNew, 'digest line identical')
  b.clock.t += 23 * 60 * MIN
  await b.run(4, forged)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'arp_conflict'").get().n, 4, 'no new event within 24 h')
  b.clock.t += 2 * 60 * MIN
  await b.run(2, forged)
  assert.equal(b.store.db.prepare("SELECT COUNT(*) n FROM net_events WHERE type = 'arp_conflict'").get().n, 8)
})

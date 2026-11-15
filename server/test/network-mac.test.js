// Network module: identity by MAC (lib/net/mac.js). Anonymized fixtures: documentation
// MACs (RFC 7042, 00:00:5e:00:53:xx) and fictitious prefixes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMac, gradeMac, isLocal, matchPrefix, ouiOf } from '../lib/net/mac.js'
import { parseCidr, inCidr, isIpv4 } from '../lib/net/ip.js'

test('normalizeMac: common formats → lowercase and colons', () => {
  for (const v of ['00:00:5E:00:53:01', '00-00-5e-00-53-01', '0000.5e00.5301', '00005E005301', ' 0:0:5e:0:53:1 ']) {
    assert.equal(normalizeMac(v), '00:00:5e:00:53:01', v)
  }
  for (const v of [null, undefined, '', 'internet', '00:00:5e:00:53', '00:00:5e:00:53:01:02', 'zz:00:5e:00:53:01', 'ip-192.0.2.1']) {
    assert.equal(normalizeMac(v), null, String(v))
  }
})

test('gradeMac: universal, local, hypervisor, excluded', () => {
  assert.equal(gradeMac('00:00:5E:00:53:01'), 'strong')
  assert.equal(gradeMac('bc:24:11:00:53:01'), 'strong') // Proxmox OUI, without an OUI database
  assert.equal(gradeMac('00:00:0c:9f:e0:01'), 'strong') // outside HSRPv2
  // U/L bit: x2, x6, xA, xE (phone private MAC, Docker macvlan, rotating device)
  for (const m of ['02:42:00:00:53:01', '06:00:00:00:53:01', 'de:00:00:00:53:01', 'ae:00:53:00:53:01']) {
    assert.equal(gradeMac(m), 'weak', m)
    assert.equal(isLocal(normalizeMac(m)), true)
  }
  // read "from the inside" (Proxmox config, config.json, agent): strong even when local
  for (const source of ['pve', 'config', 'agent']) assert.equal(gradeMac('02:42:00:00:53:01', { source }), 'hypervisor')
  assert.equal(gradeMac('02:42:00:00:53:01', { source: 'pihole' }), 'weak')
  for (const m of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:fb', '33:33:00:00:00:01',
    '00:00:5e:00:01:0a', '00:00:5e:00:02:0a', '00:00:0c:07:ac:01', '00:00:0c:9f:f0:01', 'n\'importe quoi']) {
    assert.equal(gradeMac(m), 'excluded', m)
    assert.equal(gradeMac(m, { source: 'pve' }), 'excluded', `${m} (pve)`)
  }
  // no more manual exclusion (network.ignore); an ignore parameter has no effect
  assert.equal(gradeMac('02:42:ac:12:00:03', { ignore: ['02:42:ac:12:*'] }), 'weak')
  assert.equal(gradeMac('ae:00:53:00:00:01'), 'weak')
  assert.equal(matchPrefix('00:00:5e:00:53:01', ['00:00:5e:00:53']), true)
  assert.equal(matchPrefix('00:00:5e:00:53:01', ['00:00:5e:00:5']), false) // whole byte only
  assert.equal(matchPrefix(null, ['00:00:5e']), false)
  assert.equal(ouiOf('00:00:5e:00:53:01'), '00:00:5e')
  assert.equal(ouiOf('02:42:00:00:53:01'), null)
})

test('IPv4 and CIDR', () => {
  assert.equal(isIpv4('192.0.2.10'), true)
  for (const v of ['192.0.2', '192.0.2.256', '01.2.3.4', 'fe80::1', '', null]) assert.equal(isIpv4(v), false, String(v))
  assert.deepEqual(parseCidr('192.0.2.77/27'), { base: parseCidr('192.0.2.64/27').base, bits: 27, size: 32 })
  assert.equal(parseCidr('192.0.2.0/33'), null)
  assert.equal(inCidr('192.0.2.95', '192.0.2.64/27'), true)
  assert.equal(inCidr('192.0.2.96', '192.0.2.64/27'), false)
  assert.equal(inCidr('pas une ip', '192.0.2.0/24'), false)
})

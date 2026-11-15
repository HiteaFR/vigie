// Hardening of the systemd unit.
// The production unit lives in another repository; here, the public example unit
// deploy/vigie.service.example (directives only, comments ignored).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const UNIT = fs.readFileSync(path.join(here, '../../deploy/vigie.service.example'), 'utf8')
// directives of the [Service] section: [key, value], in order, without the comments
const service = (() => {
  const out = []
  let inService = false
  for (const raw of UNIT.split('\n')) {
    const line = raw.trim()
    if (/^\[.*\]$/.test(line)) { inService = line === '[Service]'; continue }
    if (!inService || !line || line.startsWith('#') || line.startsWith(';')) continue
    const i = line.indexOf('=')
    out.push([line.slice(0, i), line.slice(i + 1)])
  }
  return out
})()
const values = key => service.filter(([k]) => k === key).map(([, v]) => v)

test('each directive of the table is present; existing lines are kept', () => {
  const expected = {
    ProtectSystem: 'strict', ProtectHome: 'yes', PrivateTmp: 'yes', PrivateDevices: 'yes',
    ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectKernelLogs: 'yes', ProtectControlGroups: 'yes',
    ProtectClock: 'yes', ProtectHostname: 'yes', RestrictNamespaces: 'yes', LockPersonality: 'yes',
    RestrictRealtime: 'yes', RestrictSUIDSGID: 'yes', SystemCallArchitectures: 'native',
    SystemCallFilter: '@system-service', SystemCallErrorNumber: 'EPERM', UMask: '0077',
  }
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(values(k), [v], k)
  // lines of the example: generic paths /opt/vigie and /etc/vigie (CONFIG_PATH, PKI_DIR)
  assert.deepEqual(values('User'), ['vigie'])
  assert.deepEqual(values('EnvironmentFile'), ['-/etc/vigie/vigie.env'])
  assert.deepEqual(values('StateDirectory'), ['vigie'])
  assert.deepEqual(values('AmbientCapabilities'), ['CAP_NET_BIND_SERVICE'])
  assert.deepEqual(values('NoNewPrivileges'), ['true'])
  assert.deepEqual(values('Environment'), ['NODE_ENV=production', 'CONFIG_PATH=/etc/vigie/config.json', 'PKI_DIR=/etc/vigie/pki'])
  assert.deepEqual(values('ExecStart'), ['/usr/bin/node --disable-warning=ExperimentalWarning index.js'])
  assert.deepEqual(values('WorkingDirectory'), ['/opt/vigie/server'])
  assert.doesNotMatch(UNIT, /dev-dashboard|dashboard@|192\.168\./, 'no production-specific value')
})

test('RestrictAddressFamilies: AF_NETLINK, AF_UNIX, AF_INET, AF_INET6, without quotes', () => {
  const v = values('RestrictAddressFamilies')
  assert.equal(v.length, 1)
  assert.doesNotMatch(v[0], /["']/)
  assert.deepEqual(v[0].split(/\s+/).sort(), ['AF_INET', 'AF_INET6', 'AF_NETLINK', 'AF_UNIX'])
})

test('CapabilityBoundingSet contains CAP_NET_BIND_SERVICE (port 80), and nothing else', () => {
  const v = values('CapabilityBoundingSet')
  assert.equal(v.length, 1)
  assert.deepEqual(v[0].split(/\s+/), ['CAP_NET_BIND_SERVICE'])
})

test('the unit does not contain the directives that would break the service', () => {
  for (const k of ['MemoryDenyWriteExecute', 'PrivateNetwork', 'PrivateUsers', 'IPAddressDeny', 'IPAddressAllow', 'ProtectProc']) {
    assert.deepEqual(values(k), [], k)
  }
  assert.ok(!values('ProcSubset').includes('pid'), 'ProcSubset=pid')
  // even outside [Service] (a misplaced section), none of these directives in clear
  assert.doesNotMatch(UNIT.split('\n').filter(l => !l.trim().startsWith('#')).join('\n'), /^\s*(MemoryDenyWriteExecute|ProcSubset|PrivateNetwork|PrivateUsers|IPAddressDeny|IPAddressAllow)\s*=/m)
})


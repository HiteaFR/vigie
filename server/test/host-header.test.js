// hostHeader removed. undici does not forward a Host header supplied by the caller:
// the option did nothing. A config that uses it is refused with a clear message, never converted
// silently. A vhost is probed by its name in url. (A v1 config, and its health[].host, is
// refused as a whole: config-i18.test.js)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, HOST_HEADER_GONE } from '../lib/config.js'
import { describe } from '../lib/checks.js'

test('hostHeader removed: refused (clear message, path of the check), never converted; the rest of the config is valid without it', () => {
  const v2 = over => ({
    version: 2, title: 't', proxmox: [], gitea: { owner: 'x' }, groups: [{ id: 'g', name: 'G' }], hosts: [],
    services: [{ id: 's', name: 'S', group: 'g', env: 'prod', checks: [{ type: 'tcp', target: '192.0.2.1:22' }, { type: 'http', url: 'http://192.0.2.1/', ...over }] }],
  })
  assert.deepEqual(parseConfig(v2({ hostHeader: 'appli.exemple.test' })).errors, [`services[0].checks[1].hostHeader : ${HOST_HEADER_GONE}`])
  assert.equal(HOST_HEADER_GONE, 'hostHeader is no longer supported: put the name in url')
  assert.ok(parseConfig(v2({})).config)
})

test('hostHeader removed: label of an http probe = host of the url (no more hostHeader case)', () => {
  assert.deepEqual(describe({ type: 'http', url: 'http://appli.exemple.test/' }), { label: 'appli.exemple.test', display: 'http://appli.exemple.test/' })
})

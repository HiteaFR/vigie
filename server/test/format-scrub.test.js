// Telegram formatter: scrub() masks any IPv4, even stuck to a letter or a
// symbol, port included; t() escapes the HTML then masks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub, t, createFormatter } from '../lib/notify/format.js'
import { createClock } from '../lib/clock.js'

test('scrub: IPv4 masked everywhere, not the numbers that are not', () => {
  for (const [input, out] of [
    ['192.0.2.66', '‹ip›'],
    ['J192.0.2.66', 'J‹ip›'],
    ['hôte192.0.2.66x', 'hôte‹ip›x'],
    ['[2J192.0.2.66]', '[2J‹ip›]'],
    ['_192.0.2.66_', '_‹ip›_'],
    ['http://192.0.2.5:8080/x', 'http://‹ip›/x'],
    ['connect 192.0.2.5:443 refusé.', 'connect ‹ip› refusé.'],
    ['fin de phrase 192.0.2.5.', 'fin de phrase ‹ip›.'],
    ['a=192.0.2.1,b=192.0.2.2', 'a=‹ip›,b=‹ip›'],
    ['ip=192.0.2.66:', 'ip=‹ip›:'],
    ['Jv192.0.2.66', 'Jv‹ip›'],
    ['1.2.3.4', '‹ip›'], // indistinguishable from an IP: masked, as before
  ]) assert.equal(scrub(input), out, input)
  // not IPs: version with 5 components, plain numbers, dates
  // not IPs, or versions: unchanged, as before the fix
  for (const v of ['1.2.3.4.5', 'v6.5.0', 'v1.2.3.4', 'version v1.2.3.4', '2026-10-21', '12 h 30', '1234.5.6.7',
    'kernel 6.8.12-4-pve', 'docker 29.9.1', '2026.10.1', 'pve-manager/9.0.11', 'depuis 1 h 05', '45 min']) assert.equal(scrub(v), v, v)
  assert.equal(t('<b>J192.0.2.66</b>'), '&lt;b&gt;J‹ip›&lt;/b&gt;')
})

test('all alerts go through the masking: service_down, disk, source', () => {
  const clock = createClock('Europe/Paris')
  const f = createFormatter({ dashboardUrl: 'http://dash.test', clock })
  const T = Date.parse('2026-10-21T10:00:00Z')
  for (const st of [
    { key: 'service_down:x', rule: 'service_down', title: 'Gitea', detail: 'HTTP : connect ECONNREFUSED192.0.2.30:3000', severity: 'critical', env: 'prod', since: T, link: '/services' },
    { key: 'guest_disk:x', rule: 'guest_disk', title: 'Disque · hôte', detail: 'ip=192.0.2.31: / à 91 %', severity: 'warning', env: 'prod', since: T },
    { key: 'source_error:gitea', rule: 'source_error', title: 'Gitea', detail: 'fetch failed (x192.0.2.32)', severity: 'warning', env: 'prod', since: T },
  ]) {
    const out = f.render('open', st, T)
    assert.doesNotMatch(out, /192\.0\.2\.3\d/, st.key)
    assert.match(out, /‹ip›/, st.key)
  }
})

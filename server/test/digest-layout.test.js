// Layout of the daily digest: sections separated by a blank line, alerts by severity then age,
// alerts of the same rule grouped (one title, one line per item, the shared detail once),
// indented lines of a module in a quote (folded beyond 3 lines).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClock } from '../lib/clock.js'
import { createFormatter } from '../lib/notify/format.js'
import { buildDigest, itemNames, renderBlock } from '../lib/notify/digest.js'

const NOW = Date.parse('2026-11-23T07:00:00Z')
const H = 3600_000
const D = 24 * H
const CFG = { hosts: [], services: [], alerts: { storage: { warnPct: 85 }, backupMaxAgeHours: 30 } }

const alert = (rule, severity, title, detail, ago, extra = {}) => ({ key: `${rule}:${title}`, rule, severity, title, detail, since: NOW - ago, state: 'firing', ...extra })

function digest(alerts, { blocks = [], incidents = [] } = {}) {
  const clock = createClock('Europe/Paris')
  const engine = { active: () => alerts, incidents: () => incidents }
  const host = { digestLines: () => [], digestBlocks: slot => (slot === 'end' ? blocks : []) }
  return buildDigest({ cfg: CFG, engine, snap: {}, monitor: { checks: [] }, formatter: createFormatter({ dashboardUrl: 'https://vigie.example.net', clock }), clock, host, now: NOW })
}

test('itemNames: common prefix ending with a separator, common suffix without one; a qualifier stays', () => {
  assert.deepEqual(itemNames(['Redémarrage requis · alpha', 'Redémarrage requis · bravo']), ['alpha', 'bravo'])
  assert.deepEqual(itemNames(['VM 102 app non déclaré', 'CT 106 mail non déclaré']), ['VM 102 app', 'CT 106 mail'])
  // "VM" is not followed by a separator: kept
  assert.deepEqual(itemNames(['VM 102 app non déclaré', 'VM 105 web non déclaré']), ['VM 102 app', 'VM 105 web'])
  // "· web" is a qualifier (host): kept
  assert.deepEqual(itemNames(['Disque / · web', 'Disque /var · web']), ['Disque / · web', 'Disque /var · web'])
  // names not distinct: full titles
  assert.deepEqual(itemNames(['a x', 'a x']), ['a x', 'a x'])
})

test('renderBlock: headlines as they are, indented lines in a quote, folded beyond 3 lines, escaped', () => {
  assert.equal(renderBlock(['🛡 2 fixes', '  web : openssl', '  db : <libc>']), '🛡 2 fixes\n<blockquote>web : openssl\ndb : &lt;libc&gt;</blockquote>')
  assert.equal(renderBlock(['🌐 net', '  a', '  b', '  c', '  d']), '🌐 net\n<blockquote expandable>a\nb\nc\nd</blockquote>')
  assert.equal(renderBlock(['🆕 1', '  x', '⏳ 2', '  y']), '🆕 1\n<blockquote>x</blockquote>\n⏳ 2\n<blockquote>y</blockquote>')
  assert.equal(renderBlock(['🌐 net']), '🌐 net')
})

test('digest: sections apart, severity first, same rule grouped with the shared detail once, module quotes', () => {
  const d = digest([
    alert('guest_undeclared', 'info', 'VM 102 app non déclaré', 'état Proxmox : stopped', 6 * D),
    alert('guest_undeclared', 'info', 'CT 106 mail non déclaré', 'état Proxmox : stopped', 5 * D),
    alert('reboot_required', 'info', 'Redémarrage requis · alpha', 'noyau 6.2 installé, 6.1 en cours', 50 * 60_000),
    alert('reboot_required', 'info', 'Redémarrage requis · bravo', 'noyau 6.3 installé, 6.1 en cours', 24 * 60_000),
    alert('security_release', 'warning', 'Proxy (WAF)', '1.6.17 → 1.6.18 : correctif', 2 * D, { ack: { by: 'admin', reason: 'ce soir' } }),
  ], { blocks: [['🛡 21 correctifs cette nuit sur 4 hôtes', '  web : openssl', '  db : libc6'], ['🌐 Réseau : 45 appareils']] })
  const sections = d.split('\n\n')
  assert.equal(sections[0], '☀️ <b>Infra — digest du 23/11</b>')
  assert.equal(sections[1], '🚨 <b>5 alertes actives</b>')
  // warning before the infos, even if younger
  assert.equal(sections[2], '🟠 <b>Proxy (WAF)</b> · depuis 2 j\n1.6.17 → 1.6.18 : correctif\n✅ acquittée par admin : ce soir')
  // same detail: once, in italics, under the list
  assert.equal(sections[3], 'ℹ️ <b>Invité non déclaré</b> · 2\n• VM 102 app · depuis 6 j\n• CT 106 mail · depuis 5 j\n<i>état Proxmox : stopped</i>')
  // different details: on each line
  assert.equal(sections[4], 'ℹ️ <b>Redémarrage requis</b> · 2\n• alpha — noyau 6.2 installé, 6.1 en cours · depuis 50 min\n• bravo — noyau 6.3 installé, 6.1 en cours · depuis 24 min')
  assert.equal(sections[5], '📋 24 h : aucun incident résolu\n🔐 Certificats &lt; 21 j : aucun')
  assert.equal(sections[6], '🛡 21 correctifs cette nuit sur 4 hôtes\n<blockquote>web : openssl\ndb : libc6</blockquote>')
  assert.equal(sections[7], '🌐 Réseau : 45 appareils')
  assert.equal(sections[8], '👉 <a href="https://vigie.example.net/alerts">Ouvrir le cockpit</a>')
})

test('digest: beyond 12 alerts, "+N on the cockpit"; incidents listed one per line', () => {
  const many = Array.from({ length: 15 }, (_, i) => alert(`r${i}`, 'warning', `Alerte ${i}`, null, H))
  const d = digest(many, { incidents: [{ title: 'Disque / · web', rule: 'disk', startedAt: NOW - 3 * H, resolvedAt: NOW - H }] })
  assert.match(d, /\n\n… et 3 autres sur le cockpit\n\n/)
  assert.equal((d.match(/^🟠 /gm) || []).length, 12)
  assert.match(d, /\n\n📋 24 h : 1 incident résolu\n• Disque \/ · web \(2 h\)\n\n/)
})

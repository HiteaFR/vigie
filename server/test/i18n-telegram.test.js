// Extraction of the server texts sent to Telegram (French catalog byte for byte; identical
// golden files), and the dropped codes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('dropped codes: English constants of lib/codes.js (re-exported by the notifier), former values read through droppedCode; no literal left in the notifier', async () => {
  const { DROPPED } = await import('../lib/notify/notifier.js')
  const codes = await import('../lib/codes.js')
  assert.equal(DROPPED, codes.DROPPED)
  assert.deepEqual({ ...DROPPED }, { EXPIRED: 'expired', REJECTED: 'rejected', FILTERED: 'filtered', DRY_RUN: 'dry-run' })
  assert.ok(Object.isFrozen(DROPPED))
  assert.deepEqual(['expiré', 'rejeté', 'filtré', 'dry-run', null].map(codes.droppedCode), ['expired', 'rejected', 'filtered', 'dry-run', null])
  const src = fs.readFileSync(new URL('../lib/notify/notifier.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /'(expiré|rejeté|filtré|expired|rejected|filtered)'/)
})

// guard against hardcoded French text in the files already extracted (a list that grows step by
// step): no literal with an accented letter or a French function word, comments excluded
// ignored lines: audit log (persisted codes), logs (English only, without a catalog, written
// as they come), bot audit verbs
export const EXTRACTED = ['lib/notify/format.js', 'lib/notify/digest.js', 'lib/clock.js', 'lib/notify/bot.js', 'lib/alerts/rules.js', 'lib/network/rules.js', 'lib/notify/channels.js', 'lib/notify/status.js']
const IGNORED_LINE = /audit\.(log|refused)\(|\blog\.(warn|error|log)\(|^\s*[ncd]: \{ verb: /
export function frenchLiterals(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1').split('\n').filter(l => !IGNORED_LINE.test(l)).join('\n')
  const lits = [...code.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2])
  return lits.filter(s => /[àâäéèêëîïôöùûüçœ]/i.test(s.replace(/\$\{[^}]*\}/g, '')) || /\b(le|la|les|des|du|une|aucun|aucune|depuis|jusqu|avec|sans|pour)\b/.test(s.replace(/\$\{[^}]*\}/g, '')))
}
test('guard: no hardcoded French text left in the extracted files', () => {
  for (const f of EXTRACTED) assert.deepEqual(frenchLiterals(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), [], f)
})

test('rendering in English (en catalog): durations, Telegram formatter, digest; the French stays that of the golden files', async () => {
  const { setLocale } = await import('../lib/i18n.js')
  const { fmtDuration, createClock } = await import('../lib/clock.js')
  const { createFormatter } = await import('../lib/notify/format.js')
  const clock = createClock('Europe/Paris')
  const f = createFormatter({ dashboardUrl: 'https://vigie.example.test', clock })
  const st = { key: 'r:1', rule: 'service_down', title: 'Web', env: 'prod', severity: 'critical', since: Date.parse('2026-11-10T07:00:00Z'), link: '/services', host: 'h <1>' }
  assert.deepEqual([fmtDuration(30 * 60_000), fmtDuration(90 * 60_000), fmtDuration(3 * 86_400_000)], ['30 min', '1 h 30', '3 j'])
  setLocale('en')
  try {
    assert.deepEqual([fmtDuration(30 * 60_000), fmtDuration(120 * 60_000), fmtDuration(3 * 86_400_000)], ['30 min', '2 h', '3 d'])
    assert.equal(f.render('resolve', st, Date.parse('2026-11-10T09:00:00Z'), { duration: 2 * 3600_000 }), '🟢 <b>Web</b> — recovered after 2 h (08:00 → 10:00)')
    assert.match(f.render('open', st, Date.parse('2026-11-10T09:00:00Z')), /Host: h &lt;1&gt;\nSince 08:00 · <a href="https:\/\/vigie\.example\.test\/services">Open<\/a>$/)
  } finally {
    setLocale('fr')
  }
})

test('bot in English: menu, help, replies and buttons via the catalog; command names unchanged', async () => {
  const { setLocale } = await import('../lib/i18n.js')
  const { createBot } = await import('../lib/notify/bot.js')
  const sent = []
  let commands = null
  const telegram = { configured: true, chatId: '42', send: async t => (sent.push(t), { message_id: sent.length }), setCommands: async c => { commands = c }, getUpdates: async () => new Promise(() => {}), answerCallback: async () => {} }
  const cfg = { hosts: [], services: [], alerts: { timezone: 'Europe/Paris' } }
  const engine = { active: () => [], byIncident: () => null, get: () => null }
  setLocale('en')
  try {
    const bot = createBot({ telegram, store: { kv: { get: () => '1', set() {} } }, cfg, engine, silences: { active: () => [] }, refresher: {}, audit: { log() {}, refused() {} }, clock: { hm: () => '10:00' }, texts: { status: () => 'ok' }, allowedIds: '7', log: { warn() {}, error() {} } })
    bot.start()
    bot.stop()
    assert.deepEqual(commands.slice(0, 3).map(c => [c.command, c.description]), [['status', 'Global status'], ['down', 'Ongoing alerts'], ['ack', 'Acknowledge: /ack #number reason']])
    const msg = text => bot.handle({ update_id: 1, message: { message_id: 9, text, from: { id: 7 }, chat: { id: 42 } } })
    for (const c of ['/help', '/down', '/silences', '/mute', '/inconnue', 'bonjour']) await msg(c)
    assert.match(sent[0], /^<b>Commands<\/b>\n\/status — global status/)
    assert.deepEqual(sent.slice(1), ['✅ No ongoing alerts', '🔕 No active silences', 'Unknown target: alert number (#12), host, service, rule or key.', 'Unknown command. /help', 'Command expected. /help'])
  } finally {
    setLocale('fr')
  }
})

test('rules in English: titles, details and labels via the catalog, same keys and same states as in French', async t => {
  const { buildWorld, NOW } = await import('./golden/world.js')
  const { setLocale } = await import('../lib/i18n.js')
  const { RULE_LABEL } = await import('../lib/alerts/rules.js')
  const { tmpDir } = await import('./tmpdir.js')
  const path = await import('node:path')
  const w = await buildWorld({ storeDir: path.join(tmpDir('p5b-rules-', t), 'db') })
  const pick = s => ({ key: s.key, cond: s.cond, severity: s.severity })
  const fr = w.rules.evaluate(w.snap, NOW)
  setLocale('en')
  try {
    const en = w.rules.evaluate(w.snap, NOW)
    assert.deepEqual(en.map(pick), fr.map(pick))
    assert.equal(RULE_LABEL.backup_failed, 'Backup failed')
    assert.equal(RULE_LABEL.net_agent_conflict, 'Container identity conflict')
    const byKey = Object.fromEntries(en.map(s => [s.key, s]))
    const one = rule => en.find(s => s.rule === rule && s.detail)
    assert.match(one('node_mem').detail, /^\d+ % of RAM used \(excluding cache\)$/)
    assert.match(one('not_backed_up').detail, /^(excluded from the backup job|in no active backup job)$/)
    assert.match(one('smart_failed').detail, /^SMART state: /)
    assert.match(one('guest_undeclared').title, / not declared$/)
    assert.ok(Object.values(byKey).some(s => /^Backup (CT|VM) /.test(s.title)))
    // stay in French: stub data (probe and agent errors, reboot reason),
    // and the modules (gitea, host)
    const DATA = new Set(['service_down', 'runner_offline', 'reboot_required', 'agent_unreachable', 'plugin_error'])
    const left = en.filter(s => !DATA.has(s.rule) && /[àâäéèêëîïôöùûüçœ«]/i.test(`${s.title} ${s.detail ?? ''}`))
    assert.deepEqual(left.map(s => `${s.rule} : ${s.title} | ${s.detail}`), [])
  } finally {
    setLocale('fr')
    w.store.db.close()
  }
  assert.equal(RULE_LABEL.backup_failed, 'Sauvegarde en échec')
})

test('RULE_LABEL: enumerable keys unchanged, a plugin label is added or replaces via Object.assign', async () => {
  const { RULE_LABEL } = await import('../lib/alerts/rules.js')
  const keys = Object.keys(RULE_LABEL)
  assert.ok(keys.includes('service_down') && keys.includes('channel_error'))
  assert.equal(JSON.parse(JSON.stringify(RULE_LABEL)).guest_disk, 'Disque')
  const copy = Object.create(null)
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(RULE_LABEL))
  Object.assign(copy, { guest_disk: 'Disque', example_rule: 'Exemple' })
  assert.equal(copy.guest_disk, 'Disque')
  assert.equal(copy.example_rule, 'Exemple')
})

test('network, updates, plugin and channel signals in English; the French stays as before', async t => {
  const { networkSignals } = await import('../lib/network/rules.js')
  const { setLocale } = await import('../lib/i18n.js')
  const T = Date.parse('2026-10-21T10:00:00Z')
  const MIN = 60_000
  const devices = new Map([
    [1, { id: 1, state: 'new', origin: 'scan', created_at: T - 10 * MIN, first_seen: T - 3 * 86400_000, disp_name: null, vendor: null, primary_mac: '00:00:5e:00:53:01', alert_down: 1, online: 0, last_present: T - 2 * 3600_000 }],
    [2, { id: 2, state: 'known', origin: 'scan', created_at: T - 86400_000, disp_name: 'poste-b', primary_mac: '00:00:5e:00:53:02', expected_ip: '192.0.2.2', last_ip: '192.0.2.3', online: 1 }],
  ])
  const macs = new Map([
    ['00:00:5e:00:53:01', { mac: '00:00:5e:00:53:01', device_id: 1, random: 1, attach: null, confirmed_at: null }],
    ['00:00:5e:00:53:09', { mac: '00:00:5e:00:53:09', device_id: 2, random: 0, attach: 'name', confirmed_at: null }],
  ])
  const state = {
    devices, macs, seen: new Map(), retired: ['net_new:9'],
    sources: { pihole: { ok: true, stale: false }, dhcp: { ok: true, stale: true }, arp: { ok: true, stale: false } },
    flood: { episode: { lastOver: T }, refused: new Set(['a', 'b']) },
    presence: { since: T - 86400_000, parentsOf: () => [], probe: 'on' },
    agentConflicts: [{ device: 2, key: 'web/app', other: 1 }],
  }
  const render = () => Object.fromEntries(networkSignals(state, { now: T, alertsSince: T - 3600_000, tz: 'UTC' }).map(s => [s.key, `${s.title} | ${s.detail ?? ''}`]))
  const fr = render()
  setLocale('en')
  let en
  try {
    en = render()
  } finally {
    setLocale('fr')
  }
  assert.deepEqual(Object.keys(en), Object.keys(fr))
  assert.equal(fr['net_new:1'], 'Nouvel appareil : appareil sans nom (fiche 1) | 00:00:5e:00:53:01 (privée) · déjà vu par Pi-hole le 18/10/2026')
  assert.equal(en['net_new:1'], 'New device: unnamed device (device 1) | 00:00:5e:00:53:01 (private) · already seen by Pi-hole on 18/10/2026')
  assert.equal(en['net_mac_added:00:00:5e:00:53:09'], 'poste-b: new MAC | 00:00:5e:00:53:09 attached by same name “poste-b”')
  assert.equal(en['net_agent_conflict:2'], 'poste-b: container identity conflict | container web/app: already linked to device 1')
  assert.equal(en['net_new_flood:lan'], 'Device flood on the LAN | 2 MACs refused, creations suspended until 11:00')
  assert.equal(en['net_down:1'], 'unnamed device (device 1) offline | last seen 2 h ago')
  assert.equal(en['net_ip_changed:2'], 'poste-b: IP changed | expected IP differs from the IP seen')
  assert.equal(en['source_error:network/dhcp'], 'Network source: DHCP leases | no recent successful read')
  assert.equal(fr['source_error:network/dhcp'], 'Source réseau : baux DHCP | aucun relevé réussi récent')
  assert.equal(en['net_new:9'], 'device removed | ')

  // plugin_error and channel_error: core templates (the label of a core module is tested elsewhere)
  const { createHost, definePlugin } = await import('../lib/plugins/host.js')
  const { createNotifier } = await import('../lib/notify/notifier.js')
  const { createFormatter } = await import('../lib/notify/format.js')
  const { createClock } = await import('../lib/clock.js')
  const { openDb } = await import('../lib/db.js')
  const { parseConfig } = await import('../lib/config.js')
  const { tmpDir } = await import('./tmpdir.js')
  const quiet = { log() {}, warn() {}, error() {} }
  const plug = (id, fn) => definePlugin({ id, apiVersion: 0, configured: () => true, setup: () => ({ rules: [`${id}_rule`], signals: fn }) })
  const host = createHost({ cfg: {}, log: quiet, reservedIds: ['backups'], plugins: [plug('backups', () => []), plug('demo', () => { throw new Error('boom') })] })
  const cfg = parseConfig({ version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }).config
  const clock = createClock(cfg.alerts.timezone)
  const store = openDb(tmpDir('p5b-chan-', t))
  t.after(() => store.db.close())
  const telegram = { configured: true, chatId: '42', send: async () => { throw new Error('ECONNRESET') } }
  const notifier = createNotifier({ cfg, store, clock, telegram, formatter: createFormatter({ dashboardUrl: 'https://vigie.example.test', clock }), log: quiet, channels: () => [] })
  const view = () => {
    const pe = Object.fromEntries(host.signals({}, T).filter(x => x.rule === 'plugin_error').map(x => [x.key, `${x.title} | ${x.detail}`]))
    return [pe['plugin_error:refused/backups'].split(' | ')[0], pe['plugin_error:demo'], notifier.channelSignals()[0].title]
  }
  assert.deepEqual(view(), ['Plugin backups refusé', 'Plugin demo en erreur | signals : boom', 'Canal Telegram en échec'])
  setLocale('en')
  try {
    assert.deepEqual(view(), ['Plugin backups refused', 'Plugin demo error | signals: boom', 'Channel Telegram failing'])
  } finally {
    setLocale('fr')
  }
})

test('update signals (end of life, security fix) in French and in English', async t => {
  const { createUpdates } = await import('../lib/updates/index.js')
  const { openDb } = await import('../lib/db.js')
  const { parseConfig } = await import('../lib/config.js')
  const { setLocale } = await import('../lib/i18n.js')
  const { tmpDir } = await import('./tmpdir.js')
  const parsed = parseConfig({
    version: 2, title: 't', groups: [{ id: 'g', name: 'G' }],
    proxmox: [{ id: 'prod', label: 'p', host: 'https://pve:8006', env: 'PVE', ca: 'pki/pve-prod.pem' }],
    hosts: [{ id: 'web', name: 'web', kind: 'lxc', pve: 'prod', vmid: 1, ip: '192.0.2.1', env: 'prod', agent: 'ssh' }],
    services: [{ id: 'app', name: 'App', group: 'g', host: 'web', url: 'http://x', version: { current: { from: 'agent', package: 'app' }, latest: { from: 'github', repo: 'o/app' } } }],
  })
  assert.ok(parsed.config, parsed.errors?.join('\n'))
  const store = openDb(tmpDir('p5b-upd-', t))
  t.after(() => store.db.close())
  const upstream = {
    github: async () => [{ tag: 'v1.2.0', body: 'security fix for CVE-2026-9999' }, { tag: 'v1.0.0', body: '' }],
    githubTags: async () => [], node: async () => [], errors: () => [], stats: () => ({}),
    eol: async () => [{ cycle: '12', eol: '2028-06-10' }, { cycle: '11', eol: '2026-08-31' }],
  }
  const agents = {
    hosts: parsed.config.hosts,
    get: () => ({ ok: true, at: Date.now(), fast: { osId: 'debian', osVersion: '11', docker: null }, slow: { versions: { app: '1.0.0' } } }),
  }
  const updates = createUpdates({ cfg: parsed.config, store, agents, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, log: { error() {} } })
  await updates.refresh()
  const view = () => updates.signals().filter(s => s.cond).map(s => `${s.title} | ${s.detail}`).sort()
  assert.deepEqual(view(), ['App | 1.0.0 → 1.2.0 : correctif de sécurité (CVE-2026-9999)', 'Debian 11 | fin de vie depuis le 31/08/2026 · 12 disponible'])
  assert.deepEqual(updates.digestLines(), ['🆕 2 nouvelles versions : App (CT 1 · prod) 1.0.0 → 1.2.0 🛡 · Debian (CT 1 · prod) 11 → 12 ▲', '⏳ Fin de vie : Debian 11 (CT 1 · prod)'])
  setLocale('en')
  try {
    assert.deepEqual(view(), ['App | 1.0.0 → 1.2.0: security fix (CVE-2026-9999)', 'Debian 11 | end of life since 31/08/2026 · 12 available'])
    assert.deepEqual(updates.digestLines(), ['🆕 2 new versions: App (CT 1 · prod) 1.0.0 → 1.2.0 🛡 · Debian (CT 1 · prod) 11 → 12 ▲', '⏳ End of life: Debian 11 (CT 1 · prod)'])
  } finally {
    setLocale('fr')
  }
})

test('/status and ack from the dashboard: French byte for byte (former template), English via the catalog', async () => {
  const { statusLines } = await import('../lib/notify/status.js')
  const { ackMessage } = await import('../lib/alerts/bulk.js')
  const { t: tg } = await import('../lib/notify/format.js')
  const { setLocale } = await import('../lib/i18n.js')
  // template from before the extraction (index.js, statusText), kept here as the French reference
  const before = (s, u, n) => {
    const icon = { ok: '🟢', warn: '🟠', crit: '🔴', unknown: '⚪' }[s.state]
    return [
      `${icon} <b>Infra</b> — ${s.alerts.critical} critique(s), ${s.alerts.warning} avertissement(s)${s.alerts.masked ? `, ${s.alerts.masked} masquée(s)` : ''}`,
      `🌐 Services : ${s.services.ok}/${s.services.total} en ligne${s.services.crit ? ` · ${s.services.crit} en panne` : ''}`,
      `🖥️ Invités : ${s.guests.running}/${s.guests.total} en marche${s.guests.stoppedDeclared.length ? ` · arrêtés : ${tg(s.guests.stoppedDeclared.join(', '))}` : ''}`,
      `💾 Sauvegardes : ${s.backups.map(b => (b.error ? `${tg(b.node)} illisible` : `${tg(b.node)} ${b.ok}/${b.total}`)).join(' · ')}`,
      `📦 MAJ : ${u.total} en attente${u.security ? `, dont ${u.security} de sécurité` : ''}`,
      `🔕 Silences : ${n}`,
      ...(s.sourcesDown.length ? [`⚠️ Sources : ${tg(s.sourcesDown.join(', '))}`] : []),
    ].join('\n')
  }
  const full = { state: 'crit', alerts: { critical: 2, warning: 1, masked: 3 }, services: { ok: 4, total: 5, crit: 1 }, guests: { running: 6, total: 8, stoppedDeclared: ['ct-<a>', 'vm-b'] }, backups: [{ node: 'n1', ok: 3, total: 4 }, { node: 'n<2>', error: 'x' }], sourcesDown: ['pve', 'pihole'] }
  const calm = { state: 'ok', alerts: { critical: 0, warning: 0, masked: 0 }, services: { ok: 5, total: 5, crit: 0 }, guests: { running: 8, total: 8, stoppedDeclared: [] }, backups: [], sourcesDown: [] }
  for (const [s, u, n] of [[full, { total: 7, security: 2 }, 1], [calm, { total: 0, security: 0 }, 0]]) assert.equal(statusLines({ s, u, silences: n }), before(s, u, n))
  setLocale('en')
  try {
    assert.equal(statusLines({ s: full, u: { total: 7, security: 2 }, silences: 1 }), [
      '🔴 <b>Infra</b> — 2 critical, 1 warning(s), 3 masked',
      '🌐 Services: 4/5 up · 1 down',
      '🖥️ Guests: 6/8 running · stopped: ct-&lt;a&gt;, vm-b',
      '💾 Backups: n1 3/4 · n&lt;2&gt; unreadable',
      '📦 Updates: 7 pending, 2 of them security',
      '🔕 Silences: 1',
      '⚠️ Sources: pve, pihole',
    ].join('\n'))
    assert.equal(ackMessage(['Disk / · web'], 'on <it>'), '✅ <b>Disk / · web</b> acknowledged from the dashboard: on &lt;it&gt;')
    assert.equal(ackMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'r'), ['✅ <b>7 alerts acknowledged</b> from the dashboard: r', '• a', '• b', '• c', '• d', '• e', '… and 2 more'].join('\n'))
  } finally {
    setLocale('fr')
  }
  assert.equal(ackMessage(['a', 'b', 'c', 'd', 'e', 'f'], 'r').split('\n').at(-1), '… et 1 autre')
})

test('alert buttons via the catalog; callback data (callback_data) unchanged', async () => {
  const { buttonsFor } = await import('../lib/notify/channels.js')
  const { setLocale } = await import('../lib/i18n.js')
  const all = () => [buttonsFor({ key: 'net_new:12' }, 'tel'), buttonsFor({ key: 'net_mac_added:00:00:5e:00:53:01' }, 'tel'), buttonsFor({ key: 'r:1', incident_id: 7 }, 'Disque')]
  const fr = all()
  assert.deepEqual(fr.map(l => l.map(b => b.text)), [['✅ Connu · tel'], ['✅ Même appareil · tel', '✂️ Détacher'], ['🔕 1 h · Disque', '✅ Ack']])
  setLocale('en')
  try {
    const en = all()
    assert.deepEqual(en.map(l => l.map(b => b.text)), [['✅ Known · tel'], ['✅ Same device · tel', '✂️ Detach'], ['🔕 1 h · Disque', '✅ Ack']])
    assert.deepEqual(en.map(l => l.map(b => b.callback_data)), fr.map(l => l.map(b => b.callback_data)))
  } finally {
    setLocale('fr')
  }
})

test('tHtml: an already safe parameter (catalog text, nested tHtml) is not escaped twice; the rest is', async () => {
  const { tHtml, safe } = await import('../lib/notify/format.js')
  const cat = { 'k.line': 'A {x} B {y}', 'k.inner': '<i>{v}</i>' }
  const translate = (key, params) => cat[key].replace(/\{(\w+)\}/g, (m, k) => params[k])
  // markup intended by a translator in a catalog text passed as a parameter: kept
  assert.equal(tHtml('k.line', { x: safe('<b>déjà sûr</b>'), y: '<b>donnée</b> 192.0.2.7' }, translate), 'A <b>déjà sûr</b> B &lt;b&gt;donnée&lt;/b&gt; ‹ip›')
  // nested: the value of the inner tHtml is escaped once, the result is not re-escaped
  assert.equal(tHtml('k.line', { x: safe(tHtml('k.inner', { v: 'a & b' }, translate)), y: '&' }, translate), 'A <i>a &amp; b</i> B &amp;')
  assert.equal(String(safe('x')), 'x')
  // bot: the five call sites that pass a catalog text to tHtml mark it safe
  const src = (await import('node:fs')).readFileSync(new URL('../lib/notify/bot.js', import.meta.url), 'utf8')
  for (const site of ["safe(tHtml('bot.until'", "safe(tr('bot.forever'))", "safe(tr('bot.net.source_stale'))", 'action: safe(tr(`bot.net.${action}.prompt`))', "action: safe(tr(action === 'ack' ? 'bot.prompt.ack' : 'bot.prompt.mute'))", "done: safe(tr(`bot.net.${p.net}.done`))",
    // the icon, extracted from a catalog text, goes as an ordinary parameter (safe() only
    // marks a whole tr(…) call); escaped, it stays the emoji
    "icon: tr(`bot.net.${p.net}.prompt`).split(' ')[0], done:"]) {
    assert.ok(src.includes(site), site)
  }
})

test('/reseau: "0 nouveau" in the plural at 0, in French and in English', async () => {
  const { createBot } = await import('../lib/notify/bot.js')
  const { setLocale } = await import('../lib/i18n.js')
  const sent = []
  const telegram = { configured: true, chatId: '42', send: async t => (sent.push(t), { message_id: 1 }) }
  const network = { enabled: true, view: () => ({ presence: 'arp', counts: { total: 5, online: 4, offline: 1, new: 0, review: 0 }, sources: { arp: { ok: true } }, presenceSince: 1, devices: [] }) }
  const bot = createBot({ telegram, store: { kv: { get: () => '1', set() {} } }, cfg: { hosts: [], services: [], alerts: { timezone: 'Europe/Paris' } }, engine: { active: () => [] }, silences: { active: () => [] }, refresher: {}, audit: { log() {}, refused() {} }, clock: { hm: () => '' }, texts: {}, allowedIds: '7', network, log: { warn() {}, error() {} } })
  const ask = () => bot.handle({ update_id: 1, message: { message_id: 9, text: '/reseau', from: { id: 7 }, chat: { id: 42 } } })
  await ask()
  setLocale('en')
  try {
    await ask()
  } finally {
    setLocale('fr')
  }
  assert.equal(sent[0], '🌐 <b>Réseau</b> — 5 appareils · 4 en ligne · 1 hors ligne · 0 nouveau · 0 à revoir · sources OK')
  assert.equal(sent[1], '🌐 <b>Network</b> — 5 devices · 4 online · 1 offline · 0 new · 0 to review · sources OK')
})

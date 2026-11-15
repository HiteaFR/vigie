// Golden of the future registries, frozen on the code from before: probes (describe and results of
// runCheck against LOCAL servers), config validation errors (probes, widgets, versions),
// widgets (responses and server-side formatting, same shapes as those in service: pihole auth, bearer,
// header, qbittorrent, query, no auth; every format), update sources (installed version and
// latest version, fake upstream) and service definitions (shipped file, resolution).
// No call outside the machine: 127.0.0.1 only. Latencies removed from the outputs.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dgram from 'node:dgram'
import path from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'
import { runCheck, describe } from '../../lib/checks.js'
import { parseConfig } from '../../lib/config.js'
import { createWidgets } from '../../lib/widgets.js'
import { createMonitor } from '../../lib/monitor.js'
import { createPiholes } from '../../lib/pihole.js'
import { createUpdates } from '../../lib/updates/index.js'
import { openDb } from '../../lib/db.js'
import { DEFS_FILE, loadDefs, recognise, expectedStatuses, planCouples, parseDefs } from '../../lib/network/probe.js'
import { tlsFixtures } from '../tls-fixtures.js'
import { tmpDir } from '../tmpdir.js'

const FAST = { timeoutMs: 300, retryDelayMs: 0 }
const MIN = 60_000
const DAY = 86_400_000

// --- local servers -------------------------------------------------------------------------------
function listen(srv, host = '127.0.0.1') {
  const sockets = new Set()
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, host, () => resolve({
      port: srv.address().port,
      close: () => new Promise(r => { for (const s of sockets) s.destroy(); srv.close(() => r()) }),
    }))
  })
}
// closed local port (opened then closed again)
async function closedPort() {
  const s = await listen(net.createServer())
  await s.close()
  return s.port
}
// minimal DNS server: any A question → answers[name] (NOERROR)
async function dnsServer(answers) {
  const sock = dgram.createSocket('udp4')
  sock.on('message', (msg, rinfo) => {
    let i = 12
    const labels = []
    while (msg[i]) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString())
      i += msg[i] + 1
    }
    const ips = answers[labels.join('.')] ?? []
    const head = Buffer.alloc(12)
    msg.copy(head, 0, 0, 2)
    head.writeUInt16BE(0x8180, 2)
    head.writeUInt16BE(1, 4)
    head.writeUInt16BE(ips.length, 6)
    const recs = ips.map(ip => {
      const r = Buffer.alloc(16)
      r.writeUInt16BE(0xc00c, 0)
      r.writeUInt16BE(1, 2)
      r.writeUInt16BE(1, 4)
      r.writeUInt32BE(60, 6)
      r.writeUInt16BE(4, 10)
      ip.split('.').forEach((o, k) => r.writeUInt8(Number(o), 12 + k))
      return r
    })
    sock.send(Buffer.concat([head, msg.subarray(12, i + 5), ...recs]), rinfo.port, rinfo.address)
  })
  await new Promise(r => sock.bind(0, '127.0.0.1', r))
  return { server: `127.0.0.1:${sock.address().port}`, close: () => new Promise(r => sock.close(r)) }
}

// latency removed; expiry of the test certificate removed (generated at startup: daysLeft is enough)
const result = r => {
  const { latencyMs, ...rest } = r
  if (rest.tls) rest.tls = { daysLeft: rest.tls.daysLeft, issuer: rest.tls.issuer, validTo: rest.tls.validTo ? 'date' : null }
  return JSON.stringify(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))))
}

// --- probes ---------------------------------------------------------------------------------------
async function probes() {
  const out = ['# describe (libellé · affichage)']
  const shapes = [
    { type: 'http', url: 'http://192.0.2.10/' },
    { type: 'http', url: 'https://app.example.test:8443/sante?x=1', label: 'santé' },
    { type: 'tcp', target: '192.0.2.10:5432' },
    { type: 'tcp', target: '192.0.2.10:22', name: 'ssh' },
    { type: 'tcp', target: 'db.example.test:3306', label: 'base' },
    { type: 'tls', host: 'site.example.test' },
    { type: 'tls', host: '192.0.2.10', port: 8443, servername: 'interne.example.test', label: 'cert interne' },
    { type: 'dns', server: '192.0.2.53', name: 'example.test' },
    { type: 'dns', server: '192.0.2.53', name: 'example.test', label: 'résolveur' },
  ]
  for (const c of shapes) {
    const d = describe(c)
    out.push(`${JSON.stringify(c)} → ${d.label} · ${d.display}`)
  }

  out.push('', '# runCheck (serveurs locaux ; latence retirée)')
  const web = await listen(http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('tout va bien')
    if (req.url === '/erreur') { res.statusCode = 500; return res.end('boum') }
    if (req.url === '/introuvable') { res.statusCode = 404; return res.end('non') }
    if (req.url === '/redirige') { res.statusCode = 302; res.setHeader('Location', '/ok'); return res.end() }
    if (req.url === '/lent') return setTimeout(() => res.end('tard'), 2000)
    res.end('accueil')
  }))
  const tcpOpen = await listen(net.createServer(s => s.end()))
  const dir = tlsFixtures()
  const tlsSrv = await listen(https.createServer({ key: fs.readFileSync(path.join(dir, 'leaf-a.key')), cert: fs.readFileSync(path.join(dir, 'leaf-a.pem')) }, (req, res) => res.end('ok')))
  const validTo = Date.parse(new X509Certificate(fs.readFileSync(path.join(dir, 'leaf-a.pem'))).validTo)
  const dns = await dnsServer({ 'app.example.test': ['192.0.2.7', '192.0.2.8'], 'vide.example.test': [] })
  // closed port reserved AFTER the servers (otherwise one of them could take it again)
  const shut = await closedPort()
  const base = `http://127.0.0.1:${web.port}`
  try {
    const runs = [
      ['http 200', { type: 'http', url: `${base}/ok` }],
      ['http 200 + mot-clé présent', { type: 'http', url: `${base}/ok`, expect: { body: 'bien' } }],
      ['http 200 + mot-clé absent', { type: 'http', url: `${base}/ok`, expect: { body: 'absent' } }],
      ['http 500', { type: 'http', url: `${base}/erreur` }],
      ['http 404 sans expect', { type: 'http', url: `${base}/introuvable` }],
      ['http 404 attendu', { type: 'http', url: `${base}/introuvable`, expect: { status: 404 } }],
      ['http 404, attendus [200, 204]', { type: 'http', url: `${base}/introuvable`, expect: { status: [200, 204] } }],
      ['http 302 non suivie', { type: 'http', url: `${base}/redirige` }],
      ['http délai', { type: 'http', url: `${base}/lent` }],
      ['http port fermé', { type: 'http', url: `http://127.0.0.1:${shut}/` }],
      ['tcp ouvert', { type: 'tcp', target: `127.0.0.1:${tcpOpen.port}` }],
      ['tcp fermé', { type: 'tcp', target: `127.0.0.1:${shut}` }],
      ['dns deux adresses', { type: 'dns', server: dns.server, name: 'app.example.test' }],
      ['dns adresse attendue présente', { type: 'dns', server: dns.server, name: 'app.example.test', expect: { address: '192.0.2.8' } }],
      ['dns adresse attendue absente', { type: 'dns', server: dns.server, name: 'app.example.test', expect: { address: '192.0.2.9' } }],
      ['dns aucune adresse', { type: 'dns', server: dns.server, name: 'vide.example.test' }],
    ]
    for (const [name, c] of runs) out.push(`${name} → ${result(await runCheck(c, FAST))}`)
    // tls: injected clock, 10.5 days before the expiry of the test certificate
    const now = () => validTo - 10.5 * DAY
    const t = { type: 'tls', host: '127.0.0.1', port: tlsSrv.port }
    for (const [name, c] of [['tls J-10 (défauts 21/7)', t], ['tls J-10, warnDays 7', { ...t, warnDays: 7 }], ['tls J-10, critDays 14', { ...t, critDays: 14 }]]) {
      out.push(`${name} → ${result(await runCheck(c, { ...FAST, now }))}`)
    }
    out.push(`tls expiré → ${result(await runCheck(t, { ...FAST, now: () => validTo + 2 * DAY }))}`)
    out.push(`tls port fermé → ${result(await runCheck({ type: 'tls', host: '127.0.0.1', port: shut }, FAST))}`)
    // default period of each type (no interval in the config) and configured period
    const mcfg = parseConfig({ ...MINIMAL, services: [{ id: 'p', name: 'P', group: 'g', env: 'prod', checks: [
      { type: 'http', url: 'http://192.0.2.10/' }, { type: 'tcp', target: '192.0.2.10:22' }, { type: 'tls', host: 'site.example.test' },
      { type: 'dns', server: '192.0.2.53', name: 'example.test' }, { type: 'tcp', target: '192.0.2.10:23', interval: '5m' }] }] })
    out.push('', '# période (monitor : par défaut selon le type, sinon interval)', ...createMonitor(mcfg.config, { setTimer: () => 0 }).checks.map(c => `${c.type}${c.interval ? ` (interval ${c.interval})` : ''} : ${c.intervalSec} s`))
  } finally {
    await Promise.all([web.close(), tcpOpen.close(), tlsSrv.close(), dns.close()])
  }
  return `${out.join('\n')}\n`
}

// --- config validation errors ---------------------------------------------------------------------
const MINIMAL = { version: 2, title: 't', proxmox: [], hosts: [], groups: [{ id: 'g', name: 'G' }], services: [], alerts: {} }
const svc = extra => ({ ...MINIMAL, services: [{ id: 's', name: 'S', group: 'g', env: 'prod', url: 'http://192.0.2.1/', ...extra }] })
function configErrors() {
  const cases = [
    ['sonde de type inconnu', svc({ checks: [{ type: 'ping', host: '192.0.2.1' }] })],
    ['sonde sans type', svc({ checks: [{ url: 'http://192.0.2.1/' }] })],
    ['http sans url', svc({ checks: [{ type: 'http' }] })],
    ['http url invalide', svc({ checks: [{ type: 'http', url: 'pas une url' }] })],
    ['http champ inconnu', svc({ checks: [{ type: 'http', url: 'http://192.0.2.1/', inconnu: 1 }] })],
    ['tcp cible sans port', svc({ checks: [{ type: 'tcp', target: '192.0.2.1' }] })],
    ['tls port texte', svc({ checks: [{ type: 'tls', host: 'x.example.test', port: '443' }] })],
    ['dns attendu non IPv4', svc({ checks: [{ type: 'dns', server: '192.0.2.53', name: 'x', expect: { address: 'x' } }] })],
    ['intervalle invalide', svc({ checks: [{ type: 'tcp', target: '192.0.2.1:22', interval: '5 min' }] })],
    ['widget auth inconnue', svc({ widget: { url: 'http://192.0.2.1/', auth: { type: 'oauth', secretEnv: 'X' }, fields: [{ label: 'a', path: '/a' }] } })],
    ['widget header sans name', svc({ widget: { url: 'http://192.0.2.1/', auth: { type: 'header', secretEnv: 'X' }, fields: [{ label: 'a', path: '/a' }] } })],
    ['widget secretEnv invalide', svc({ widget: { url: 'http://192.0.2.1/', auth: { type: 'bearer', secretEnv: 'minuscule' }, fields: [{ label: 'a', path: '/a' }] } })],
    ['widget format inconnu', svc({ widget: { url: 'http://192.0.2.1/', fields: [{ label: 'a', path: '/a', format: 'octets' }] } })],
    ['widget json et prom', svc({ widget: { url: 'http://192.0.2.1/', fields: [{ label: 'a', path: '/a', json: 'x', prom: 'y' }] } })],
    ['widget sans champ', svc({ widget: { url: 'http://192.0.2.1/', fields: [] } })],
    ['version source inconnue', svc({ version: { current: { from: 'agent', package: 'x' }, latest: { from: 'gitlab', repo: 'a/b' } } })],
    ['version github repo invalide', svc({ version: { current: { from: 'agent', package: 'x' }, latest: { from: 'github', repo: 'pas-de-barre' } } })],
    ['version installée inconnue', svc({ version: { current: { from: 'ssh', cmd: 'x' } } })],
    ['version http-regex sans regex', svc({ version: { current: { from: 'http-regex', url: 'http://192.0.2.1/' } } })],
    ['version ha sans secretEnv', svc({ version: { from: 'ha', url: 'http://192.0.2.1/' } })],
  ]
  const out = []
  for (const [name, raw] of cases) {
    const r = parseConfig(raw)
    out.push(`# ${name}`, ...(r.errors ?? ['(aucune erreur)']).map(e => `- ${e}`))
  }
  return `${out.join('\n')}\n`
}

// --- widgets --------------------------------------------------------------------------------------
const SECRETS = { PIHOLE_PW: 'mdp-golden', TOKEN_B: 'jeton-b', KEY_H: 'cle-h', QB_USER: 'utilisateur-q', QB_PW: 'mdp-q', QK: 'cle-q' }
async function widgets() {
  const hits = []
  let failing = false
  const now = () => Date.now()
  const app = await listen(http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    let body = ''
    for await (const c of req) body += c
    // auth headers and parameters received, (fake) secrets masked
    const mask = v => Object.values(SECRETS).reduce((x, sec) => x.split(sec).join('<secret>'), String(v))
    const auth = ['authorization', 'x-token', 'x-api-key', 'cookie', 'x-ftl-sid'].filter(h => req.headers[h]).map(h => `${h}=${mask(req.headers[h])}`)
    const params = [...u.searchParams].map(([k, v]) => `${k}=${mask(v)}`)
    hits.push(`${req.method} ${u.pathname}${params.length ? `?${params.join('&')}` : ''} [${auth.join(', ')}]${body ? ` corps=${mask(body)}` : ''} ua=${(req.headers['user-agent'] ?? '').split('/')[0]}`)
    const json = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)) }
    if (failing && u.pathname.startsWith('/instable')) { res.statusCode = 503; return res.end() }
    switch (u.pathname) {
      // Pi-hole v6: session then read
      case '/api/auth': return req.method === 'POST' ? json({ session: { valid: true, sid: 'sid-golden' } }) : (res.statusCode = 204, res.end())
      case '/api/stats/summary': return req.headers['x-ftl-sid'] === 'sid-golden' ? json({ queries: { total: 123456, blocked: 7890, percent_blocked: 6.3912 }, clients: { active: 17 } }) : (res.statusCode = 401, res.end())
      // qBittorrent: session cookie
      case '/api/v2/auth/login': res.setHeader('set-cookie', 'SID=golden; HttpOnly; path=/'); return res.end('Ok.')
      case '/api/v2/transfer/info': return req.headers.cookie === 'SID=golden' ? json({ dl_info_speed: 1536, up_info_speed: 5 * 1024 * 1024 + 300, dht_nodes: 412 }) : (res.statusCode = 403, res.end())
      case '/bearer/etat': return req.headers.authorization === 'Bearer jeton-b' ? json({ actif: true, vu: new Date(now() - 90 * MIN).toISOString(), maj: false }) : (res.statusCode = 401, res.end())
      case '/bearer/temp': return json({ cpu: 51.26, disque: 38 })
      case '/speed/dernier': return json({ data: { download: 912.345, upload: 48.6, ping: 7.04, created_at: new Date(now() - 3 * DAY - 5 * MIN).toISOString() } })
      case '/header/sessions': return json({ MediaContainer: { size: 3, total: 1234567 } })
      case '/header/file': return json({ total: 42, attente: 0, avertissements: 2 })
      case '/header/statut': return json({ version: '1.2.3', etat: 'ok', canal: 'stable', note: 12 })
      case '/query/exp': return json({ jamais: '0001-01-01T00:00:00Z', bientot: new Date(now() + 10.5 * DAY).toISOString(), passe: new Date(now() - 2 * DAY).toISOString(), invalide: 'pas une date' })
      case '/metrics': res.setHeader('content-type', 'text/plain'); return res.end('# HELP x\nnode_load1 0.42\nhttp_requests_total{code="200"} 98765\nhttp_requests_total{code="500"} 3\n')
      case '/instable/val': return json({ n: 7 })
      case '/divers': return json({ texte: 'abc', nombre: '12,5', vide: null, liste: [1, 2, 3], zero: 0, faux: false, ms: 1234.5, pct: 99.95, mbps: 0.04 })
      default: res.statusCode = 404; return res.end()
    }
  }))
  const shut = await closedPort()
  const url = `http://127.0.0.1:${app.port}`
  const env = SECRETS
  const f = (label, p, json, format, unit) => ({ label, path: p, json, ...(format ? { format } : {}), ...(unit ? { unit } : {}) })
  const services = [
    // shapes of the 11 widgets in service (auth, formats, units), neutral data
    { id: 'dns-bloqueur', widget: { url, auth: { type: 'pihole', secretEnv: 'PIHOLE_PW' }, fields: [f('Requêtes', '/api/stats/summary', 'queries.total', 'int'), f('Bloquées', '/api/stats/summary', 'queries.percent_blocked', 'percent'), f('Clients', '/api/stats/summary', 'clients.active', 'int')] } },
    { id: 'tunnel', widget: { url, interval: '1h', auth: { type: 'bearer', secretEnv: 'TOKEN_B' }, fields: [f('Actif', '/bearer/etat', 'actif', 'bool'), f('Vu', '/bearer/etat', 'vu', 'ago'), f('MAJ', '/bearer/etat', 'maj', 'bool')] } },
    { id: 'debit', widget: { url, interval: '10m', fields: [f('Desc.', '/speed/dernier', 'data.download', 'mbps'), f('Mont.', '/speed/dernier', 'data.upload', 'mbps'), f('Ping', '/speed/dernier', 'data.ping', 'ms'), f('Mesure', '/speed/dernier', 'data.created_at', 'ago')] } },
    { id: 'sonde-temp', widget: { url, interval: '2m', auth: { type: 'bearer', secretEnv: 'TOKEN_B' }, fields: [f('CPU', '/bearer/temp', 'cpu', 'number', '°C'), f('Disque', '/bearer/temp', 'disque', 'number', '°C')] } },
    { id: 'media', widget: { url, auth: { type: 'header', name: 'X-Token', secretEnv: 'KEY_H' }, fields: [f('Sessions', '/header/sessions', 'MediaContainer.size', 'int'), f('Total', '/header/sessions', 'MediaContainer.total', 'int')] } },
    { id: 'file-a', widget: { url, auth: { type: 'header', name: 'X-Api-Key', secretEnv: 'KEY_H' }, fields: [f('Total', '/header/file', 'total', 'int'), f('Attente', '/header/file', 'attente', 'int'), f('Avert.', '/header/file', 'avertissements', 'int')] } },
    { id: 'file-b', widget: { url, interval: '2m', auth: { type: 'header', name: 'X-Api-Key', secretEnv: 'KEY_H' }, fields: [f('Total', '/header/file', 'total', 'int'), f('Attente', '/header/file', 'attente', 'int'), f('Avert.', '/header/file', 'avertissements', 'int', 'avert.')] } },
    { id: 'file-c', widget: { url, interval: '2m', auth: { type: 'header', name: 'X-Api-Key', prefix: 'Clé ', secretEnv: 'KEY_H' }, fields: [f('Total', '/header/file', 'total', 'int'), f('Attente', '/header/file', 'attente', 'int'), f('Avert.', '/header/file', 'avertissements', 'int', 'avert.')] } },
    { id: 'file-d', widget: { url, interval: '5m', auth: { type: 'header', name: 'X-Api-Key', secretEnv: 'KEY_H' }, fields: [f('Total', '/header/file', 'total', 'int'), f('Attente', '/header/file', 'attente', 'int')] } },
    { id: 'torrent', widget: { url, auth: { type: 'qbittorrent', userEnv: 'QB_USER', secretEnv: 'QB_PW' }, fields: [f('Desc.', '/api/v2/transfer/info', 'dl_info_speed', 'rate'), f('Mont.', '/api/v2/transfer/info', 'up_info_speed', 'rate'), f('Nœuds', '/api/v2/transfer/info', 'dht_nodes', 'int')] } },
    { id: 'statut', widget: { url, auth: { type: 'header', name: 'X-API-Key', secretEnv: 'KEY_H' }, fields: [f('Version', '/header/statut', 'version', 'text'), f('État', '/header/statut', 'etat', 'text'), f('Canal', '/header/statut', 'canal', 'text'), f('Note', '/header/statut', 'note', 'text')] } },
    // the rest of the engine: query, Prometheus, formats and missing values, errors, old values
    { id: 'echeances', widget: { url, auth: { type: 'query', name: 'apikey', secretEnv: 'QK' }, fields: [f('Jamais', '/query/exp', 'jamais', 'until'), f('Bientôt', '/query/exp', 'bientot', 'until'), f('Passé', '/query/exp', 'passe', 'until'), f('Invalide', '/query/exp', 'invalide', 'until'), f('Invalide (ago)', '/query/exp', 'invalide', 'ago')] } },
    { id: 'metriques', widget: { url, fields: [{ label: 'Charge', path: '/metrics', prom: 'node_load1' }, { label: 'Requêtes', path: '/metrics', prom: 'http_requests_total', format: 'int' }, { label: 'Absente', path: '/metrics', prom: 'absente' }] } },
    { id: 'divers', widget: { url, fields: [f('Texte', '/divers', 'texte', 'text'), f('Texte en nombre', '/divers', 'texte'), f('Virgule', '/divers', 'nombre'), f('Nul', '/divers', 'vide', 'int'), f('Longueur', '/divers', 'liste.length', 'int'), f('Premier', '/divers', 'liste.0'), f('Zéro', '/divers', 'zero', 'percent'), f('Faux', '/divers', 'faux', 'bool'), f('Ms', '/divers', 'ms', 'ms'), f('Pct', '/divers', 'pct', 'percent'), f('Mbps', '/divers', 'mbps', 'mbps'), f('Absent', '/divers', 'pas.la', 'text'), f('Objet', '/divers', '', 'text')] } },
    { id: 'introuvable', widget: { url, fields: [f('X', '/nulle-part', 'x')] } },
    { id: 'injoignable', widget: { url: `http://127.0.0.1:${shut}`, fields: [f('X', '/x', 'x')] } },
    { id: 'sans-secret', widget: { url, auth: { type: 'bearer', secretEnv: 'ABSENT' }, fields: [f('X', '/bearer/temp', 'cpu')] } },
    { id: 'instable', widget: { url, fields: [f('N', '/instable/val', 'n', 'int')] } },
  ]
  const cfg = { services }
  const piholes = createPiholes({ env })
  const w = createWidgets(cfg, env, { piholes })
  const out = []
  const dump = title => {
    out.push(`# ${title}`)
    for (const s of services) {
      const r = w.get(s.id)
      out.push(`${s.id} : ${r.fields.map(x => `${x.label}=${x.value}`).join(' | ') || '(aucun champ)'}${r.error ? ` ; erreur : ${r.error}` : ''}${r.stale ? ' ; anciennes valeurs' : ''}`)
    }
  }
  try {
    await w.runAll()
    dump('premier passage')
    failing = true
    await w.runAll()
    out.push('')
    dump('second passage (instable en 503)')
    out.push('', '# requêtes reçues (deux passages, uniques, triées ; secrets masqués)', ...[...new Set(hits)].sort())
    await w.stop()
  } finally {
    await app.close()
  }
  return `${out.join('\n')}\n`
}

// --- update sources -------------------------------------------------------------------------------
const NOW = Date.parse('2026-11-10T09:00:00Z')
async function updateSources() {
  const rel = (tag, extra = {}) => ({ tag, name: tag, published: '2026-10-01T00:00:00Z', prerelease: false, url: `https://releases.example.test/${tag}`, body: null, ...extra })
  const upstream = {
    github: async repo => ({
      'org/app': [rel('v2.4.1'), rel('v2.4.0'), rel('v2.3.9'), rel('v1.9.9')],
      'org/majeur': [rel('v3.0.0'), rel('v2.9.0'), rel('v2.8.5')],
      'org/tags': [],
      'org/pre': [rel('v1.1.0-rc.1', { prerelease: true }), rel('v1.0.2')],
      'org/motif': [rel('server-v5.1.0'), rel('client-v9.0.0'), rel('server-v5.0.0')],
    }[repo] ?? []),
    githubTags: async repo => ({ 'org/tags': [{ tag: '0.9.0', url: 'https://tags.example.test/0.9.0' }, { tag: '0.8.1', url: 'https://tags.example.test/0.8.1' }] }[repo] ?? []),
    giteaCom: async repo => ({ 'org/forge': [rel('v1.25.0'), rel('v1.24.6')] }[repo] ?? []),
    pypi: async pkg => ({ paquet: [{ tag: '4.0.1', published: '2026-10-02T00:00:00Z', url: 'https://pypi.example.test/4.0.1' }, { tag: '3.9.0', published: null, url: null }] }[pkg] ?? []),
    httpJson: async url => {
      const map = {
        'http://192.0.2.20/version': { version: '2.4.0' },
        'http://192.0.2.21/api': { data: { app: { ver: '2.8.5' } } },
        'http://192.0.2.22/page': { __text: '<p>Version 0.8.1 (stable)</p>' },
        'http://192.0.2.23/v': { v: '1.0.2' },
        'http://192.0.2.24/v': { v: '5.0.0' },
        'http://192.0.2.25/v': { v: '1.24.6' },
        'http://192.0.2.26/v': { v: '3.9.0' },
        'https://latest.example.test/stable.json': { stable: { version: '7.1' } },
        'http://192.0.2.27/v': { v: '7.0' },
        'http://192.0.2.28/api/states': [
          { entity_id: 'update.core', state: 'on', attributes: { title: 'Core', installed_version: '2026.10.1', latest_version: '2026.11.0', release_url: 'https://notes.example.test/core', auto_update: false } },
          { entity_id: 'update.module', state: 'off', attributes: { friendly_name: 'Module', installed_version: '1.0', latest_version: '1.0' } },
          { entity_id: 'sensor.autre', state: '1', attributes: {} },
        ],
      }
      if (url === 'http://192.0.2.29/v') throw new Error('192.0.2.29 → HTTP 500')
      if (!(url in map)) throw new Error(`url inattendue ${url}`)
      return map[url]
    },
    giteaComOnly: true, githubTagsOnly: true,
    eol: async () => [], node: async () => [], remoteDigest: async () => null, remoteTags: async () => [], pvePackages: async () => [], errors: () => [], stats: () => ({}),
  }
  const cur = (u, p) => ({ from: 'http-json', url: u, path: p })
  const raw = {
    version: 2, title: 't', proxmox: [], groups: [{ id: 'g', name: 'G' }], alerts: {},
    hosts: [{ id: 'h', name: 'hote', kind: 'appliance', env: 'prod', ip: '192.0.2.20', agent: 'ssh' }],
    services: [
      { id: 'app', name: 'App', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.20/version', 'version'), latest: { from: 'github', repo: 'org/app' } } },
      { id: 'majeur', name: 'Majeur', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.21/api', ['data', 'app', 'ver']), latest: { from: 'github', repo: 'org/majeur' }, notes: 'https://notes.example.test/majeur' } },
      { id: 'tags', name: 'Tags', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: { from: 'http-regex', url: 'http://192.0.2.22/page', regex: 'Version ([0-9.]+)' }, latest: { from: 'github', repo: 'org/tags', tags: true } } },
      { id: 'pre', name: 'Pré', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.23/v', 'v'), latest: { from: 'github', repo: 'org/pre' } } },
      { id: 'motif', name: 'Motif', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.24/v', 'v'), latest: { from: 'github', repo: 'org/motif', tagPattern: '^server-v' } } },
      { id: 'forge', name: 'Forge', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.25/v', 'v'), latest: { from: 'gitea', repo: 'org/forge' } } },
      { id: 'paquet', name: 'Paquet', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.26/v', 'v'), latest: { from: 'pypi', package: 'paquet' } } },
      { id: 'json', name: 'Json', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.27/v', 'v'), latest: { from: 'http-json', url: 'https://latest.example.test/stable.json', path: 'stable.version', notes: 'https://notes.example.test/json' } } },
      { id: 'json-absent', name: 'Json absent', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.27/v', 'v'), latest: { from: 'http-json', url: 'https://latest.example.test/stable.json', path: 'stable.absent' } } },
      { id: 'agent', name: 'Agent', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: [{ name: 'outil', current: { from: 'agent', package: 'outil' }, latest: { from: 'github', repo: 'org/app' } }, { name: 'absent', current: { from: 'agent', package: 'absent' } }, { name: 'auto', current: { from: 'agent', package: 'outil' }, auto: true }] },
      { id: 'casse', name: 'Cassé', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.29/v', 'v'), latest: { from: 'github', repo: 'org/app' } } },
      { id: 'champ', name: 'Champ', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { current: cur('http://192.0.2.20/version', 'manquant') } },
      { id: 'domo', name: 'Domotique', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { from: 'ha', url: 'http://192.0.2.28/', secretEnv: 'HA_TOKEN' } },
      { id: 'domo-off', name: 'Domotique sans jeton', group: 'g', host: 'h', url: 'http://192.0.2.20/', version: { from: 'ha', url: 'http://192.0.2.28/', secretEnv: 'HA_ABSENT' } },
    ],
  }
  const parsed = parseConfig(raw)
  if (parsed.errors) throw new Error(`config des sources de MAJ : ${parsed.errors.join(' ; ')}`)
  const cfg = parsed.config
  const agents = { hosts: cfg.hosts, get: id => (id === 'h' ? { ok: true, slow: { versions: { outil: '2.3.9' } } } : null), reports: () => [] }
  const store = openDb(tmpDir('vigie-golden-maj-src-'))
  const updates = createUpdates({ cfg, store, agents, env: { HA_TOKEN: 'jeton-ha' }, sources: { pveVersions: async () => [] }, collector: { snap: {} }, upstream, decisions: null, log: { error() {}, warn() {}, log() {} } })
  await updates.refresh(NOW)
  const keep = ['id', 'name', 'kind', 'current', 'latest', 'gap', 'latestSameMajor', 'nextMajor', 'skipped', 'url', 'publishedAt', 'notes', 'auto', 'source', 'error', 'detail']
  const list = updates.view().components.filter(c => c.service).map(c => Object.fromEntries(keep.map(k => [k, c[k] ?? null])))
  store.db.close()
  return `${JSON.stringify(list, null, 2)}\n`
}

// --- service definitions --------------------------------------------------------------------------
function serviceDefs() {
  const d = loadDefs(DEFS_FILE)
  if (!d.ok) throw new Error(d.error)
  const out = [`# fichier livré : ${d.defs.length} définitions`, `attribution : ${d.attribution}`, `ports : ${d.ports.join(' ')}`, '', '# ordre (rang · catégorie · ports · empreinte de la définition ; noms non recopiés)']
  d.defs.forEach((x, i) => out.push(`${i + 1} · ${x.category} · ${[...d.portOwners].filter(([, ids]) => ids.has(x.id)).map(([p]) => p).join(' ')} · ${createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12)}`))
  out.push('', '# statuts attendus (port chemin : statuts)')
  for (const [k, v] of expectedStatuses(d)) out.push(`${k} : ${[...v].join(' ')}`)
  out.push('', '# couples HTTP (tous les ports)', ...planCouples(d).map(c => `${c.port} ${c.path}`))
  // resolution: observations → service and confidence per port
  const resp = map => (p, pth) => map[`${p} ${pth}`] ?? null
  const ctxs = [
    ['ports nus 22 80 443', { open: new Set([22, 80, 443]), resp: resp({}) }],
    ['port 8006 seul', { open: new Set([8006]), resp: resp({}) }],
    ['port 3000 sans réponse', { open: new Set([3000]), resp: resp({}) }],
    ['port 3000, /api/healthz « pass »', { open: new Set([3000]), resp: resp({ '3000 /api/healthz': { status: 200, body: '{"status":"pass"}', headers: {}, bytes: 17 } }) }],
    ['port 3000, / « homepage »', { open: new Set([3000]), resp: resp({ '3000 /': { status: 200, body: '<title>Homepage</title>', headers: {}, bytes: 23 } }) }],
    ['port 3000, /api/health « database »', { open: new Set([3000]), resp: resp({ '3000 /api/health': { status: 200, body: '{"database":"ok"}', headers: {}, bytes: 17 } }) }],
    ['tous les ports, aucune réponse', { open: new Set(d.ports), resp: resp({}) }],
  ]
  out.push('', '# résolution (port → service, confiance)')
  for (const [name, ctx] of ctxs) {
    const r = recognise(d, { ...ctx, vendor: null, portOwners: d.portOwners })
    out.push(`${name} → ${[...r].map(([p, v]) => `${p}:${v.service}/${v.confidence}`).join(' ') || '(rien)'}`)
  }
  // format errors (file refused)
  out.push('', '# fichiers refusés')
  const bad = [
    ['JSON invalide', '{'],
    ['sans attribution', JSON.stringify({ defs: [{ id: 'a', name: 'A', category: 'c', match: { port: 1 } }] })],
    ['id en double', JSON.stringify({ attribution: 'x', defs: [{ id: 'a', name: 'A', category: 'c', match: { port: 1 } }, { id: 'a', name: 'B', category: 'c', match: { port: 2 } }] })],
    ['preuve http sur port TLS', JSON.stringify({ attribution: 'x', defs: [{ id: 'a', name: 'A', category: 'c', match: { http: { port: 443, path: '/', contains: 'x' } } }] })],
    ['sous-chaîne en majuscules', JSON.stringify({ attribution: 'x', defs: [{ id: 'a', name: 'A', category: 'c', match: { http: { port: 80, path: '/', contains: 'X' } } }] })],
    ['motif inconnu', JSON.stringify({ attribution: 'x', defs: [{ id: 'a', name: 'A', category: 'c', match: { banner: 'x' } }] })],
  ]
  for (const [name, text] of bad) out.push(`${name} → ${parseDefs(text).error}`)
  return `${out.join('\n')}\n`
}

export async function registryOutputs() {
  return {
    'probes.txt': await probes(),
    'config-errors.txt': configErrors(),
    'widgets.txt': await widgets(),
    'update-sources.json': await updateSources(),
    'service-defs.txt': serviceDefs(),
  }
}

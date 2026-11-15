// Presence analysis: computation (absences, histograms, flaps, 90th percentile,
// proposed profile, open session, list capped at 200), safe reading (link, name, size, invalid JSON),
// --out refused inside the input folder, output without IP, MAC or name, static checks.
// BUILT fixtures (RFC 5737, RFC 7042, invented names), never copied from production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyseSessions, proposeProfile, p90, loadInput, analyse, render, main } from '../scripts/presence-analyse.js'
import { tmpDir } from './tmpdir.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'scripts', 'presence-analyse.js'), 'utf8')
const T0 = Date.parse('2026-10-21T14:36:00Z')
const AT = Date.parse('2026-10-24T11:41:02Z')
const MIN = 60_000
const iso = t => new Date(t).toISOString()
// sessions: n sessions of `on` min separated by `off` min, starting at T0
const sessions = (n, on, off, { open = false } = {}) => Array.from({ length: n }, (_, i) => {
  const start = T0 + i * (on + off) * MIN
  return { start: iso(start), end: open && i === n - 1 ? null : iso(start + on * MIN), ip: '192.0.2.10', origin: 'scan' }
})
const NAMES = ['Tablette-Inventée', 'Imprimante-Fictive', 'Routeur-Démo', 'NAS-Exemple', 'Hôte-Imaginaire']
function fixture({ extra = () => {} } = {}) {
  const dir = tmpDir('dash-presence-')
  fs.mkdirSync(path.join(dir, 'devices'))
  const devices = [
    { id: 1, name: NAMES[0], mac: '00:00:5e:00:53:01', ip: '192.0.2.11', type: 'tablet', profile: 'normal', profileSet: false, alertDown: false, sessions: sessions(40, 30, 15) },
    { id: 2, name: NAMES[1], mac: '00:00:5e:00:53:02', ip: '192.0.2.12', type: 'printer', profile: 'normal', profileSet: true, alertDown: false, sessions: sessions(30, 60, 50) },
    { id: 3, name: NAMES[2], mac: '00:00:5e:00:53:03', ip: '192.0.2.13', type: 'router', profile: 'fixed', profileSet: false, alertDown: false, sessions: sessions(1, 4000, 0, { open: true }) },
    { id: 4, name: NAMES[3], mac: '00:00:5e:00:53:04', ip: '192.0.2.14', type: 'nas', profile: 'fixed', profileSet: false, alertDown: true, sessions: sessions(2, 1000, 200) },
    { id: 5, name: NAMES[4], mac: '00:00:5e:00:53:05', ip: '192.0.2.15', type: 'server', hostId: 'h1', host: { kind: 'lxc', agent: 'ssh' }, services: [{ id: 'svc-a', name: 'Service-Fictif', state: 'ok' }], profile: 'fixed', profileSet: false, alertDown: false, sessions: sessions(3, 1000, 120) },
    { id: 6, name: 'Hôte-Externe', mac: '00:00:5e:00:53:06', ip: '198.51.100.6', type: 'server', hostId: 'ext', host: { kind: 'external' }, alertDown: false, sessions: [] },
    { id: 7, name: 'Bavard', mac: '00:00:5e:00:53:07', ip: '192.0.2.17', type: 'phone', alertDown: false, sessions: sessions(200, 5, 5) },
    // bounds: absences of EXACTLY 60 min (flap); 6 flaps spread out, fewer than 3 per day
    { id: 8, name: 'Pile-Soixante', mac: '00:00:5e:00:53:08', ip: '192.0.2.18', type: 'phone', alertDown: false, sessions: sessions(10, 10, 60) },
    { id: 9, name: 'Étalé', mac: '00:00:5e:00:53:09', ip: '192.0.2.19', type: 'phone', alertDown: false, sessions: sessions(7, 560, 30) },
    // 5 flaps in 1 day (under the threshold of 6) → does not flap
    { id: 10, name: 'Cinq-Fois', mac: '00:00:5e:00:53:0a', ip: '192.0.2.20', type: 'phone', alertDown: false, sessions: sessions(6, 200, 30) },
  ]
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({ presenceSince: iso(T0), devices: devices.map(({ sessions: s, ...d }) => d) }))
  fs.writeFileSync(path.join(dir, 'history-7.json'), JSON.stringify({ days: [] }))
  fs.writeFileSync(path.join(dir, 'fetched-at.txt'), `${iso(AT)}\n`)
  for (const d of devices) fs.writeFileSync(path.join(dir, 'devices', `${d.id}.json`), JSON.stringify(d))
  extra(dir)
  return dir
}

test('computation: absences, flaps, 90th percentile, proposed profile, open session', () => {
  const r = analyseSessions(sessions(5, 30, 15, { open: true }), { from: T0, to: AT })
  assert.deepEqual(r.absences, [15, 15, 15, 15])
  assert.equal(r.durations.length, 5)
  assert.ok(r.durations[4] > 60) // open: until fetched-at, counted as a duration, never as an absence
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  assert.deepEqual(proposeProfile([3, 4, 5]), { profile: 'fixed', p90: 5, still: false })
  assert.deepEqual(proposeProfile([8, 9, 10]), { profile: 'normal', p90: 10, still: false })
  assert.deepEqual(proposeProfile([20, 40, 44]), { profile: 'sleepy', p90: 44, still: false })
  assert.deepEqual(proposeProfile([50, 55, 58]), { profile: 'sleepy', p90: 58, still: true })
  assert.equal(proposeProfile([]), null)
})

test('analysis: flapping records (≥ 6 and ≥ 3/day, list capped at 200), alertDown candidates (infra, not external, no alert, stable)', () => {
  const r = analyse(loadInput(fixture()))
  assert.deepEqual(r.flapping.map(f => [f.id, f.proposed, f.set]), [[1, 'sleepy', 'no'], [2, 'sleepy (still flapping)', 'yes'], [7, 'fixed', 'no'], [8, 'sleepy (still flapping)', 'no']])
  assert.equal(r.flapping.find(f => f.id === 8).flaps, 9) // exactly 60 min: a flap
  assert.ok(!r.flapping.some(f => f.id === 9)) // 6 flaps, but fewer than 3 per day
  assert.ok(!r.flapping.some(f => f.id === 10)) // 5 flaps: under the threshold of 6
  assert.equal(r.flapping.find(f => f.id === 7).sessions, '≥ 200')
  assert.deepEqual(r.candidates.map(c => c.id), [3, 5]) // router, lxc host; neither the already alerted NAS, nor external
  // already covered by (pve for a guest of the config, agent if the report says so, service checks)
  assert.deepEqual(r.candidates.map(c => [c.id, c.covered]), [[3, []], [5, ['pve', 'agent', 'checks']]])
  assert.match(render(r), /\| 5 \| host \(lxc\) \| 2 \| 120 \| fixed \| pve, agent, checks \|/)
  assert.equal(r.agg.devices, 10)
  assert.ok(r.agg.absences['10–20'] >= 39)
  assert.ok(r.agg.sessions['≥ 24 h'] >= 1)
})

test('safe reading: link, non-compliant name, file over 2 MiB, invalid JSON → ignored and counted', () => {
  const outside = tmpDir('dash-presence-ext-')
  fs.writeFileSync(path.join(outside, 'secret.json'), JSON.stringify({ id: 99, sessions: [] }))
  const dir = fixture({
    extra: d => {
      fs.symlinkSync(path.join(outside, 'secret.json'), path.join(d, 'devices', '99.json'))
      fs.writeFileSync(path.join(d, 'devices', 'abc.json'), '{}')
      fs.writeFileSync(path.join(d, 'devices', '98.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
      fs.writeFileSync(path.join(d, 'devices', '97.json'), '{pas du json')
      fs.writeFileSync(path.join(d, 'autre.json'), '{}')
    },
  })
  const input = loadInput(dir)
  assert.deepEqual([input.stats.notRegular, input.stats.tooBig, input.stats.invalidJson, input.stats.badName], [1, 1, 1, 2])
  assert.equal(input.devices.has(99), false)
  assert.equal(input.devices.size, 10)
})

test('output: --out inside the input folder refused; 0 IPv4, 0 MAC, 0 name; under 16 KB', () => {
  const dir = fixture()
  assert.throws(() => main(['--in', dir, '--out', path.join(dir, 'r.md')]), /refused/)
  assert.throws(() => main(['--in', dir, '--out', path.join(dir, 'devices', 'r.md')]), /refused/)
  assert.throws(() => main(['--in', dir, '--out', dir]), /refused/)
  assert.throws(() => main(['--in', dir, '--out']), /missing value/)
  // resolved links; --out linking to the input folder, --out folder linking to --in, existing --out
  const elsewhere = tmpDir('dash-presence-lien-')
  fs.symlinkSync(path.join(dir, 'network.json'), path.join(elsewhere, 'vers-entree.md'))
  assert.throws(() => main(['--in', dir, '--out', path.join(elsewhere, 'vers-entree.md')]), /link|refused/)
  fs.symlinkSync(dir, path.join(elsewhere, 'dossier-lien'))
  assert.throws(() => main(['--in', dir, '--out', path.join(elsewhere, 'dossier-lien', 'r.md')]), /refused inside the input directory/)
  fs.symlinkSync(path.join(tmpDir('dash-presence-cible-'), 'x.md'), path.join(elsewhere, 'lien-ailleurs.md'))
  assert.throws(() => main(['--in', dir, '--out', path.join(elsewhere, 'lien-ailleurs.md')]), /it is a link/)
  fs.writeFileSync(path.join(elsewhere, 'existe.md'), 'garder')
  assert.throws(() => main(['--in', dir, '--out', path.join(elsewhere, 'existe.md')]), /EEXIST/)
  assert.equal(fs.readFileSync(path.join(elsewhere, 'existe.md'), 'utf8'), 'garder')
  const out = path.join(tmpDir('dash-presence-out-'), 'analyse.md')
  const text = main(['--in', dir, '--out', out])
  assert.equal(fs.readFileSync(out, 'utf8'), text)
  assert.ok(Buffer.byteLength(text) < 16 * 1024)
  assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  assert.doesNotMatch(text, /([0-9a-f]{2}:){5}[0-9a-f]{2}/i)
  for (const n of [...NAMES, 'Hôte-Externe', 'Bavard', 'Pile-Soixante', 'Étalé', 'Service-Fictif', 'svc-a', 'Cinq-Fois']) assert.ok(!text.includes(n), n)
  assert.match(text, /## 1\. Flapping devices/)
  assert.match(text, /## 2\. Candidates for alertDown/)
  assert.match(render(analyse(loadInput(dir))), /\| 2 \| 30 \|/)
})

test('static checks: no network, no database, no import of lib/', () => {
  const code = SRC.replace(/^\s*\/\/.*$/gm, '')
  for (const bad of [/fetch\(/, /from 'node:(http|https|net|dgram|dns)'/, /node:sqlite/, /DatabaseSync/, /from '\.\.\/lib/, /require\(/]) assert.doesNotMatch(code, bad, String(bad))
  assert.deepEqual([...new Set(code.match(/from '([^']+)'/g))].sort(), ["from 'node:fs'", "from 'node:path'"])
  assert.equal((code.match(/writeFileSync\(/g) ?? []).length, 1)
})

test('threshold of 6 flaps, over a 1-day window (≥ 3 per day reached): 5 → does not flap, 6 → flaps', () => {
  const from = AT - 86_400_000
  const mk = (id, n) => [id, { id, profile: 'normal', sessions: Array.from({ length: n + 1 }, (_, i) => ({ start: iso(from + i * 60 * MIN), end: iso(from + i * 60 * MIN + 30 * MIN) })) }]
  const r = analyse({ network: { presenceSince: iso(from) }, devices: new Map([mk(1, 5), mk(2, 6)]), fetchedAt: AT, stats: { files: 0, notRegular: 0, tooBig: 0, invalidJson: 0, badName: 0 } })
  assert.deepEqual(r.flapping.map(f => [f.id, f.flaps]), [[2, 6]])
})

test('--in under a PARENT folder that is a link, --out in the REAL folder of --in → refused (realpath of --in)', () => {
  const dir = fixture() // real folder of the input
  const linkParent = path.join(tmpDir('dash-presence-parent-'), 'lien')
  fs.symlinkSync(path.dirname(dir), linkParent) // link → real parent folder of the input
  const viaLink = path.join(linkParent, path.basename(dir))
  assert.equal(fs.realpathSync(viaLink), fs.realpathSync(dir))
  assert.throws(() => main(['--in', viaLink, '--out', path.join(dir, 'r.md')]), /refused inside the input directory/)
  assert.equal(fs.existsSync(path.join(dir, 'r.md')), false)
})

// scripts/vendor-icons.mjs writes into ICONS_DIR (never into the repository), reads the config via
// CONFIG_PATH, keeps its safeguards (active SVG refused, 200 KB, slug) and writes the manifest
// sources.json (attribution). FAKE fetch: no network call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { vendorIcons, summary, slugsOf, cleanTmp, MANIFEST, MAX_BYTES, UPSTREAMS, MAX_ICONS, MAX_TOTAL_BYTES, DEADLINE_MS } from '../../scripts/vendor-icons.mjs'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts/vendor-icons.mjs')
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
const NOW = () => new Date('2026-11-08T12:00:00Z')
const quiet = { log() {}, warn() {} }
const DI = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons'
const SH = 'https://cdn.jsdelivr.net/gh/selfhst/icons'

// fake fetch: table url → body (string or Buffer); 'throw' simulates a timeout; anything else 404
function fakeFetch(table) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, signal: opts?.signal })
    const v = table[url]
    if (v === 'throw') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    if (v == null) return new Response('', { status: 404 })
    return new Response(v, { status: 200 })
  }
  return { fn, calls }
}
const cfgWith = icons => ({ services: icons.map((icon, i) => ({ id: `s${i}`, icon })), bookmarks: [{ group: 'g', items: [{ name: 'doc', icon: 'doc', url: 'https://docs.example.net' }] }] })
const mode = f => fs.statSync(f).mode & 0o777

test('vendor-icons: order of the sources (dashboard-icons svg, selfh.st svg, then png), -light variant, per-request timeout; files 0644, folder 0755', async t => {
  const out = path.join(tmpDir('dash-vendor-', t), 'icons')
  const f = fakeFetch({
    [`${DI}/svg/appli.svg`]: SVG,
    [`${DI}/svg/appli-light.svg`]: SVG,
    [`${SH}/svg/media.svg`]: SVG,
    [`${DI}/png/nas.png`]: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    [`${SH}/png/doc.png`]: 'png',
  })
  const r = await vendorIcons({ cfg: cfgWith(['appli', 'media', 'nas']), out, fetch: f.fn, now: NOW, log: quiet })
  assert.deepEqual(r.missing, [])
  assert.equal(r.downloaded, 4)
  assert.deepEqual(r.files, ['appli-light.svg', 'appli.svg', 'doc.png', 'media.svg', 'nas.png'])
  assert.equal(mode(out), 0o755)
  for (const x of r.files) assert.equal(mode(path.join(out, x)), 0o644, x)
  assert.ok(f.calls.every(c => c.signal instanceof AbortSignal), 'every request carries a timeout')
  assert.equal(summary(r), 'icons: 4 referenced, 4 downloaded, 0 missing')
  assert.deepEqual(slugsOf(cfgWith(['b', 'a', 'a'])), ['a', 'b', 'doc'])
})

test('vendor-icons: active SVG refused, over 200 KB refused, timeout → next source; invalid or not found slug → missing, normal exit', async t => {
  const out = tmpDir('dash-vendor-garde-', t)
  const f = fakeFetch({
    [`${DI}/svg/actif.svg`]: '<svg><script>alert(1)</script></svg>',
    [`${SH}/svg/actif.svg`]: '<svg onload="x()"/>',
    [`${DI}/png/actif.png`]: 'png',
    [`${DI}/svg/lourd.svg`]: `<svg>${'a'.repeat(MAX_BYTES + 1)}</svg>`,
    [`${SH}/svg/lourd.svg`]: SVG,
    [`${DI}/svg/lent.svg`]: 'throw',
    [`${SH}/svg/lent.svg`]: SVG,
  })
  const r = await vendorIcons({ cfg: cfgWith(['actif', 'lourd', 'lent', 'Pas/Un/Slug', 'inconnue']), out, fetch: f.fn, now: NOW, log: quiet })
  assert.deepEqual(r.files, ['actif.png', 'lent.svg', 'lourd.svg'])
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'lourd.svg'), 'utf8'), /aaaa/)
  assert.deepEqual(r.missing, ['Pas/Un/Slug (invalid slug)', 'doc', 'inconnue'])
  assert.equal(f.calls.filter(c => c.url.includes('Pas')).length, 0, 'invalid slug: no request')
  assert.match(summary(r), /^icons: 6 referenced, 3 downloaded, 3 missing \(Pas\/Un\/Slug \(invalid slug\), doc, inconnue: monogram shown\)$/)
  assert.equal(fs.readdirSync(out).filter(x => x.endsWith('.tmp')).length, 0, 'no temporary file left')
})

test('vendor-icons: sources.json manifest (upstream, URL, date); file taken over without a source marked; present icon not downloaded again, except with --force', async t => {
  const out = tmpDir('dash-vendor-manif-', t)
  fs.writeFileSync(path.join(out, 'ancienne.svg'), SVG) // taken over from an earlier installation
  const f = fakeFetch({ [`${DI}/svg/appli.svg`]: SVG, [`${SH}/svg/ancienne.svg`]: SVG, [`${SH}/svg/doc.svg`]: SVG })
  await vendorIcons({ cfg: cfgWith(['appli', 'ancienne']), out, fetch: f.fn, now: NOW, log: quiet })
  assert.equal(f.calls.filter(c => c.url.includes('ancienne')).length, 0, 'already present: no request')
  const m = JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8'))
  assert.match(m.note, /belong to their respective owners/)
  assert.deepEqual(m.upstreams, UPSTREAMS)
  assert.deepEqual(m.icons['appli.svg'], { slug: 'appli', upstream: 'dashboard-icons', url: `${DI}/svg/appli.svg`, at: '2026-11-08T12:00:00.000Z' })
  assert.deepEqual(m.icons['doc.svg'], { slug: 'doc', upstream: 'selfh.st', url: `${SH}/svg/doc.svg`, at: '2026-11-08T12:00:00.000Z' })
  assert.equal(m.icons['ancienne.svg'].upstream, null)
  assert.match(m.icons['ancienne.svg'].note, /source not recorded/)
  assert.equal(mode(path.join(out, MANIFEST)), 0o644)
  // second pass: nothing to download, manifest kept
  const again = fakeFetch({})
  const r2 = await vendorIcons({ cfg: cfgWith(['appli', 'ancienne']), out, fetch: again.fn, now: NOW, log: quiet })
  assert.deepEqual([again.calls.length, r2.downloaded], [0, 0])
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8')).icons['appli.svg'].upstream, 'dashboard-icons')
  // --force: the taken-over file gets its source
  await vendorIcons({ cfg: cfgWith(['appli', 'ancienne']), out, force: true, fetch: f.fn, now: NOW, log: quiet })
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8')).icons['ancienne.svg'].upstream, 'selfh.st')
})

test('vendor-icons on the command line: CONFIG_PATH and ICONS_DIR (otherwise <STATE_DIRECTORY>/icons); a one-line summary; unreadable config → exit 1', t => {
  const dir = tmpDir('dash-vendor-cli-', t)
  const cfg = path.join(dir, 'config-sans-icone.json')
  fs.writeFileSync(cfg, JSON.stringify({ services: [{ id: 'x' }], bookmarks: [] }))
  const run = env => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  const r = run({ CONFIG_PATH: cfg, ICONS_DIR: path.join(dir, 'icons') })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'icons: 0 referenced, 0 downloaded, 0 missing')
  assert.ok(fs.existsSync(path.join(dir, 'icons', MANIFEST)))
  const s = run({ CONFIG_PATH: cfg, STATE_DIRECTORY: path.join(dir, 'etat') })
  assert.equal(s.status, 0, s.stderr)
  assert.ok(fs.existsSync(path.join(dir, 'etat/icons', MANIFEST)))
  const bad = run({ CONFIG_PATH: path.join(dir, 'absente.json'), ICONS_DIR: path.join(dir, 'icons') })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /^icons: failed \(ENOENT\)/)
  // static: no more hardcoded client/public/icons path or config.json outside the default
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(src, /'client', 'public', 'icons'/)
  assert.match(src, /process\.env\.CONFIG_PATH \? path\.resolve\(process\.env\.CONFIG_PATH\) : path\.join\(ROOT, 'config\.json'\)/)
  // per-request timeout, bounded by the global deadline of the pass
  assert.match(src, /AbortSignal\.timeout\(Math\.max\(1, Math\.min\(timeoutMs, left\(\)\)\)\)/)
})

// --- caps, deadline, offline --force, cleanup of .tmp files ---------------------------------

test('vendor-icons: default caps 200 icons, 20 MiB, 120 s; beyond the icon count, clean stop and the rest "not processed"', async t => {
  assert.deepEqual([MAX_ICONS, MAX_TOTAL_BYTES, DEADLINE_MS], [200, 20 * 1024 * 1024, 120_000])
  const out = tmpDir('dash-vendor-plafond-', t)
  const names = ['a1', 'a2', 'a3', 'a4']
  const f = fakeFetch(Object.fromEntries(names.map(n => [`${DI}/svg/${n}.svg`, SVG])))
  const r = await vendorIcons({ cfg: { services: names.map((icon, i) => ({ id: `s${i}`, icon })) }, out, fetch: f.fn, now: NOW, log: quiet, maxIcons: 2 })
  assert.deepEqual([r.downloaded, r.skipped], [2, ['a3', 'a4']])
  assert.deepEqual(r.files, ['a1.svg', 'a2.svg'])
  assert.match(summary(r), /, 2 not handled \(run limit: a3, a4\)$/)
})

test('vendor-icons: volume cap (no file beyond it) and global deadline (stop, bounded request timeout)', async t => {
  const out = tmpDir('dash-vendor-volume-', t)
  const big = Buffer.alloc(150 * 1024, 0x41)
  const f = fakeFetch({ [`${DI}/png/v1.png`]: big, [`${DI}/png/v2.png`]: big, [`${DI}/png/v3.png`]: big })
  const r = await vendorIcons({ cfg: { services: ['v1', 'v2', 'v3'].map((icon, i) => ({ id: `s${i}`, icon })) }, out, fetch: f.fn, now: NOW, log: quiet, maxTotalBytes: 200 * 1024 })
  assert.equal(r.downloaded, 1)
  assert.deepEqual(r.files, ['v1.png'])
  assert.ok(r.skipped.includes('v3'), JSON.stringify(r))
  // deadline: clock advancing 100 s per read → the 2nd icon starts after the 120 s deadline
  const out2 = tmpDir('dash-vendor-echeance-', t)
  let t0 = 0
  const clock = () => (t0 += 50_000)
  const f2 = fakeFetch({ [`${DI}/svg/e1.svg`]: SVG, [`${DI}/svg/e2.svg`]: SVG, [`${DI}/svg/e3.svg`]: SVG })
  const r2 = await vendorIcons({ cfg: { services: ['e1', 'e2', 'e3'].map((icon, i) => ({ id: `s${i}`, icon })) }, out: out2, fetch: f2.fn, now: NOW, log: quiet, clock })
  assert.ok(r2.downloaded >= 1 && r2.skipped.length >= 1, JSON.stringify(r2))
  assert.match(summary(r2), /not handled/)
})

test('vendor-icons --force offline: present icons kept and counted apart, never "missing"; .tmp files of an interrupted pass deleted', async t => {
  const out = tmpDir('dash-vendor-horsligne-', t)
  const f = fakeFetch({ [`${DI}/svg/appli.svg`]: SVG })
  await vendorIcons({ cfg: cfgWith(['appli']), out, fetch: f.fn, now: NOW, log: quiet })
  assert.ok(fs.existsSync(path.join(out, 'appli.svg')))
  fs.writeFileSync(path.join(out, '.appli.svg.tmp'), 'reste')
  fs.writeFileSync(path.join(out, 'garder.txt'), 'pas un tmp')
  const offline = fakeFetch({ [`${DI}/svg/appli.svg`]: 'throw', [`${SH}/svg/appli.svg`]: 'throw' })
  const r = await vendorIcons({ cfg: cfgWith(['appli']), out, force: true, fetch: offline.fn, now: NOW, log: quiet })
  assert.deepEqual([r.downloaded, r.kept, r.missing], [0, ['appli'], ['doc']])
  assert.ok(fs.existsSync(path.join(out, 'appli.svg')), 'icon kept')
  assert.equal(fs.existsSync(path.join(out, '.appli.svg.tmp')), false)
  assert.ok(fs.existsSync(path.join(out, 'garder.txt')))
  assert.match(summary(r), /^icons: 2 referenced, 0 downloaded, 1 missing \(doc: monogram shown\), 1 kept \(download again failed: appli\)$/)
  assert.equal(cleanTmp(out), 0)
})

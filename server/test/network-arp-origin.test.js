// Check of the arp file's ORIGIN before any read: symbolic link, permissions, size, owner;
// no error message contains an excerpt of the content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readArp } from '../lib/network/sources/arp.js'
import { parseCidr } from '../lib/net/ip.js'
import { arpProbe, r3Bench, OTHER_UID } from './network-fixture.js'
import { tmpDir } from './tmpdir.js'

const T = Date.parse('2026-10-21T10:00:00Z')
const cidrs = [parseCidr('192.0.2.0/24')]
const SECRET = 'SECRET-192.0.2.77-contenu'
const read = (file, o = {}) => readArp({ file, cidrs, now: T, uid: OTHER_UID, ...o })
const refusal = (fn, re) => {
  let err = null
  try {
    fn()
  } catch (e) {
    err = e
  }
  assert.ok(err, 'refusal expected')
  assert.match(err.message, re)
  assert.doesNotMatch(err.message, /SECRET|192\.0\.2\.77/)
}

test('symbolic link refused (file and directory)', () => {
  const p = arpProbe()
  const target = path.join(p.dir, 'cible.json')
  fs.writeFileSync(target, SECRET, { mode: 0o644 })
  fs.symlinkSync(target, p.file)
  refusal(() => read(p.file), /fichier arp refusé : lien/)
  const q = arpProbe()
  const link = path.join(q.dir, 'lien')
  fs.symlinkSync(p.dir, link)
  refusal(() => read(path.join(link, 'cible.json')), /fichier arp refusé : répertoire/)
})

test('permissions: file 0666 refused, directory 0777 refused', () => {
  const p = arpProbe()
  p.raw(SECRET)
  fs.chmodSync(p.file, 0o666)
  refusal(() => read(p.file), /fichier arp refusé : permissions/)
  fs.chmodSync(p.file, 0o644)
  fs.chmodSync(p.dir, 0o777)
  refusal(() => read(p.file), /fichier arp refusé : permissions du répertoire/)
})

test('2 MB file refused WITHOUT reading; not a regular file refused', () => {
  const p = arpProbe()
  p.raw(`${SECRET}${'x'.repeat(2 * 1024 * 1024)}`)
  let reads = 0
  const spy = { ...fs, constants: fs.constants, readFileSync: (...a) => { reads++; return fs.readFileSync(...a) }, readSync: (...a) => { reads++; return fs.readSync(...a) } }
  refusal(() => read(p.file, { fs: spy }), /fichier arp refusé : trop gros/)
  assert.equal(reads, 0)
  const q = arpProbe()
  fs.mkdirSync(q.file)
  refusal(() => read(q.file), /fichier arp refusé : pas un fichier régulier/)
})

test('owner = dashboard uid → refused; owner other than the directory\'s → refused', () => {
  const p = arpProbe()
  p.raw(SECRET)
  refusal(() => read(p.file, { uid: process.getuid() }), /fichier arp refusé : propriétaire/)
  // directory and file with different owners (simulated: fstat of another uid)
  const other = { ...fs, constants: fs.constants, fstatSync: fd => Object.assign(fs.fstatSync(fd), { uid: OTHER_UID + 1 }) }
  refusal(() => read(p.file, { fs: other }), /fichier arp refusé : propriétaire/)
})

test('unreadable content: the error never quotes the content', () => {
  const p = arpProbe()
  p.raw(`{"v":1,"ts":${T},"ok":true,"hosts":[{"ip":"${SECRET}"`)
  const r = read(p.file)
  assert.equal(r.ok, false)
  assert.doesNotMatch(r.error, /SECRET|192\.0\.2\.77/)
})

// Fixtures in mkdtemp and simulated owners (injected lstat / fstat), never real system
// paths, which vary from one machine to another
test('real production case (DynamicUser) → /run/net-scan linking to a 0700 directory, file 65534: refused without reading', async () => {
  const priv = arpProbe() // the real directory, like /run/private/net-scan
  fs.chmodSync(priv.dir, 0o700)
  priv.write(T, [{ ip: '192.0.2.40', mac: '00:00:5e:00:53:40' }])
  const run = tmpDir('dash-run-')
  const link = path.join(run, 'net-scan')
  fs.symlinkSync(priv.dir, link)
  let reads = 0
  const nobody = { ...fs, constants: fs.constants,
    lstatSync: p => Object.assign(fs.lstatSync(p), p.startsWith(priv.dir) ? { uid: 65534 } : {}),
    fstatSync: fd => Object.assign(fs.fstatSync(fd), { uid: 65534 }),
    readFileSync: (...a) => { reads++; return fs.readFileSync(...a) } }
  refusal(() => read(path.join(link, 'arp.json'), { fs: nobody }), /fichier arp refusé : répertoire \(lien ou type\)/)
  assert.equal(reads, 0)
  // in the module: not installed while nothing is valid → source_error null, 0 messages
  const b = r3Bench({ T, probe: { ...priv, file: path.join(link, 'arp.json') } })
  await b.run(20)
  assert.equal(b.store.kv.get('network.presenceSince'), null)
  assert.match(b.network.view().sources.arp.error, /répertoire \(lien ou type\)/)
  assert.equal(b.network.signals(b.clock.t).find(s => s.key === 'source_error:network/arp').cond, null)
  assert.deepEqual([b.outbox(), b.telegram.sent.length], [0, 0])
})

test('directory and file owners: net-scan system account accepted, root (fallback) accepted, process uid refused', () => {
  const p = arpProbe()
  p.write(T, [{ ip: '192.0.2.40', mac: '00:00:5e:00:53:40' }])
  const owner = uid => ({ ...fs, constants: fs.constants,
    lstatSync: q => Object.assign(fs.lstatSync(q), { uid }), fstatSync: fd => Object.assign(fs.fstatSync(fd), { uid }) })
  // dashboard process simulated (uid 999, as in production): deterministic, including under
  // `unshare -r` where the real process becomes root
  const DASHBOARD = 999
  // net-scan: fixed system account (here 990), directory 0755 and file 0644
  for (const uid of [990, 0]) {
    const r = readArp({ file: p.file, cidrs, now: T, uid: DASHBOARD, fs: owner(uid) })
    assert.deepEqual([r.installed, r.ok, r.hosts.length], [true, true, 1], `uid ${uid}`)
  }
  assert.deepEqual(fs.statSync(p.dir).mode & 0o777, 0o755)
  assert.deepEqual(fs.statSync(p.file).mode & 0o777, 0o644)
  // owner = process uid: refused; by default this uid is process.getuid() (not hard-coded)
  refusal(() => readArp({ file: p.file, cidrs, now: T, uid: DASHBOARD, fs: owner(DASHBOARD) }), /fichier arp refusé : propriétaire/)
  refusal(() => readArp({ file: p.file, cidrs, now: T, fs: owner(process.getuid()) }), /fichier arp refusé : propriétaire/)
})

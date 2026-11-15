// Temporary directories of the tests: deletion after the test, database
// closed before; a marked root per process (owner.json); DEAD roots reclaimed by the next
// run, on proof (boot, /proc/<pid>, start), never those of a live process, of my
// PID, of another user or through a link; atomic claim between cleaners.
// Everything happens in a PRIVATE TMPDIR (child processes), never in the shared /tmp.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir, tmpStore, rootDir, reapStale, procStart, bootId, pidNs } from './tmpdir.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MOD = JSON.stringify(path.join(here, 'tmpdir.js'))
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning']
const openIn = dir => fs.readdirSync('/proc/self/fd').map(fd => {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`)
  } catch {
    return ''
  }
}).filter(l => l.startsWith(dir))
const roots = tmp => fs.readdirSync(tmp).filter(n => /^dash-(run|reap)-/.test(n)).sort()
// node child in a private TMPDIR; NODE_TEST_CONTEXT removed (otherwise it reports to the parent)
const envOf = tmp => {
  const env = { ...process.env, TMPDIR: tmp }
  delete env.NODE_TEST_CONTEXT
  return env
}
const child = (tmp, code) => {
  try {
    return { code: 0, out: execFileSync(NODE[0], [...NODE.slice(1), '--input-type=module', '-e', code], { env: envOf(tmp), encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    return { code: e.status ?? e.signal, out: String(e.stdout ?? '') }
  }
}
// root forged in tmp: name, marker (or nothing), content
function forge(tmp, { pid, start, boot = bootId(), pidns = pidNs(), marker = true, suffix = Math.random().toString(36).slice(2, 8).padEnd(6, 'x') }) {
  const dir = path.join(tmp, `dash-run-${pid}-${suffix}`)
  fs.mkdirSync(dir)
  fs.mkdirSync(path.join(dir, 'base'))
  fs.writeFileSync(path.join(dir, 'base', 'dashboard.db'), 'x')
  if (marker) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid, start, boot, pidns }))
  return dir
}

test('tmpDir and tmpStore: under the process root, deleted after the test, database closed before; marker written', async t => {
  let dir
  let store
  await t.test('creation', st => {
    dir = tmpDir('dash-tmpdir-a-', st)
    store = tmpStore('dash-tmpdir-b-', st)
    store.kv.set('x', '1')
    assert.equal(path.dirname(dir), rootDir())
    assert.ok(openIn(store.tmpDir).length > 0)
  })
  assert.equal(fs.existsSync(dir), false)
  assert.equal(fs.existsSync(store.tmpDir), false)
  assert.deepEqual(openIn(store.tmpDir), [])
  assert.throws(() => store.db.prepare('SELECT 1'))
  assert.match(path.basename(rootDir()), new RegExp(`^dash-run-${process.pid}-[A-Za-z0-9]{6}$`))
  const m = JSON.parse(fs.readFileSync(path.join(rootDir(), 'owner.json'), 'utf8'))
  assert.deepEqual(m, { pid: process.pid, start: procStart(process.pid), boot: bootId(), pidns: pidNs() })
})

test('failing suite: the exit safety net deletes the whole root (private TMPDIR)', () => {
  const tmp = tmpDir('dash-priv-')
  const file = path.join(tmpDir('dash-work-'), 'echec.test.mjs')
  fs.writeFileSync(file, `import { test } from 'node:test'
import { tmpDir, tmpStore } from ${MOD}
test('échoue', t => { tmpDir('a-'); tmpStore('b-', t).kv.set('a', '1'); tmpStore('c-'); throw new Error('échec voulu') })
`)
  let failed = false
  try {
    execFileSync(NODE[0], [...NODE.slice(1), '--test', file], { stdio: 'pipe', env: envOf(tmp) })
  } catch {
    failed = true
  }
  assert.ok(failed)
  assert.deepEqual(roots(tmp), [])
})

test('run killed by SIGKILL: its root stays, then is cleaned up by the next run (module load)', () => {
  const tmp = tmpDir('dash-priv-')
  const r = child(tmp, `import { tmpStore } from ${MOD}; tmpStore('k-').kv.set('a', '1'); process.kill(process.pid, 'SIGKILL')`)
  assert.equal(r.code, 'SIGKILL')
  assert.equal(roots(tmp).length, 1)
  child(tmp, `import ${MOD}`) // next run: reapStale on load
  assert.deepEqual(roots(tmp), [])
})

test('proofs of death: finished child → deleted; my PID → kept; live PID with a different start → deleted; different boot → deleted', () => {
  const tmp = tmpDir('dash-priv-')
  // child started then finished (root left by SIGKILL)
  child(tmp, `import { tmpDir } from ${MOD}; tmpDir('x-'); process.kill(process.pid, 'SIGKILL')`)
  const ended = roots(tmp)[0]
  // root of MY PID, even with a marker that would say it is dead (wrong boot): never deleted
  const mine = path.basename(forge(tmp, { pid: process.pid, start: procStart(process.pid), boot: 'faux' }))
  const reused = path.basename(forge(tmp, { pid: process.ppid, start: procStart(process.ppid) + 1 }))
  const reboot = path.basename(forge(tmp, { pid: process.ppid, start: procStart(process.ppid), boot: '00000000-0000-0000-0000-000000000000' }))
  const alive = path.basename(forge(tmp, { pid: process.ppid, start: procStart(process.ppid) }))
  const r = reapStale({ tmp })
  assert.deepEqual(r.reaped.sort(), [ended, reboot, reused].sort())
  assert.deepEqual(roots(tmp).sort(), [alive, mine].sort())
})

test('missing marker (< 24 h kept, > 24 h deleted); marker that is a link → kept; different uid → kept', () => {
  const tmp = tmpDir('dash-priv-')
  const young = path.basename(forge(tmp, { pid: 999_999, start: 1, marker: false }))
  const old = forge(tmp, { pid: 999_998, start: 1, marker: false })
  const past = (Date.now() - 25 * 3600_000) / 1000
  fs.utimesSync(old, past, past)
  const linked = forge(tmp, { pid: 999_997, start: 1, marker: false })
  const elsewhere = tmpDir('dash-ext-')
  fs.writeFileSync(path.join(elsewhere, 'm.json'), JSON.stringify({ pid: 999_997, start: 1, boot: 'autre' }))
  fs.symlinkSync(path.join(elsewhere, 'm.json'), path.join(linked, 'owner.json'))
  const r = reapStale({ tmp })
  assert.deepEqual(r.reaped, [path.basename(old)])
  assert.ok(roots(tmp).includes(young) && roots(tmp).includes(path.basename(linked)))
  // different uid (injected lstat): never touched, even when proven dead
  // (proven dead AND older than 24 h: nothing but the uid protects it)
  const foreignDir = forge(tmp, { pid: 999_996, start: 1, boot: 'autre' })
  fs.utimesSync(foreignDir, past, past)
  const foreign = path.basename(foreignDir)
  const lstat = p => {
    const st = fs.lstatSync(p)
    return p.includes(foreign) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 }) : st
  }
  assert.ok(!reapStale({ tmp, lstat }).reaped.includes(foreign))
  assert.ok(roots(tmp).includes(foreign))
})

test('links: root that is a link → neither followed nor touched; inner link to the outside → target intact', () => {
  const tmp = tmpDir('dash-priv-')
  const outside = tmpDir('dash-ext-')
  fs.writeFileSync(path.join(outside, 'précieux'), 'garder')
  fs.symlinkSync(outside, path.join(tmp, 'dash-run-999995-lienxx'))
  const dead = forge(tmp, { pid: 999_994, start: 1, boot: 'autre' })
  fs.symlinkSync(outside, path.join(dead, 'vers-dehors'))
  const r = reapStale({ tmp })
  assert.deepEqual(r.reaped, [path.basename(dead)])
  assert.ok(fs.lstatSync(path.join(tmp, 'dash-run-999995-lienxx')).isSymbolicLink())
  assert.equal(fs.readFileSync(path.join(outside, 'précieux'), 'utf8'), 'garder')
})

test('two concurrent cleaners (2 processes): no error, each root deleted only once', async () => {
  const tmp = tmpDir('dash-priv-')
  const dead = Array.from({ length: 60 }, (_, i) => path.basename(forge(tmp, { pid: 900_000 + i, start: 1, boot: 'autre' })))
  const code = `import { reapStale } from ${MOD}; const r = reapStale(); process.stdout.write(JSON.stringify(r.reaped))`
  const run = () => new Promise(resolve => {
    const c = spawn(NODE[0], [...NODE.slice(1), '--input-type=module', '-e', code], { env: envOf(tmp) })
    let out = ''
    c.stdout.on('data', d => { out += d })
    c.on('exit', status => resolve({ status, out }))
  })
  const [a, b] = await Promise.all([run(), run()])
  assert.deepEqual([a.status, b.status], [0, 0])
  // each child has already cleaned up on load; the sum of the claims won = 60, without duplicates
  const all = [...JSON.parse(a.out || '[]'), ...JSON.parse(b.out || '[]')]
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual(roots(tmp), [])
  assert.ok(dead.length === 60)
})

test('LIVE parallel suite (sleeping child): its root stays intact while another one cleans up', async () => {
  const tmp = tmpDir('dash-priv-')
  const c = spawn(NODE[0], [...NODE.slice(1), '--input-type=module', '-e', `import { tmpStore } from ${MOD}; tmpStore('vivant-').kv.set('a', '1'); process.stdout.write('prêt'); setTimeout(() => {}, 30000)`], { env: envOf(tmp) })
  try {
    await new Promise(resolve => c.stdout.once('data', resolve))
    const before = roots(tmp)
    assert.equal(before.length, 1)
    forge(tmp, { pid: 999_993, start: 1, boot: 'autre' })
    const r = child(tmp, `import { reapStale } from ${MOD}; process.stdout.write(JSON.stringify(reapStale()))`)
    assert.equal(r.code, 0)
    assert.deepEqual(roots(tmp), before) // the live root stays, the dead one is gone
    assert.ok(fs.existsSync(path.join(tmp, before[0], 'owner.json')))
  } finally {
    c.kill('SIGKILL')
  }
})

test('static check: no mkdtemp in server/test outside tmpdir.js', () => {
  const offenders = fs.readdirSync(here).filter(f => /\.(js|mjs)$/.test(f) && f !== 'tmpdir.js')
    .filter(f => /\bmkdtemp(Sync)?\s*\(/.test(fs.readFileSync(path.join(here, f), 'utf8').replace(/\/\/.*$/gm, '')))
  assert.deepEqual(offenders.filter(f => f !== 'tmpdir.test.js'), [])
  void os
})

test('marker from ANOTHER PID namespace, pid missing here → root KEPT (only the boot proof counts)', () => {
  const tmp = tmpDir('dash-priv-')
  const other = path.basename(forge(tmp, { pid: 999_992, start: 1, pidns: 'pid:[4026500000]' }))
  const noNs = path.basename(forge(tmp, { pid: 999_991, start: 1, pidns: null }))
  const otherReboot = path.basename(forge(tmp, { pid: 999_990, start: 1, pidns: 'pid:[4026500000]', boot: 'autre' }))
  const sameNsDead = path.basename(forge(tmp, { pid: 999_989, start: 1 }))
  const r = reapStale({ tmp })
  assert.deepEqual(r.reaped.sort(), [otherReboot, sameNsDead].sort())
  assert.ok(roots(tmp).includes(other) && roots(tmp).includes(noNs))
})

test('unreadable current boot (null) → no root judged dead on the boot: root of a LIVE process kept', async () => {
  const tmp = tmpDir('dash-priv-')
  const c = spawn(NODE[0], [...NODE.slice(1), '--input-type=module', '-e', `import { tmpDir } from ${MOD}; tmpDir('vivant-'); process.stdout.write('prêt'); setTimeout(() => {}, 30000)`], { env: envOf(tmp) })
  try {
    await new Promise(resolve => c.stdout.once('data', resolve))
    const live = roots(tmp)
    assert.equal(live.length, 1)
    const r = reapStale({ tmp, boot: null })
    assert.deepEqual(r.reaped, [])
    assert.deepEqual(roots(tmp), live)
  } finally {
    c.kill('SIGKILL')
  }
})

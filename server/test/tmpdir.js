// Temporary directories of the tests: the ONLY place in server/test
// that calls mkdtemp.
//
// One ROOT per test process: os.tmpdir()/dash-run-<pid>-XXXXXX/, marked by
// owner.json ({ pid, start, boot }, written atomically BEFORE any test directory);
// all directories of the process are created under it. They are deleted:
// - after the test, if a context t is given (t.after also runs after a failure);
// - and by the process.on('exit') safety net (synchronous), which closes the databases then deletes the root.
// A KILLED run (SIGKILL, SIGTERM) does not run this safety net: its root is reclaimed by the NEXT run,
// when the module loads (reapStale), without a signal handler. A root is deleted
// only if the death of its process is PROVEN (different boot, /proc/<pid> missing, or PID
// reused: different start) — never on the PID alone, never another user's,
// never by following a link; deletion goes through an atomic claim (rename).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../lib/db.js'

const RUN = /^dash-run-(\d+)-[A-Za-z0-9]{6}$/
const REAP = /^dash-reap-(\d+)-(dash-run-\d+-[A-Za-z0-9]{6})$/
const DAY_MS = 86400_000
const MAX_ROOTS = 200
const CLK_TCK = 100 // Linux USER_HZ (field 22 of /proc/<pid>/stat, in ticks)

// field 22 (starttime) of /proc/<pid>/stat, or null if the process does not exist
export function procStart(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19])
  } catch {
    return null
  }
}
export function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}
// current PID namespace: /proc/<pid> only makes sense within the same namespace
export function pidNs() {
  try {
    return fs.readlinkSync('/proc/self/ns/pid')
  } catch {
    return null
  }
}
function bootTimeMs() {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))
    return m ? Number(m[1]) * 1000 : null
  } catch {
    return null
  }
}

// marker of a root: regular file (not a link), < 1 KB, same uid, valid JSON → object
// or null
function readMarker(dir, { lstat, uid }) {
  try {
    const file = path.join(dir, 'owner.json')
    const st = lstat(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size >= 1024 || st.uid !== uid) return null
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isInteger(m?.pid) && Number.isFinite(m?.start) && typeof m?.boot === 'string' && (m.pidns == null || typeof m.pidns === 'string') ? m : null
  } catch {
    return null
  }
}

// cleanup of the dead roots of os.tmpdir() (or of tmp); injectable functions (tests);
// → { reaped: [names], kept: [names] }. Never throws.
export function reapStale({ tmp = os.tmpdir(), me = process.pid, uid = process.getuid(), lstat = fs.lstatSync, now = Date.now(),
  start = procStart, boot = bootId(), btime = bootTimeMs(), ns = pidNs() } = {}) {
  const out = { reaped: [], kept: [] }
  let names
  try {
    names = fs.readdirSync(tmp)
  } catch {
    return out
  }
  let n = 0
  for (const name of names) {
    const run = RUN.exec(name)
    const reap = REAP.exec(name)
    if (!run && !reap) continue
    if (++n > MAX_ROOTS) break
    try {
      const full = path.join(tmp, name)
      const st = lstat(full)
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) {
        out.kept.push(name)
        continue
      }
      let dead = false
      if (run) {
        const pid = Number(run[1])
        if (pid === me) {
          out.kept.push(name)
          continue
        }
        const m = readMarker(full, { lstat, uid })
        if (m) {
          // pid and start prove nothing outside MY PID namespace (or if it is
          // unknown); only the boot proof then remains valid
          const sameNs = m.pidns != null && ns != null && m.pidns === ns
          const cur = sameNs ? start(m.pid) : undefined
          // an UNKNOWN (unreadable) current boot never proves anything
          dead = (boot != null && m.boot !== boot) || (sameNs && (cur == null || cur !== m.start))
        } else {
          dead = now - st.mtimeMs > DAY_MS // creation interrupted more than 24 h ago
        }
      } else {
        // claim of a dead claimant: claimant PID missing, or reused (process
        // started AFTER the claim, according to starttime and the system boot time)
        const pid = Number(reap[1])
        if (pid === me) {
          out.kept.push(name)
          continue
        }
        const cur = start(pid)
        dead = cur == null || (btime != null && btime + (cur / CLK_TCK) * 1000 > st.ctimeMs)
      }
      if (!dead) {
        out.kept.push(name)
        continue
      }
      const claimed = path.join(tmp, `dash-reap-${me}-${run ? name : reap[2]}`)
      try {
        fs.renameSync(full, claimed) // a single process wins
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EEXIST' || e.code === 'ENOTEMPTY') continue
        throw e
      }
      fs.rmSync(claimed, { recursive: true, force: true }) // links are deleted without being followed
      out.reaped.push(name)
    } catch {
      out.kept.push(name)
    }
  }
  return out
}

// on load: a single pass (the runs killed before this one)
reapStale()

let root = null
const dirs = new Map() // directory → Set(databases open inside)

// root of this process, created on first need; marker written before any directory
export function rootDir() {
  if (root) return root
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `dash-run-${process.pid}-`))
  const tmp = path.join(r, 'owner.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, start: procStart(process.pid), boot: bootId(), pidns: pidNs() }), { mode: 0o600 })
  fs.renameSync(tmp, path.join(r, 'owner.json'))
  root = r
  return r
}

function closeStore(store) {
  try {
    store.db.close()
  } catch { /* already closed: no effect */ }
}
function removeDir(dir) {
  for (const s of dirs.get(dir) ?? []) closeStore(s)
  dirs.delete(dir)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* already gone */ }
}
process.on('exit', () => {
  for (const dir of [...dirs.keys()]) removeDir(dir)
  if (root) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch { /* already gone */ }
  }
})

// new directory under the process root; t: test context (optional)
export function tmpDir(prefix = 'dash-', t = null) {
  const dir = fs.mkdtempSync(path.join(rootDir(), prefix))
  dirs.set(dir, new Set())
  if (t?.after) t.after(() => removeDir(dir))
  return dir
}

// new WORLD-READABLE directory (0755), directly under os.tmpdir() and not under the private
// root (0700) of the process: for a bench run as another user (nobody). Deleted like
// the others (t.after, then on exit); a killed process leaves it (no marker or reap)
export function sharedTmpDir(prefix = 'dash-shared-', t = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`))
  fs.chmodSync(dir, 0o755)
  dirs.set(dir, new Set())
  if (t?.after) t.after(() => removeDir(dir))
  return dir
}

// database open on a tmpDir directory (opened elsewhere, by openDb): closed before the
// directory is deleted
export function trackStore(store, dir) {
  if (dirs.has(dir)) dirs.get(dir).add(store)
  return store
}

// test database on a new directory, closed before deletion
export function tmpStore(prefix = 'dash-', t = null) {
  const dir = tmpDir(prefix, t)
  const store = openDb(dir)
  trackStore(store, dir)
  store.tmpDir = dir
  return store
}

// dash-report and net-scan agents (agent/), single source. Identity of the dash-report body
// with the pinned version (fixed sha256, method of agent/README.md), benches of both agents (test.sh,
// fake binaries, no network and no privilege), shellcheck when it is installed.
// As root (CI container, host runner of the infra deployment), the benches, which refuse root, run
// as the nobody user (setpriv, util-linux) from a FRESH copy of agent/: the deployment clone is in a
// 0700 folder (mktemp, umask 077) that nobody cannot traverse. The copy has explicit permissions
// (folders 0755, files 0644, 0755 for executables), independent of the umask, and is removed
// afterwards. Never skipped, never as root. AGENT_BENCH_COPY=1 forces the copy without root
// (simulation of the root path, except for the user change).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir, sharedTmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT = path.join(ROOT, 'agent')
// sha256 of the body of dash-report v9 (from the first line that does not start with "#"); any
// change to the body changes it and requires a new report version (agent/README.md)
export const DASH_REPORT_BODY_SHA256 = '14789bc734784797d37881399cef53bfd42f34faa32755451029c8f63424a2e7'

// same cut as the command of agent/README.md: awk 'b || !/^#/ { b = 1; print }'
export function bodyOf(text) {
  const lines = text.split('\n')
  const i = lines.findIndex(l => !l.startsWith('#'))
  return i < 0 ? '' : lines.slice(i).join('\n')
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

test('dash-report: #!/bin/sh on line 1, body identical to the pinned version (fixed sha256), REPORT_VERSION 9, same cut as awk', () => {
  const text = fs.readFileSync(path.join(AGENT, 'dash-report/dash-report'), 'utf8')
  // the header is outside the hash, but line 1 picks the interpreter and its options: required
  assert.equal(text.split('\n')[0], '#!/bin/sh')
  assert.equal(sha256(bodyOf(text)), DASH_REPORT_BODY_SHA256)
  assert.match(bodyOf(text), /^set -u\nPATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\n/)
  assert.match(text, /^REPORT_VERSION=9$/m)
  // the documented awk command gives the same value
  const awk = spawnSync('sh', ['-c', `awk 'b || !/^#/ { b = 1; print }' "$1" | sha256sum`, 'sh', path.join(AGENT, 'dash-report/dash-report')], { encoding: 'utf8' })
  assert.equal(awk.stdout.split(' ')[0], DASH_REPORT_BODY_SHA256)
})

// fresh copy of src (agent/) in a temporary folder readable by everyone: explicit permissions,
// independent of the umask and of the permissions of the source → root folder of the copy
export function benchCopy(src = AGENT) {
  // no symbolic link: chmod follows links, and the copy runs as root in the deployment
  const links = []
  const scan = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) links.push(p); else if (e.isDirectory()) scan(p) } }
  scan(src)
  if (links.length) throw new Error(`symbolic link refused in agent/: ${links.map(l => path.relative(src, l)).join(', ')}`)
  const dir = sharedTmpDir('vigie-agent-bench-')
  const dst = path.join(dir, 'agent')
  fs.cpSync(src, dst, { recursive: true })
  const fix = (s, d) => {
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name)
      const dp = path.join(d, e.name)
      if (e.isDirectory()) {
        fs.chmodSync(dp, 0o755)
        fix(sp, dp)
      } else fs.chmodSync(dp, fs.statSync(sp).mode & 0o100 ? 0o755 : 0o644)
    }
  }
  fs.chmodSync(dst, 0o755)
  fix(src, dst)
  fs.chmodSync(dir, 0o755)
  return dir
}

// bench of an agent; as root, run as nobody (setpriv) from a copy; → { status, out }
function bench(dir, env = {}) {
  const root = process.getuid?.() === 0
  if (root && !has('setpriv')) return { status: 99, out: 'bench as root without setpriv (util-linux): it cannot run as nobody (intended failure, never a skip)' }
  const copy = root || process.env.AGENT_BENCH_COPY === '1' ? benchCopy() : null
  try {
    const script = path.join(copy ? path.join(copy, 'agent') : AGENT, dir, 'test.sh')
    const base = { PATH: process.env.PATH, LC_ALL: 'C.UTF-8', HOME: os.tmpdir(), TMPDIR: os.tmpdir(), ...env }
    const [cmd, args] = root ? ['setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', '--', 'sh', script]] : ['sh', [script]]
    const r = spawnSync(cmd, args, { env: base, cwd: os.tmpdir(), encoding: 'utf8', timeout: 120_000 })
    return { status: r.status, out: `${copy ? `(copy ${copy}${root ? ', nobody' : ''})\n` : ''}${r.stdout}${r.stderr}` }
  } finally {
    if (copy) fs.rmSync(copy, { recursive: true, force: true })
  }
}

test('copy of the benches: from a source unreadable by others (umask 077, 0700 folder), explicit permissions; executables kept; symbolic link refused; copy removed', () => {
  // source simulated like the deployment clone: 0700 folder, 0600 files, 0700 executables
  const src = tmpDir('vigie-src-077-')
  try {
    fs.cpSync(AGENT, path.join(src, 'agent'), { recursive: true })
    const lock = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { lock(p); fs.chmodSync(p, 0o700) } else fs.chmodSync(p, fs.statSync(p).mode & 0o100 ? 0o700 : 0o600)
      }
    }
    lock(path.join(src, 'agent'))
    fs.chmodSync(path.join(src, 'agent'), 0o700)
    fs.chmodSync(src, 0o700)
    // a symbolic link in the source: copy refused, nothing created
    fs.symlinkSync('/etc/hostname', path.join(src, 'agent', 'link'))
    assert.throws(() => benchCopy(path.join(src, 'agent')), /symbolic link refused in agent\/: link/)
    fs.unlinkSync(path.join(src, 'agent', 'link'))
    const copy = benchCopy(path.join(src, 'agent'))
    try {
      const all = []
      const walk = d => { all.push(d); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : all.push(p) } }
      walk(copy)
      for (const p of all) {
        const m = fs.statSync(p).mode
        if (fs.statSync(p).isDirectory()) assert.equal(m & 0o777, 0o755, p)
        else assert.ok((m & 0o004) && !(m & 0o022), `${p} readable by others, never writable`)
      }
      for (const f of ['dash-report/test.sh', 'dash-report/dash-report', 'dash-report/test/fake/docker', 'net-scan/test.sh', 'net-scan/net-scan']) {
        assert.equal(fs.statSync(path.join(copy, 'agent', f)).mode & 0o777, 0o755, f)
      }
      assert.equal(fs.statSync(path.join(copy, 'agent', 'dash-report/README.md')).mode & 0o777, 0o644)
      // the parent of the copy can be traversed by everyone (system temporary folder)
      assert.ok(fs.statSync(os.tmpdir()).mode & 0o001, `${os.tmpdir()} traversable`)
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
    assert.equal(fs.existsSync(copy), false)
  } finally {
    fs.rmSync(src, { recursive: true, force: true })
  }
})

test('dash-report bench: fast, slow, edge cases, unit names, templates, generic install.sh (mawk and gawk; a missing one is reported); v9: earlyoom, bounds, settings file', t => {
  const r = bench('dash-report', { AWKS: 'mawk gawk' })
  for (const l of r.out.split('\n').filter(x => x.startsWith('skipped'))) t.diagnostic(l)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /dash-report: all tests pass/)
  assert.ok(/^ok {3}mawk: valid JSON, version 9$/m.test(r.out) || /^ok {3}gawk: valid JSON, version 9$/m.test(r.out), 'at least one awk implementation run')
  assert.match(r.out, /ok {3}watched units: each pattern passed after "--"/)
  // hostile values refused before any access, exact final key, values tampered with
  // in the remote script refused on the host; patterns not expanded
  for (const l of ['install.sh: PUBKEY (multiline) refused before any access', 'install.sh: FROM (return) refused before any access',
    'install.sh: UNITS (substitution) refused before any access', 'install.sh: FROM "0.0.0.0/0" refused before any access',
    'install.sh: final authorized key = a single restrict,from=,command= line and the key',
    'remote script: PUBKEY on two lines tampered with → refused on the host, no key',
    'install.sh: UNITS without pattern expansion (dash-report* kept)',
    // check decided on the workstation, end marker, atomic install
    'install.sh: check mode decided on the workstation (CHECK=0 at the top; DASH_REPORT_INSTALL_CHECK absent from the remote script)',
    'install.sh: check run on the host (variable left in its environment) without a requested check → code 1',
    'install.sh: empty output, code 0 (swallowed script) → code 1',
    'install of dash-report: missing decoder → failure, existing file intact, no temporary file',
    'install of dash-report: decoder failing after starting to write → failure, existing file intact, no temporary file',
    'install.sh: no direct decoding into an installed file (put: temporary file, checksum, mv)',
    'install.sh: </dev/null on every command of the remote script that could read stdin',
    // v9
    'earlyoom absent (unit unknown to systemd) → oom null',
    'earlyoom: 2 distinct processes killed in the window (TERM then KILL of the same PID count once), last one at its journal time, name of the last process',
    'mount point: control characters, quote and backslash removed (valid JSON)',
    'earlyoom with an unreadable journal → oom null, report still valid',
    'earlyoom: hostile process name → only [A-Za-z0-9._-] and ?, 32 at most',
    'string from a command capped at 256 bytes (docker.version)',
    'watched units: allowed patterns only (hostile, spaced and too long ones ignored), comments ignored',
    'securityOnly: no fleet-specific path or text in the report; the settings file is never executed',
    'install.sh: SECURITY_ONLY_FILE and SECURITY_ONLY_MARK sent in base64, revalidated and printed by the check',
    'remote script: SECURITY_ONLY_FILE with .. tampered with → refused on the host, no key']) assert.ok(r.out.includes(`ok   ${l}`), l)
})

test('net-scan bench: configuration read and validated, demo, install.sh (pre-install test, conf, rollback, mutations)', () => {
  const r = bench('net-scan')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /net-scan: all tests passed/)
  assert.match(r.out, /ok {3}conf: CIDR too wide \(\/8\)/)
  // hostile values, tampered values, leading zeros, duplicate keys
  for (const l of ['install.sh: IFACE (multiline) refused before any access', 'install.sh: DASH_USER (apostrophe) refused before any access',
    'install.sh: CIDR (CR) refused before any access', 'install.sh: revalidation on the machine, conf and reader account (vigie by default)',
    'remote script: public CIDR tampered → refused on the machine', 'conf: leading zero in the CIDR (010 read as octal elsewhere)',
    'conf: duplicate IFACE',
    'install.sh: check mode decided on the workstation (CHECK=0 at the top; NET_SCAN_INSTALL_CHECK absent from the remote script)',
    'install.sh: check run on the machine (variable left in its environment) without a check requested → code 1',
    'install of net-scan: decoder missing → failure, existing file intact, no temporary file',
    'install.sh: no direct decode into an installed file (put: temporary file, checksum, mv), decoding verified before installing anything']) assert.ok(r.out.includes(`ok   ${l}`), l)
})

test('shellcheck (warning level) on the agents, when it is installed; otherwise reported', t => {
  if (!has('shellcheck')) {
    t.diagnostic('shellcheck missing: not run here (agent/README.md; to run by hand or in a dedicated job)')
    return
  }
  const files = ['dash-report/dash-report', 'dash-report/dash-report-ssh', 'dash-report/install.sh', 'dash-report/test.sh', 'dash-report/test/fake/journalctl', 'dash-report/test/fake/systemctl', 'net-scan/net-scan', 'net-scan/install.sh', 'net-scan/test.sh']
  const r = spawnSync('shellcheck', ['-s', 'sh', '-S', 'warning', ...files], { cwd: AGENT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// fleet-specific names: checked by the publication scanner (list outside the public tree), not here
test('agents: executable scripts; no call to another script of the repository from install.sh', () => {
  for (const f of ['dash-report/dash-report', 'dash-report/dash-report-ssh', 'dash-report/install.sh', 'dash-report/test.sh', 'dash-report/test/fake/journalctl', 'net-scan/net-scan', 'net-scan/install.sh', 'net-scan/test.sh']) {
    assert.ok(fs.statSync(path.join(AGENT, f)).mode & 0o100, `${f} executable`)
  }
  for (const f of ['dash-report/install.sh', 'net-scan/install.sh']) {
    const code = fs.readFileSync(path.join(AGENT, f), 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    assert.doesNotMatch(code, /\.\.\/|unattended/, f)
  }
})

// Agent v9: the server accepts v8 and v9 reports side by side while the fleet is upgraded. Real
// reports produced by agent/dash-report/dash-report (copy with a PATH of fake tools, like its bench:
// test/fake/, no network, no privilege), read by cleanFast and cleanSlow; the same report announced
// as v8 (no oom field); oom_kill rule (warning, detail in the language of the instance); kernel
// reason of reboot_required translated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cleanFast, cleanSlow, cleanOom, rebootReason } from '../lib/agents.js'
import { parseConfig } from '../lib/config.js'
import { createRules, CORE_RULES, RULE_LABEL } from '../lib/alerts/rules.js'
import { setLocale } from '../lib/i18n.js'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT = path.join(ROOT, 'agent/dash-report')
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0

// one real report of the agent: folder of links to the needed tools and to the fake ones
function report(t, mode, env = {}) {
  const dir = tmpDir('vigie-agent-v9-', t)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const c of ['tr', 'sed', 'cat', 'date', 'hostname', 'uname', 'timeout', 'grep', 'paste', 'head', 'ls', 'sort', 'tail', 'find', 'wc', 'cut', 'mktemp', 'rm']) {
    const p = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim()
    if (p) fs.symlinkSync(p, path.join(bin, c))
  }
  const awk = ['mawk', 'gawk', 'awk'].find(has)
  fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${awk}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'awk'))
  for (const f of ['systemctl', 'journalctl', 'df', 'systemd-detect-virt', 'ss', 'sshd', 'nft', 'timedatectl', 'ip', 'docker']) fs.symlinkSync(path.join(AGENT, 'test/fake', f), path.join(bin, f))
  const script = fs.readFileSync(path.join(AGENT, 'dash-report'), 'utf8').replace(/^PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m, `PATH=${bin}`)
  assert.ok(script.includes(`PATH=${bin}\n`))
  fs.writeFileSync(path.join(dir, 'dash-report'), script)
  const r = spawnSync('sh', [path.join(dir, 'dash-report'), mode], { encoding: 'utf8', env: { FAKE_DIR: path.join(AGENT, 'test'), ...env }, timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const NOW = Date.parse('2026-11-12T08:00:00Z')
const RAW = {
  version: 2, title: 't', groups: [{ id: 'g', name: 'G' }], services: [], proxmox: [],
  hosts: [
    { id: 'p1', name: 'web-1', kind: 'external', ip: '192.0.2.21', env: 'prod', agent: 'ssh' },
    { id: 'd1', name: 'lab-1', kind: 'external', ip: '192.0.2.22', env: 'dev', agent: 'ssh' },
  ],
}
const CFG = parseConfig(RAW).config
const sigs = states => {
  const all = createRules(CFG, { checks: [], result: () => null }, { hosts: CFG.hosts, get: id => states[id] ?? { ok: null } }, null).evaluate({}, NOW)
  return k => all.find(x => x.key === k)
}
const live = f => ({ ok: true, at: NOW, fast: f, slow: null })
const v9fast = oom => cleanFast({ version: 9, ts: NOW / 1000, fs: [], reboot: { required: false }, oom })

test('v9 real reports of the agent (fast with earlyoom, slow) read by the server; the same reports as v8: no oom field, the rest unchanged', t => {
  const fast = report(t, 'fast', { FAKE_EARLYOOM: '1' })
  const slow = report(t, 'slow')
  assert.deepEqual([fast.schema, fast.version, slow.version], [1, 9, 9])
  const f9 = cleanFast(fast)
  assert.equal(f9.version, 9)
  // TERM then KILL of PID 4242, then TERM of PID 5151: 2 distinct processes
  assert.deepEqual(f9.oom, { windowSec: 3600, kills: 2, lastAt: 1767225900, lastProcess: 'stress-ng-vm' })
  assert.equal(f9.net.ifaces.length, 32)
  assert.equal(f9.docker.containers.length, 200)
  const s9 = cleanSlow(slow)
  assert.deepEqual([s9.version, s9.time, s9.posture.firewall], [9, { ntpSynced: true }, { type: 'nftables', active: true }])
  assert.equal(s9.listening.length, 128)
  // the same report announced as v8 (what a v8 agent sends: no oom field): accepted, no oom
  const { oom, ...rest } = fast
  const f8 = cleanFast({ ...rest, version: 8 })
  assert.equal(Object.hasOwn(f8, 'oom'), false)
  const { oom: _, version: __, ...same9 } = f9
  const { version: ___, ...same8 } = f8
  assert.deepEqual(same8, same9)
  assert.deepEqual(cleanSlow({ ...slow, version: 8 }), { ...s9, version: 8 })
  // without earlyoom (unit unknown): null, never an error
  assert.equal(cleanFast(report(t, 'fast')).oom, null)
})

test('v9 cleanOom: shape of the agent only; out of form → null; no kill → lastAt and lastProcess null', () => {
  assert.deepEqual(cleanOom({ windowSec: 3600, kills: 2, lastAt: 1767225900, lastProcess: 'stress-ng' }), { windowSec: 3600, kills: 2, lastAt: 1767225900, lastProcess: 'stress-ng' })
  assert.deepEqual(cleanOom({ windowSec: 3600, kills: 0, lastAt: 5, lastProcess: 'x' }), { windowSec: 3600, kills: 0, lastAt: null, lastProcess: null })
  assert.deepEqual(cleanOom({ windowSec: 3600, kills: 1, lastAt: -1, lastProcess: '<b>x</b>' }), { windowSec: 3600, kills: 1, lastAt: null, lastProcess: null })
  assert.equal(cleanOom({ windowSec: 3600, kills: 1, lastProcess: 'y'.repeat(33) }).lastProcess, null)
  for (const v of [null, undefined, [], 'x', { kills: -1, windowSec: 3600 }, { kills: 1.5, windowSec: 3600 }, { kills: 1 }, { kills: 1, windowSec: 0 }]) assert.equal(cleanOom(v), null, JSON.stringify(v))
})

test('v9 oom_kill: warning in prod and in dev, detail with the count and the last process; kills 0 → false; null or v8 → no signal; agent parents', () => {
  assert.ok(CORE_RULES.includes('oom_kill'))
  assert.equal(RULE_LABEL.oom_kill, 'Processus tué (mémoire saturée)')
  const by = sigs({ p1: live(v9fast({ windowSec: 3600, kills: 2, lastAt: NOW / 1000 - 60, lastProcess: 'stress-ng' })), d1: live(v9fast({ windowSec: 3600, kills: 1, lastAt: NOW / 1000 - 60, lastProcess: 'java' })) })
  const p = by('oom_kill:p1')
  assert.deepEqual([p.cond, p.severity, p.title, p.detail], [true, 'warning', 'Mémoire saturée · web-1', 'earlyoom a tué 2 processus dans la dernière heure (dernier : stress-ng)'])
  assert.deepEqual(p.parents, ['agent_unreachable:p1'])
  assert.deepEqual([by('oom_kill:d1').cond, by('oom_kill:d1').severity], [true, 'warning'])
  const calm = sigs({ p1: live(v9fast({ windowSec: 3600, kills: 0, lastAt: null, lastProcess: null })), d1: live(v9fast(null)) })
  assert.deepEqual([calm('oom_kill:p1').cond, calm('oom_kill:p1').detail], [false, null])
  assert.equal(calm('oom_kill:d1'), undefined)
  const v8 = sigs({ p1: live(cleanFast({ version: 8, ts: NOW / 1000, fs: [], reboot: { required: false }, oom: { windowSec: 3600, kills: 4 } })) })
  assert.equal(v8('oom_kill:p1'), undefined, 'a v8 report never brings oom')
  // detail in English for an English instance; the last process may be unknown
  setLocale('en')
  try {
    const en = sigs({ p1: live(v9fast({ windowSec: 3600, kills: 1, lastAt: null, lastProcess: null })) })('oom_kill:p1')
    assert.deepEqual([en.title, en.detail], ['Out of memory · web-1', 'earlyoom killed 1 process in the last hour (last: ?)'])
  } finally {
    setLocale('fr')
  }
})

test('v9 reboot reason: kernel reason sent in English by v9, shown in the language of the instance; v8 (French) and other reasons unchanged', () => {
  assert.equal(rebootReason('kernel 6.1.0-41-amd64 installed, 6.1.0-40-amd64 running'), 'noyau 6.1.0-41-amd64 installé, 6.1.0-40-amd64 en cours')
  assert.equal(cleanFast({ version: 9, reboot: { required: true, reason: 'kernel 6.12.1 installed, 6.12.0 running' } }).reboot.reason, 'noyau 6.12.1 installé, 6.12.0 en cours')
  assert.equal(cleanFast({ version: 8, reboot: { required: true, reason: 'noyau 6.1.0-41-amd64 installé, 6.1.0-40-amd64 en cours' } }).reboot.reason, 'noyau 6.1.0-41-amd64 installé, 6.1.0-40-amd64 en cours')
  assert.equal(rebootReason('linux-image-amd64 libc6 '), 'linux-image-amd64 libc6 ')
  assert.equal(rebootReason('kernel a b installed, c running'), 'kernel a b installed, c running')
  setLocale('en')
  try {
    assert.equal(rebootReason('kernel 6.12.1 installed, 6.12.0 running'), 'kernel 6.12.1 installed, 6.12.0 running')
  } finally {
    setLocale('fr')
  }
})

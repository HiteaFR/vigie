// dash-report agent: JSON report of the equipped hosts, read over SSH (key with
// forced-command, pinned known_hosts) or, for the dashboard's own container, from
// /run/dash-report written by a local root timer. Two paces: fast (60 s,
// system, FS, systemd, containers) and slow (1 h, apt, images).
//
// The report is reduced on the server side to an allowlist of fields: even if an
// agent returned more (modified version, bug), nothing else goes out to
// the client nor to the database.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from './paths.js'
import { normalizeMac } from './net/mac.js'
import { isIpv4, parseCidr } from './net/ip.js'
import { autoUpdateStatus } from './updates/autostatus.js'
import { t as tr } from './i18n.js'

const FAST_SEC = 60
export const SLOW_SEC = 3600
const MAX_CONCURRENT = 4
const TIMEOUT_MS = 15_000
const LOCAL_DIR = '/run/dash-report'
// window for counting the restarts of a container
const RESTART_WINDOW_MS = 15 * 60_000
// a fast report larger than 512 KiB is refused (v6 fits under 256 KiB)
const MAX_FAST_BYTES = 512 * 1024

const n = v => (Number.isFinite(Number(v)) ? Number(v) : null)
const s = v => (v == null ? null : String(v).slice(0, 300))
const b = v => v === true
// disk_free: a missing, null or empty avail stays null (n(null) would give 0, i.e. "0 GB free");
// the other computations (used + avail) read it as 0
const nOrNull = v => (v == null || v === '' ? null : n(v))

// --- allowlists ---
// network or container name without control characters, bounded; an
// entry with an invalid mandatory value is REMOVED, never repaired
const plainName = (v, max = 64) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max))
const IFACE_NAME = /^[\w.@-]{1,15}$/
const NEIGH_STATES = new Set(['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'PERMANENT', 'NOARP'])
const DRIVERS = new Set(['bridge', 'host', 'macvlan', 'ipvlan', 'overlay', 'null', 'none'])
const macOrNull = v => (v == null || v === '' ? null : normalizeMac(v) ?? undefined) // undefined: invalid
function cleanNet(net) {
  if (!net || typeof net !== 'object') return null
  const arr = v => (Array.isArray(v) ? v : [])
  const ifaces = []
  for (const i of arr(net.ifaces)) {
    if (ifaces.length >= 32) break
    if (!i || typeof i.name !== 'string' || !IFACE_NAME.test(i.name)) continue
    const mac = macOrNull(i.mac)
    if (mac === undefined) continue
    const ipv4 = arr(i.ipv4).filter(c => typeof c === 'string' && parseCidr(c) && isIpv4(c.split('/')[0])).slice(0, 8)
    if (!ipv4.length) continue
    ifaces.push({ name: i.name, mac, ipv4 })
  }
  const neigh = []
  for (const x of arr(net.neigh)) {
    if (neigh.length >= 512) break
    if (!x || !isIpv4(x.ip) || typeof x.dev !== 'string' || !IFACE_NAME.test(x.dev) || !NEIGH_STATES.has(x.state)) continue
    const mac = normalizeMac(x.mac)
    if (!mac) continue
    neigh.push({ ip: x.ip, mac, dev: x.dev, state: x.state })
  }
  return { ifaces, neigh }
}
function cleanNetworks(list) {
  if (!Array.isArray(list)) return null
  return list.filter(x => x && typeof x === 'object' && plainName(x.name)).slice(0, 64)
    .map(x => ({ name: plainName(x.name), driver: DRIVERS.has(x.driver) ? x.driver : 'other' }))
}
function cleanEndpoints(list) {
  if (!Array.isArray(list)) return null
  const out = []
  for (const e of list) {
    if (out.length >= 8) break
    if (!e || typeof e !== 'object' || !plainName(e.network)) continue
    const mac = macOrNull(e.mac)
    const ip = e.ip == null || e.ip === '' ? null : isIpv4(e.ip) ? e.ip : undefined
    if (mac === undefined || ip === undefined) continue
    out.push({ network: plainName(e.network), ip, mac })
  }
  return out
}
function cleanContainer(c, v6) {
  return {
    name: s(String(c.name || '').replace(/^\//, '')),
    image: s(c.image), imageId: s(c.imageId), created: s(c.created),
    state: s(c.state), health: s(c.health), exitCode: n(c.exitCode), oomKilled: b(c.oomKilled),
    startedAt: s(c.startedAt), finishedAt: s(c.finishedAt), restarts: n(c.restarts),
    restartPolicy: s(c.restartPolicy), compose: s(c.compose) || null, service: s(c.service) || null,
    // v6: container networks (network, IPv4, MAC); v5 → undefined, never []
    ...(v6 ? { networks: cleanEndpoints(c.networks) } : {}),
  }
}

// agent v8 fields, read only if version >= 8, field by field; an
// ill-formed value gives null (unknown), an invalid list entry is REMOVED
const int0 = v => (Number.isInteger(v) && v >= 0 ? v : null)
const bool3 = v => (v === true ? true : v === false ? false : null)
export function cleanInodes(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const total = int0(v.total)
  const used = int0(v.used)
  return total == null || used == null || used > total ? null : { total, used }
}
export const UNIT_FILE = /^[A-Za-z0-9:_.@\-]{1,100}\.(service|socket|timer|mount|path|target|scope|slice|swap|automount|device)$/
const PROCESS = /^[A-Za-z0-9._-]{1,32}$/
const ROOT_LOGIN = new Set(['no', 'prohibit-password', 'forced-commands-only', 'yes'])
const FIREWALLS = new Set(['nftables', 'ufw', 'iptables', 'none'])
// listening address: *, IPv4, IPv6 (with or without brackets, optional %iface zone)
const LISTEN_ADDR = /^(\*|[0-9]{1,3}(\.[0-9]{1,3}){3}|\[?[0-9A-Fa-f:.]{2,45}(%[A-Za-z0-9_.-]{1,15})?\]?)$/
export const RESTART_UNITS_MAX = 50
export const LISTENING_MAX = 128
export function cleanRestart(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return {
    units: (Array.isArray(v.units) ? v.units : []).slice(0, RESTART_UNITS_MAX).filter(u => typeof u === 'string' && UNIT_FILE.test(u)),
    processes: int0(v.processes),
  }
}
export function cleanPosture(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const ssh = v.ssh && typeof v.ssh === 'object' && !Array.isArray(v.ssh)
    ? { permitRootLogin: ROOT_LOGIN.has(v.ssh.permitRootLogin) ? v.ssh.permitRootLogin : null, passwordAuth: bool3(v.ssh.passwordAuth) }
    : null
  const fw = v.firewall && typeof v.firewall === 'object' && !Array.isArray(v.firewall) && FIREWALLS.has(v.firewall.type) && typeof v.firewall.active === 'boolean'
    ? { type: v.firewall.type, active: v.firewall.active }
    : null
  return { ssh, firewall: fw }
}
// listening missing or not an array: null (unknown), never []: an empty list would bootstrap the
// port memory at zero, and all real ports would then become "new"
export function cleanListening(v) {
  if (!Array.isArray(v)) return null
  return v.slice(0, LISTENING_MAX)
    .filter(p => p && (p.proto === 'tcp' || p.proto === 'udp') && typeof p.addr === 'string' && LISTEN_ADDR.test(p.addr)
      && Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535 && (p.process == null || (typeof p.process === 'string' && PROCESS.test(p.process))))
    .map(p => ({ proto: p.proto, addr: p.addr, port: p.port, process: p.process ?? null }))
}

// v9: processes killed by earlyoom over the last windowSec seconds (fast report). Absent, null or
// out of form → null (earlyoom absent, or unknown); lastProcess is reduced to the agent's own form
// (32 characters among [A-Za-z0-9._?-]), otherwise null
export const OOM_PROCESS = /^[A-Za-z0-9._?-]{1,32}$/
export function cleanOom(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const kills = int0(v.kills)
  const windowSec = int0(v.windowSec)
  if (kills == null || windowSec == null || windowSec === 0) return null
  return {
    windowSec, kills,
    lastAt: kills > 0 ? int0(v.lastAt) : null,
    lastProcess: kills > 0 && typeof v.lastProcess === 'string' && OOM_PROCESS.test(v.lastProcess) ? v.lastProcess : null,
  }
}
// v9: the agent gives the kernel reason in English ("kernel A installed, B running"); shown in the
// language of the instance (v8 agents wrote it in French, kept as is)
const KERNEL_REASON = /^kernel (\S{1,100}) installed, (\S{1,100}) running$/
export function rebootReason(reason) {
  const m = KERNEL_REASON.exec(reason)
  return m ? tr('agents.reboot_kernel', { installed: m[1], running: m[2] }) : reason
}

export function cleanFast(r) {
  const arr = v => (Array.isArray(v) ? v : [])
  // v6: net, docker.networks and containers[].networks read only if version >= 6
  const v6 = n(r.version) >= 6
  const v8 = n(r.version) >= 8
  const v9 = n(r.version) >= 9
  return {
    ts: n(r.ts), version: n(r.version),
    hostname: s(r.hostname), os: s(r.os), osId: s(r.osId), osVersion: s(r.osVersion),
    kernel: s(r.kernel), virt: s(r.virt), uptimeSec: n(r.uptimeSec),
    load: arr(r.load).slice(0, 3).map(n),
    mem: { total: n(r.mem?.total), available: n(r.mem?.available) },
    swap: { total: n(r.swap?.total), free: n(r.swap?.free) },
    fs: arr(r.fs).slice(0, 50).map(f => ({ mount: s(f.mount), type: s(f.type), size: n(f.size), used: n(f.used), avail: nOrNull(f.avail), ...(v8 ? { inodes: cleanInodes(f.inodes) } : {}) })),
    systemd: r.systemd ? {
      failed: arr(r.systemd.failed).slice(0, 50).map(s),
      watched: arr(r.systemd.watched).slice(0, 50).map(u => ({ unit: s(u.unit), active: s(u.active), sub: s(u.sub) })),
    } : null,
    reboot: { required: b(r.reboot?.required), reason: rebootReason(s(r.reboot?.reason)) || null },
    ...(v6 ? { net: cleanNet(r.net) } : {}),
    docker: r.docker ? {
      version: s(r.docker.version),
      ...(v6 ? { networks: cleanNetworks(r.docker.networks) } : {}),
      containers: arr(r.docker.containers).filter(c => c && typeof c === 'object').slice(0, 200).map(c => cleanContainer(c, v6)),
    } : null,
    // v9: earlyoom (null: absent or unknown); v8 and older: no field
    ...(v9 ? { oom: cleanOom(r.oom) } : {}),
  }
}

// autoUpdate block of the v7 slow report (unattended-upgrades: the OS patches and
// the agent monitors). Read field by field; an unknown field is ignored; a boolean is true
// only if it equals true; lastResult outside success/failed → null; applied: 50 entries at most,
// reduced to { name, version }, an entry with an invalid name or version (control character,
// non-Debian form) is REMOVED, never repaired. Missing, null or not an object → null (unknown).
const AU_RESULTS = new Set(['success', 'failed'])
// same forms as the filter of agent v7: second barrier
const APT_NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/
const APT_VERSION = /^[A-Za-z0-9.+:~-]{1,100}$/
export const AU_APPLIED_MAX = 50
export function cleanAutoUpdate(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null
  const at = typeof a.lastRunAt === 'number' && Number.isFinite(a.lastRunAt) ? a.lastRunAt : null
  return {
    installed: b(a.installed), enabled: b(a.enabled), securityOnly: b(a.securityOnly),
    lastRunAt: at != null && at >= 0 ? at : null,
    lastResult: AU_RESULTS.has(a.lastResult) ? a.lastResult : null,
    applied: (Array.isArray(a.applied) ? a.applied : []).slice(0, AU_APPLIED_MAX)
      .filter(p => p && typeof p.name === 'string' && typeof p.version === 'string' && APT_NAME.test(p.name) && APT_VERSION.test(p.version))
      .map(p => ({ name: p.name, version: p.version })),
  }
}

export function cleanSlow(r) {
  const arr = v => (Array.isArray(v) ? v : [])
  return {
    ts: n(r.ts),
    // report version (autoUpdate read only from v7 on, like net from v6)
    version: n(r.version),
    autoUpdate: n(r.version) >= 7 ? cleanAutoUpdate(r.autoUpdate) : null,
    // services to restart, SSH and firewall posture, listening ports (v8 only)
    restart: n(r.version) >= 8 ? cleanRestart(r.restart) : null,
    posture: n(r.version) >= 8 ? cleanPosture(r.posture) : null,
    listening: n(r.version) >= 8 ? cleanListening(r.listening) : null,
    // clock synchronized by NTP (in the slow report: timedatectl would fill the log in fast)
    time: n(r.version) >= 8 ? { ntpSynced: bool3(r.time?.ntpSynced) } : null,
    apt: r.apt ? {
      listsAt: n(r.apt.listsAt), upgradable: n(r.apt.upgradable), security: n(r.apt.security),
      // v5: held packages (apt-mark hold), counted separately
      held: n(r.apt.held),
      packages: arr(r.apt.packages).slice(0, 200).map(p => ({ name: s(p.name), suite: s(p.suite), version: s(p.version), from: s(p.from), held: b(p.held) })),
    } : null,
    images: r.images ? arr(r.images).slice(0, 300).map(i => ({
      id: s(i.id), tags: arr(i.tags).slice(0, 20).map(s), digests: arr(i.digests).slice(0, 20).map(s), created: s(i.created),
    })) : null,
    // v3: allowlisted package versions (package name → version)
    versions: r.versions && typeof r.versions === 'object'
      ? Object.fromEntries(Object.entries(r.versions)
        .filter(([k, v]) => /^[a-z0-9][a-z0-9.+-]{0,40}$/.test(k) && typeof v === 'string')
        .slice(0, 50).map(([k, v]) => [k, v.slice(0, 80)]))
      : null,
  }
}

// the limit applies BEFORE reading: execFile maxBuffer over SSH, stat before
// readFile locally (a larger file is never read entirely)
export const readLimit = mode => (mode === 'fast' ? MAX_FAST_BYTES : 8 * 1024 * 1024)
const tooBig = () => Object.assign(new Error('size'), { info: { kind: 'format', msg: tr('errors.agent.too_big') } })
export async function readLocalReport(dir, mode) {
  const file = path.join(dir, `${mode}.json`)
  const st = await fs.stat(file).catch(e => {
    throw Object.assign(new Error('local'), { info: { kind: 'local', msg: e.code === 'ENOENT' ? tr('errors.agent.local_missing') : e.message } })
  })
  if (st.size > readLimit(mode)) throw tooBig()
  return fs.readFile(file, 'utf8').catch(e => {
    throw Object.assign(new Error('local'), { info: { kind: 'local', msg: e.message } })
  })
}

// raw text of a report → object; fast larger than 512 KiB refused, invalid JSON refused
export function parseReport(raw, mode) {
  if (mode === 'fast' && Buffer.byteLength(raw) > MAX_FAST_BYTES) throw tooBig()
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('json'), { info: { kind: 'format', msg: tr('errors.agent.json') } })
  }
}

// ssh error → short message; a changed host key is never accepted
function sshError(e, stderr) {
  const t = String(stderr || '')
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(t)) return { kind: 'hostkey', msg: tr('errors.agent.hostkey') }
  if (/Permission denied/i.test(t)) return { kind: 'auth', msg: tr('errors.agent.auth') }
  if (/timed out|No route to host|Connection refused|Could not resolve/i.test(t)) return { kind: 'network', msg: t.trim().split('\n').pop().replace(/^ssh: /, '') }
  if (e?.killed) return { kind: 'timeout', msg: tr('errors.agent.timeout', { s: TIMEOUT_MS / 1000 }) }
  return { kind: 'other', msg: (t.trim().split('\n').pop() || e?.message || tr('errors.agent.failed')).slice(0, 200) }
}

// root of the code (like index.js): default state folder <root>/data outside systemd (lib/paths.js)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function createAgents(cfg, env = process.env, { root = ROOT } = {}) {
  // key, pinned known_hosts and ControlMaster sockets in the same folder: the common state
  // folder (STATE_DIRECTORY under systemd, otherwise <root>/data), no hard-coded production path
  const key = env.DASHREPORT_SSH_KEY || path.join(stateDir(env, root), 'ssh', 'id_ed25519')
  const sshDir = path.dirname(key)
  const knownHosts = path.join(sshDir, 'known_hosts')
  const hosts = cfg.hosts.filter(h => h.agent)
  const state = new Map(hosts.map(h => [h.id, { at: null, ok: null, error: null, errorKind: null, fast: null, slow: null, restarts: new Map() }]))

  function sshRun(h, mode) {
    return new Promise((resolve, reject) => {
      execFile('ssh', [
        '-F', '/dev/null', '-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'IdentitiesOnly=yes',
        '-o', 'ControlMaster=auto', '-o', `ControlPath=${sshDir}/cm-%C`, '-o', 'ControlPersist=5m',
        '-o', 'LogLevel=ERROR',
        `dashreport@${h.ip}`, mode,
      ], { timeout: TIMEOUT_MS, maxBuffer: readLimit(mode) }, (e, stdout, stderr) => {
        if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(tooBig())
        if (e) return reject(Object.assign(new Error('ssh'), { info: sshError(e, stderr) }))
        resolve(stdout)
      })
    })
  }

  async function read(h, mode) {
    const raw = h.agent === 'local' ? await readLocalReport(LOCAL_DIR, mode) : await sshRun(h, mode)
    const j = parseReport(raw, mode)
    if (j.error) throw Object.assign(new Error('agent'), { info: { kind: 'agent', msg: tr('errors.agent.agent', { error: String(j.error).slice(0, 100) }) } })
    if (j.schema !== 1) throw Object.assign(new Error('schema'), { info: { kind: 'format', msg: tr('errors.agent.schema', { schema: j.schema }) } })
    // local report: stale if the timer no longer runs
    if (h.agent === 'local' && Date.now() / 1000 - j.ts > (mode === 'fast' ? 5 * 60 : 3 * 3600)) {
      throw Object.assign(new Error('stale'), { info: { kind: 'local', msg: tr('errors.agent.stale') } })
    }
    return j
  }

  // restart count per container: RestartCount difference within the window
  function trackRestarts(st, fast, now) {
    for (const c of fast.docker?.containers || []) {
      const hist = st.restarts.get(c.name) || []
      hist.push([now, c.restarts ?? 0])
      while (hist.length > 1 && now - hist[0][0] > RESTART_WINDOW_MS) hist.shift()
      st.restarts.set(c.name, hist)
      c.recentRestarts = Math.max(0, (c.restarts ?? 0) - hist[0][1])
    }
    const names = new Set((fast.docker?.containers || []).map(c => c.name))
    for (const k of st.restarts.keys()) if (!names.has(k)) st.restarts.delete(k)
  }

  async function run(h, mode) {
    const st = state.get(h.id)
    const now = Date.now()
    try {
      const j = await read(h, mode)
      if (mode === 'fast') {
        const fast = cleanFast(j)
        trackRestarts(st, fast, now)
        st.fast = fast
        st.at = now
        st.ok = true
        st.error = null
        st.errorKind = null
      } else {
        st.slow = cleanSlow(j)
        st.slowAt = now
      }
    } catch (e) {
      const info = e.info || { kind: 'other', msg: String(e.message || e) }
      if (mode === 'fast') {
        st.ok = false
        st.error = info.msg
        st.errorKind = info.kind
        st.errorAt = now
      } else {
        st.slowError = info.msg
      }
    }
  }

  // queue with limited concurrency, each host rescheduled at its own pace
  let inFlight = 0
  const queue = []
  function schedule(h, mode, delay) {
    setTimeout(() => {
      queue.push([h, mode])
      pump()
    }, delay)
  }
  function pump() {
    while (inFlight < MAX_CONCURRENT && queue.length) {
      const [h, mode] = queue.shift()
      inFlight++
      run(h, mode).finally(() => {
        inFlight--
        schedule(h, mode, (mode === 'fast' ? FAST_SEC : SLOW_SEC) * 1000)
        pump()
      })
    }
  }

  return {
    hosts,
    sshKey: key, // key path (tests, diagnostics; never its content)
    start() {
      for (const h of hosts) {
        schedule(h, 'fast', 500 + Math.random() * 3000)
        schedule(h, 'slow', 5000 + Math.random() * 20_000)
      }
    },
    get: id => state.get(id) ?? null,
    // last SUCCESSFUL fast report of each host and its date (network module)
    reports: () => hosts.map(h => ({ host: h.id, at: state.get(h.id)?.at ?? null, fast: state.get(h.id)?.fast ?? null })).filter(r => r.fast && r.at != null),
    // immediate reading (fast then slow) of all hosts, outside the schedule
    async refreshAll() {
      const jobs = hosts.flatMap(h => [[h, 'fast'], [h, 'slow']])
      const worker = async () => {
        for (let j = jobs.shift(); j; j = jobs.shift()) await run(...j)
      }
      await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker))
    },
    // public view: equipped and non-equipped ("not instrumented") hosts
    view() {
      return cfg.hosts.filter(h => h.kind === 'vm' || h.kind === 'lxc').map(h => {
        const st = state.get(h.id)
        const ref = { id: h.id, name: h.name, kind: h.kind, pve: h.pve, vmid: h.vmid, env: h.env }
        if (!st) return { ...ref, agent: null }
        return {
          ...ref, agent: h.agent,
          ok: st.ok, at: st.at, error: st.error, errorKind: st.errorKind,
          fast: st.fast, slow: st.slow, slowAt: st.slowAt ?? null, slowError: st.slowError ?? null,
          // "automatic updates" state (same criteria as the rules)
          autoUpdate: h.agent ? autoUpdateStatus(st.slow, { maxAgeHours: cfg.alerts?.autoUpdateMaxAgeHours ?? 48 }) : null,
        }
      })
    },
  }
}

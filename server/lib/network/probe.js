// Service probe: definitions (validated with strict zod, no regular expression in the
// patterns), PURE evaluator, prober (node:net for the ports, fetch for a few HTTP GETs), its
// OWN limiter (8 in flight, 50 connections/s, one host at a time, one pass at a time), weekly
// schedule (Sunday 04:00, alerts timezone).
// No DNS resolution (literal IPv4, a lookup that throws), no redirect followed, HTTP only
// (TLS ports are tested over TCP only), body cut at 64 KB and never stored.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { isIpv4, parseCidr, inCidr, ipToInt } from '../net/ip.js'
import { literalIpv4 } from './topology.js'
import { deviceLabel, bestAttr } from './merge.js'
import { USER_AGENT } from '../user-agent.js'
import { serviceDefSets } from '../registry.js'
import { probedDetail } from './events.js'
import { t as tr } from '../i18n.js'

const TLS_PORTS = new Set([443, 8443, 9443, 8006, 5001])
// next to this module (server/data is ignored by git and excluded by deploy.sh); no fallback
export const DEFS_FILE = new URL('./service-defs.json', import.meta.url)
export const CONF = ['low', 'medium', 'high']
const MAX_DEPTH = 4
const MAX_NODES = 32
const MAX_DEFS = 64
export const MAX_HTTP_PER_HOST = 24 // HTTP requests at most per host and per pass
// the host's HTTP stops at the 3rd 4xx answer (ports remain tested over TCP); an answer whose
// status is EXACTLY the one expected by a proof of that (port, path) does not count
export const MAX_HTTP_4XX = 3
// still-open ports outside the definitions reviewed per pass, at most
const MAX_EXTRA_PORTS = 16
const TCP_TIMEOUT_MS = 800
// exported and injectable into httpGet (tests); the probe keeps 2 s
export const HTTP_TIMEOUT_MS = 2000
const MAX_BODY = 64 * 1024
const MAX_HEADER = 1024
const RATE_PER_S = 50
const CONCURRENCY = 8
const MAX_QUEUE = 5
const ADMIN_EVERY_MS = 10 * 60_000
const ALL_EVERY_MS = 60 * 60_000 // "Probe all": at most once per hour
const MAX_REFUSED = 2000
const DAY = 86_400_000

// --- definitions -------------------------------------------------------------------------

const port = z.number().int().min(1).max(65535)
const needle = z.string().min(1).max(128).refine(s => s === s.toLowerCase(), 'lowercase substring')
const pathS = z.string().regex(/^\/[A-Za-z0-9._~/-]{0,128}$/)
const motif = z.lazy(() => z.union([
  z.object({ port }).strict(),
  // empty: body received EMPTY (zero length, read without decompression)
  z.object({ http: z.object({ port, path: pathS, contains: needle.optional(), status: z.number().int().min(100).max(599).optional(), empty: z.literal(true).optional() }).strict()
    .refine(h => h.contains != null || h.status != null || h.empty != null, 'contains, status or empty') }).strict(),
  z.object({ header: z.object({ port, path: pathS, name: z.string().regex(/^[a-z0-9-]{1,40}$/), contains: needle }).strict() }).strict(),
  z.object({ macVendor: needle }).strict(),
  z.object({ anyOf: z.array(motif).min(1).max(MAX_NODES) }).strict(),
  z.object({ allOf: z.array(motif).min(1).max(MAX_NODES) }).strict(),
  z.object({ not: motif }).strict(),
  z.object({ mdns: z.string().max(128) }).strict(), // reserved: always false
]))
const defsSchema = z.object({
  attribution: z.string().min(1).max(300),
  defs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/),
    name: z.string().min(1).max(64),
    category: z.string().min(1).max(32),
    match: motif,
  }).strict()).min(1).max(MAX_DEFS),
}).strict()

// bounded walk of a pattern: depth, number of nodes, HTTP proofs on a TLS port
// depth: number of nested anyOf, allOf and not up to and including this node
function walk(m, depth, acc) {
  acc.nodes++
  if (acc.nodes > MAX_NODES) return
  const [k] = Object.keys(m)
  if ((k === 'anyOf' || k === 'allOf' || k === 'not') && depth + 1 > MAX_DEPTH) acc.errors.push(`profondeur > ${MAX_DEPTH}`)
  if ((k === 'http' || k === 'header') && TLS_PORTS.has(m[k].port)) acc.errors.push(`${k} proof on TLS port ${m[k].port}`)
  if (k === 'anyOf' || k === 'allOf') for (const c of m[k]) walk(c, depth + 1, acc)
  if (k === 'not') walk(m.not, depth + 1, acc)
}

// ports cited by a pattern (port, http, header)
export function portsOf(m, acc = new Set()) {
  const [k] = Object.keys(m)
  if (k === 'port') acc.add(m.port)
  else if (k === 'http' || k === 'header') acc.add(m[k].port)
  else if (k === 'anyOf' || k === 'allOf') for (const c of m[k]) portsOf(c, acc)
  else if (k === 'not') portsOf(m.not, acc)
  return acc
}

// JSON text → { ok, defs, ports, portOwners, error }; a failure disables the service probe
export function parseDefs(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'definitions: invalid JSON' }
  }
  let r
  try {
    r = defsSchema.safeParse(raw)
  } catch {
    return { ok: false, error: 'definitions: structure too deep' }
  }
  if (!r.success) return { ok: false, error: `definitions: ${r.error.issues[0]?.path.join('.') || '?'}: ${r.error.issues[0]?.message ?? 'invalid'}`.slice(0, 200) }
  const ids = new Set()
  const portOwners = new Map() // port → Set(ids)
  for (const d of r.data.defs) {
    if (ids.has(d.id)) return { ok: false, error: `definitions: duplicate id (${d.id})` }
    ids.add(d.id)
    const acc = { nodes: 0, errors: [] }
    walk(d.match, 0, acc)
    if (acc.nodes > MAX_NODES) return { ok: false, error: `definitions: ${d.id}: more than ${MAX_NODES} nodes` }
    if (acc.errors.length) return { ok: false, error: `definitions: ${d.id}: ${acc.errors[0]}` }
    for (const p of portsOf(d.match)) portOwners.set(p, (portOwners.get(p) ?? new Set()).add(d.id))
  }
  return { ok: true, attribution: r.data.attribution, defs: r.data.defs, ports: [...portOwners.keys()].sort((a, b) => a - b), portOwners }
}
export function loadDefs(file) {
  try {
    return parseDefs(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, error: 'definitions: unreadable file' }
  }
}

// --- additional definitions ---------------------------------------------------------------------
// The shipped file first, then, in this order: the *.json files of the network.probe.defsDirs
// directories (per directory, sorted names, MAX_EXTRA_FILES at most; safe read, readDefsFile:
// regular file of 1 MiB at most), then those of the plugins (extensions.serviceDefs). Each set
// has the format of the shipped file (published schema: docs/network.md, "Additional service
// definitions") and its limits (MAX_DEFS per set). A set that is invalid, has an id that
// already exists or exceeds MAX_TOTAL_DEFS is dropped entirely, with its error (log and
// status); the others and the shipped file stay. An invalid shipped file disables the probe.
// At equal rank, a shipped definition comes before an added one (recognise: file order).
export const MAX_EXTRA_FILES = 32
export const MAX_TOTAL_DEFS = 256
export const MAX_DEFS_BYTES = 1024 * 1024
// safe read of an added file: regular file only (no link, FIFO or device, seen by lstat),
// 1 MiB at most; opened without following links and without blocking (O_NOFOLLOW,
// O_NONBLOCK), then type and size checked again on the descriptor (fstat) before reading
// (a file replaced in between is refused). Nothing of the content is copied into an error.
export function readDefsFile(file) {
  const no = error => ({ ok: false, error: `definitions: ${error}` })
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    return no('unreadable file')
  }
  if (st.isSymbolicLink()) return no('link refused')
  if (!st.isFile()) return no('not a regular file')
  if (st.size > MAX_DEFS_BYTES) return no('file over 1 MiB')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (e) {
    return no(e?.code === 'ELOOP' ? 'link refused' : 'unreadable file')
  }
  try {
    const fst = fs.fstatSync(fd)
    if (!fst.isFile()) return no('not a regular file')
    if (fst.size > MAX_DEFS_BYTES) return no('file over 1 MiB')
    // at most MAX_DEFS_BYTES + 1 bytes: a file that grows during the read is refused
    const buf = Buffer.alloc(MAX_DEFS_BYTES + 1)
    let n = 0
    for (;;) {
      const k = fs.readSync(fd, buf, n, buf.length - n, null)
      if (k <= 0) break
      n += k
      if (n > MAX_DEFS_BYTES) return no('file over 1 MiB')
    }
    return parseDefs(buf.subarray(0, n).toString('utf8'))
  } catch {
    return no('unreadable file')
  } finally {
    fs.closeSync(fd)
  }
}
export function mergeDefs(core, extras) {
  if (!core.ok) return { ...core, sets: [{ source: tr('net.probe.shipped'), count: 0, error: core.error }] }
  const defs = [...core.defs]
  const portOwners = new Map([...core.portOwners].map(([p, ids]) => [p, new Set(ids)]))
  const ids = new Set(defs.map(d => d.id))
  const sets = [{ source: tr('net.probe.shipped'), count: core.defs.length, error: null }]
  for (const x of extras) {
    const r = x.parsed
    const refuse = error => sets.push({ source: x.source, count: 0, error })
    if (!r.ok) { refuse(r.error); continue }
    const dup = r.defs.find(d => ids.has(d.id))
    if (dup) { refuse(`definitions: id already defined (${dup.id})`); continue }
    if (defs.length + r.defs.length > MAX_TOTAL_DEFS) { refuse(`definitions: more than ${MAX_TOTAL_DEFS} in total`); continue }
    for (const d of r.defs) {
      defs.push(d)
      ids.add(d.id)
    }
    for (const [p, owners] of r.portOwners) portOwners.set(p, new Set([...(portOwners.get(p) ?? []), ...owners]))
    sets.push({ source: x.source, count: r.defs.length, error: null })
  }
  return { ok: true, attribution: core.attribution, defs, ports: [...portOwners.keys()].sort((a, b) => a - b), portOwners, sets }
}
// shipped file + directories + plugin sets → merged definitions (see mergeDefs)
export function loadDefsSets({ file = DEFS_FILE, dirs = [], plugins = [] } = {}) {
  const extras = []
  for (const dir of dirs) {
    let names
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
    } catch {
      extras.push({ source: dir, parsed: { ok: false, error: 'definitions: unreadable directory' } })
      continue
    }
    if (names.length > MAX_EXTRA_FILES) extras.push({ source: dir, parsed: { ok: false, error: `definitions: more than ${MAX_EXTRA_FILES} files, the next ones ignored` } })
    for (const n of names.slice(0, MAX_EXTRA_FILES)) extras.push({ source: path.join(dir, n), parsed: readDefsFile(path.join(dir, n)) })
  }
  for (const s of plugins) extras.push({ source: s.source, parsed: parseDefs(JSON.stringify(s.data)) })
  return mergeDefs(loadDefs(file), extras)
}

// --- evaluator (pure) -----------------------------------------------------------------------

// removal of the path echo: body and pattern in lower case; the requested path, copied back by
// the server, cannot validate the substring (except an empty path or "/")
export function stripEcho(body, path) {
  const b = String(body ?? '').toLowerCase()
  if (!path || path === '/') return b
  return b.split(path.toLowerCase()).join(' ')
}

// pattern → { ok, rank (0 low, 1 medium, 2 high, null without its own confidence), proofs (Set of
// distinct proofs) }; ctx = { open: Set(ports), resp(port, path) → { status, body, headers }
// | null, vendor, portOwners }
export function evalMotif(m, ctx) {
  const [k] = Object.keys(m)
  const no = { ok: false, rank: null, proofs: new Set() }
  if (k === 'port') {
    // a definition of category "generic" (ssh, dns, http, https) stays low
    const shared = ctx.generic || (ctx.portOwners.get(m.port)?.size ?? 0) > 1
    return ctx.open.has(m.port) ? { ok: true, rank: shared ? 0 : 1, proofs: new Set([`port ${m.port}`]) } : no
  }
  if (k === 'http' || k === 'header') {
    const h = m[k]
    const r = ctx.open.has(h.port) ? ctx.resp(h.port, h.path) : null
    let ok = !!r
    if (ok && k === 'http') {
      if (h.status != null) ok = r.status === h.status
      if (ok && h.contains != null) ok = stripEcho(r.body, h.path).includes(h.contains)
      if (ok && h.empty) ok = r.bytes === 0
    }
    if (ok && k === 'header') ok = String(r.headers?.[h.name] ?? '').toLowerCase().includes(h.contains)
    return ok ? { ok: true, rank: 2, proofs: new Set([`${k} ${JSON.stringify(h)}`]) } : no
  }
  if (k === 'macVendor') {
    const ok = String(ctx.vendor ?? '').toLowerCase().includes(m.macVendor)
    return ok ? { ok: true, rank: null, proofs: new Set([`mac ${m.macVendor}`]) } : no
  }
  if (k === 'mdns') return no // reserved: always false
  if (k === 'not') return evalMotif(m.not, ctx).ok ? no : { ok: true, rank: null, proofs: new Set() } // brings nothing
  const kids = m[k].map(c => evalMotif(c, ctx))
  if (k === 'anyOf') {
    // the best confidence of the true branches
    const hit = kids.filter(x => x.ok).sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || b.proofs.size - a.proofs.size)
    return hit[0] ?? no
  }
  // allOf: each distinct proof beyond the first raises the confidence by one step (≤ high)
  if (!kids.every(x => x.ok)) return no
  const proofs = new Set(kids.flatMap(x => [...x.proofs]))
  const ranks = kids.map(x => x.rank).filter(r => r != null)
  const base = ranks.length ? Math.max(...ranks) : 0
  return { ok: true, rank: proofs.size ? Math.min(2, base + proofs.size - 1) : (ranks.length ? base : null), proofs }
}

// definition whose pattern reduces to ONE single port node (no http, header or macVendor
// proof): recognized by its port alone, hence low confidence, even if the port belongs to it
// alone. Rule carried by the definition, not by the node: a port inside an allOf keeps its
// rank (synology-dsm, definitions with an HTTP proof, bunkerweb and its three ports)
export const portOnly = d => Object.keys(d.match).length === 1 && Object.hasOwn(d.match, 'port')

// definitions × observations → Map port → { service, confidence } (best confidence, then file
// order); open ports without a definition are absent from the Map
export function recognise(defs, ctx) {
  const best = new Map()
  defs.defs.forEach((d, order) => {
    const r = evalMotif(d.match, { ...ctx, generic: d.category === 'generic' })
    if (!r.ok) return
    const rank = portOnly(d) ? 0 : r.rank ?? 0
    for (const p of portsOf(d.match)) {
      if (!ctx.open.has(p)) continue
      const cur = best.get(p)
      if (!cur || rank > cur.rank || (rank === cur.rank && order < cur.order)) best.set(p, { service: d.id, rank, order })
    }
  })
  return new Map([...best].map(([p, v]) => [p, { service: v.service, confidence: CONF[v.rank] }]))
}

// statuses expected by the http proofs of each (port, path): an answer with one of these
// statuses does not count in the 4xx budget (MAX_HTTP_4XX); MAX_HTTP_PER_HOST unchanged
export function expectedStatuses(defs) {
  const out = new Map()
  const visit = m => {
    const [k] = Object.keys(m)
    if (k === 'http' && m.http.status != null) {
      const key = `${m.http.port} ${m.http.path}`
      out.set(key, (out.get(key) ?? new Set()).add(m.http.status))
    } else if (k === 'anyOf' || k === 'allOf') m[k].forEach(visit)
    else if (k === 'not') visit(m.not)
  }
  for (const d of defs.defs) visit(d.match)
  return out
}

// unique (port, path) pairs of the HTTP proofs, on the open ports (open null: all); the paths
// that must answer 200 first, then file order; WITHOUT a ceiling (the test of the real file
// checks that no pair is truncated by httpPlan)
export function planCouples(defs, open = null) {
  const out = []
  const seen = new Map()
  const visit = m => {
    const [k] = Object.keys(m)
    if ((k === 'http' || k === 'header') && (!open || open.has(m[k].port))) {
      const key = `${m[k].port} ${m[k].path}`
      const first = k === 'http' && m[k].status === 200 ? 0 : 1
      const cur = seen.get(key)
      if (!cur) {
        const r = { port: m[k].port, path: m[k].path, first, order: seen.size }
        seen.set(key, r)
        out.push(r)
      } else cur.first = Math.min(cur.first, first)
    } else if (k === 'anyOf' || k === 'allOf') m[k].forEach(visit)
    else if (k === 'not') visit(m.not)
  }
  for (const d of defs.defs) visit(d.match)
  return out.sort((a, b) => a.first - b.first || a.order - b.order).map(({ port, path }) => ({ port, path }))
}
// HTTP requests needed for the open ports: planCouples, at most MAX_HTTP_PER_HOST (24)
export function httpPlan(defs, open) {
  return planCouples(defs, open).slice(0, MAX_HTTP_PER_HOST)
}
const headerNames = defs => {
  const names = new Set()
  const visit = m => {
    const [k] = Object.keys(m)
    if (k === 'header') names.add(m.header.name)
    else if (k === 'anyOf' || k === 'allOf') m[k].forEach(visit)
    else if (k === 'not') visit(m.not)
  }
  for (const d of defs.defs) visit(d.match)
  return names
}

// link to cfg.services: literal IPv4 AND port of the url (80/443 by default) or of a tcp check
// (target ip:port) or http check (url); a name is never resolved → Map "ip:port" → id
export function cfgServiceIndex(cfg) {
  const idx = new Map()
  const add = (ip, p, id) => {
    const k = `${ip}:${p}`
    if (ip && p && !idx.has(k)) idx.set(k, id)
  }
  const fromUrl = (u, id) => {
    const ip = literalIpv4(u)
    if (!ip) return
    let p
    try {
      const x = new URL(u)
      p = Number(x.port) || (x.protocol === 'https:' ? 443 : x.protocol === 'http:' ? 80 : null)
    } catch {
      return
    }
    add(ip, p, id)
  }
  for (const s of cfg.services ?? []) {
    if (s.url) fromUrl(s.url, s.id)
    for (const c of s.checks ?? []) {
      if (c.type === 'http' && c.url) fromUrl(c.url, s.id)
      if (c.type === 'tcp' && typeof c.target === 'string') {
        const i = c.target.lastIndexOf(':')
        const ip = c.target.slice(0, i)
        if (isIpv4(ip)) add(ip, Number(c.target.slice(i + 1)), s.id)
      }
    }
  }
  return idx
}

// --- addresses and targets -------------------------------------------------------------------

// literal IPv4 of a LAN subnet, neither network, broadcast nor multicast address
export function probeable(ip, cfg) {
  if (!isIpv4(ip)) return false
  const n = ipToInt(ip)
  if (n >= 0xe0000000 && n < 0xf0000000) return false // multicast 224.0.0.0/4
  for (const s of cfg.network?.subnets ?? []) {
    const c = parseCidr(s.cidr)
    if (!c || !inCidr(ip, c)) continue
    if (c.bits >= 31) return true
    return n !== c.base && n !== c.base + c.size - 1 // neither the network address nor broadcast
  }
  return false
}
// exclusion (IP or host id of the config)
// ABSOLUTE exclusion: the record is linked to a host whose id is excluded, OR its current IP
// is excluded, OR its current IP is the configured IP of a host excluded by id (re-read here, at probe time)
export function excluded(d, cfg) {
  const ex = cfg.network?.probe?.exclude ?? []
  if (!ex.length) return false
  if (d.host_id != null && ex.includes(d.host_id)) return true
  if (d.last_ip == null) return false
  if (ex.includes(d.last_ip)) return true
  return (cfg.hosts ?? []).some(h => ex.includes(h.id) && h.ip === d.last_ip)
}
const QUIET_TYPES = new Set(['iot', 'camera'])
// effective profile (as in index.js): entered, otherwise fixed for a config host, otherwise inferred
export const needsForce = (d, attrs = []) => {
  const profile = d.profile ?? (d.host_id ? 'fixed' : bestAttr(attrs, 'profile')?.value ?? 'normal')
  return profile === 'sleepy' || QUIET_TYPES.has(d.type) || QUIET_TYPES.has(d.disp_type) // entered or displayed
}
// planned targets, recomputed at each pass from cfg.hosts; online: ARP probe
export function plannedTargets(devices, cfg, { online = true, attrs = new Map() } = {}) {
  const hosts = new Map((cfg.hosts ?? []).map(h => [h.id, h]))
  return [...devices.values()].filter(d => {
    const h = d.host_id ? hosts.get(d.host_id) : null
    return h && h.kind !== 'external' && d.state === 'known' && probeable(d.last_ip, cfg) && !needsForce(d, attrs.get(d.id) ?? []) && !excluded(d, cfg)
      && (!online || d.online === 1)
  })
}

// --- own limiter --------------------------------------------------------------------------------

// semaphore (8) + bucket of 50 connections/s (TCP and HTTP); injectable clock and wait
export function createLimiter({ concurrency = CONCURRENCY, perSecond = RATE_PER_S, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let inFlight = 0
  let peak = 0
  const waiting = []
  const stamps = []
  async function run(fn) {
    // slot handed directly to the next one (never a 9th in flight between two ticks)
    if (inFlight >= concurrency) await new Promise(r => waiting.push(r))
    else inFlight++
    peak = Math.max(peak, inFlight)
    try {
      // bucket: once the token is taken, fn starts in the same tick (no wait in between)
      for (;;) {
        const t = now()
        while (stamps.length && t - stamps[0] >= 1000) stamps.shift()
        if (stamps.length < perSecond) {
          stamps.push(t)
          break
        }
        await sleep(Math.max(1, 1000 - (t - stamps[0])))
      }
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else inFlight--
    }
  }
  return { run, get peak() { return peak }, stamps }
}

// --- prober --------------------------------------------------------------------------------------

const noDns = (host, opts, cb) => cb(Object.assign(new Error('DNS interdit'), { code: 'ENODNS' }))
// one port: 'open' | 'refused' | 'unknown'; nothing is sent
export function tcpProbe(connect, ip, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise(resolve => {
    let done = false
    let sock
    const end = state => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock?.destroy()
      } catch { /* already destroyed */ }
      resolve(state)
    }
    const timer = setTimeout(() => end('unknown'), timeoutMs)
    try {
      sock = connect({ host: ip, port, lookup: noDns })
    } catch {
      end('unknown')
      return
    }
    sock.once('connect', () => end('open'))
    sock.once('error', e => end(e?.code === 'ECONNREFUSED' ? 'refused' : 'unknown'))
  })
}

// one HTTP GET: { status, body (lower case, ≤ 64 KB), bytes (bytes read; null if the body is
// not read), headers (named ones) }; never a redirect followed, never decompression (body
// ignored if Content-Encoding ≠ identity)
export async function httpGet(fetchImpl, ip, port, path, names = new Set(), { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(`http://${ip}:${port}${path}`, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
  })
  const headers = {}
  for (const n of names) {
    const v = res.headers.get(n)
    if (v != null) headers[n] = v.slice(0, MAX_HEADER).toLowerCase()
  }
  const enc = (res.headers.get('content-encoding') ?? '').trim().toLowerCase()
  let body = ''
  let bytes = null
  if (!enc || enc === 'identity') bytes = 0
  if (res.body && (!enc || enc === 'identity')) {
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (size >= MAX_BODY) break
    }
    await reader.cancel().catch(() => {})
    body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BODY)).toLowerCase()
    bytes = size
  } else {
    await res.body?.cancel().catch(() => {})
  }
  return { status: res.status, body, bytes, headers }
}

// observation of a host: definition ports (TCP), then the definition GETs on the open ports.
// extraPorts (still-open ports of the record, no longer in the definitions) are reviewed over
// TCP ONLY: no proof cites them, so httpPlan adds no request for them
export async function observeHost(ip, { defs, extraPorts = [], connect = net.connect, fetchImpl = fetch, limiter }) {
  const states = new Map()
  const ports = [...new Set([...defs.ports, ...extraPorts])]
  await Promise.all(ports.map(p => limiter.run(async () => { states.set(p, await tcpProbe(connect, ip, p)) })))
  const open = new Set([...states].filter(([, s]) => s === 'open').map(([p]) => p))
  const names = headerNames(defs)
  const cache = new Map()
  let requests = 0
  let c4xx = 0
  const expected = expectedStatuses(defs)
  for (const r of httpPlan(defs, open)) {
    if (c4xx >= MAX_HTTP_4XX) break // HTTP stopped for this host
    requests++
    try {
      const res = await limiter.run(() => httpGet(fetchImpl, ip, r.port, r.path, names))
      // a 4xx EXPECTED by a proof of this (port, path) does not count
      if (res.status >= 400 && res.status < 500 && !expected.get(`${r.port} ${r.path}`)?.has(res.status)) c4xx++
      cache.set(`${r.port} ${r.path}`, res)
    } catch {
      cache.set(`${r.port} ${r.path}`, null)
    }
  }
  return { states, open, resp: (p, path) => cache.get(`${p} ${path}`) ?? null, requests, c4xx }
}

// set of the records already probed (kv); also read and reduced by store.js
export const PROBED_KEY = 'network.probed'
function probedSet(kv) {
  try {
    const v = JSON.parse(kv.get(PROBED_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter(Number.isInteger) : [])
  } catch {
    return new Set()
  }
}

// --- service: passes, queue, schedule, writes -----------------------------------------------------

// dependencies: ns (network store), kv, cfg, clock, now, getState (network snapshot), afterWrite,
// connect and fetch (injectable), log
export function createProbe({ ns, kv, cfg, clock, now = () => Date.now(), getState, afterWrite = () => {}, connect = net.connect, fetchImpl = fetch, log = console,
  defsFile = DEFS_FILE, limiter = createLimiter({ now }), defsPlugins = serviceDefSets.list() }) {
  // shipped file, network.probe.defsDirs directories, plugin sets
  const defs = loadDefsSets({ file: defsFile, dirs: cfg.network?.probe?.defsDirs ?? [], plugins: defsPlugins })
  if (!defs.ok) log.error?.(`network: service probe disabled: ${defs.error}`)
  for (const s of defs.sets.slice(1)) if (s.error) log.error?.(`network: definitions dropped (${s.source}): ${s.error}`)
  // an exclusion that is neither an IPv4 address nor a config host (refused when the config is
  // loaded, checked again here) disables the probe, with a message
  const exclErr = (() => {
    const ids = new Set((cfg.hosts ?? []).map(h => h.id))
    const bad = (cfg.network?.probe?.exclude ?? []).filter(x => !isIpv4(x) && !ids.has(x))
    return bad.length ? `network.probe.exclude: "${String(bad[0]).slice(0, 64)}" is neither an IPv4 address nor a host` : null
  })()
  if (exclErr) log.error?.(`network: service probe disabled: ${exclErr}`)
  const usable = defs.ok && !exclErr
  const why = defs.ok ? exclErr : defs.error
  const cfgIdx = cfgServiceIndex(cfg)
  const queue = []
  let running = false
  let lastRun = null
  const lastAdmin = new Map() // record → last on-demand request
  let lastAll = null // last "Probe all"
  let current = null // job of the queue in progress
  const enabled = () => !!cfg.network?.probe?.enabled

  const refusedGet = () => {
    try {
      const v = JSON.parse(kv.get('network.probeRefused') || '[]')
      return new Set(Array.isArray(v) ? v : [])
    } catch {
      return new Set()
    }
  }
  const refusedSet = s => kv.set('network.probeRefused', JSON.stringify([...s].slice(-MAX_REFUSED)))

  // pass on a record: ports, definitions, net_ports, events (silent bootstrap)
  async function probeDevice(d, origin) {
    const t0 = now()
    const prev = new Map(ns.portsOf(d.id).filter(r => r.proto === 'tcp').map(r => [r.port, r]))
  // a still-open port that leaves the definitions is reviewed (closed at the 2nd refusal,
  // service and cfg_service recomputed), otherwise it would stay open forever
    const extraPorts = [...prev.values()].filter(r => r.closed_at == null && !defs.ports.includes(r.port)).map(r => r.port).slice(0, MAX_EXTRA_PORTS)
    const obs = await observeHost(d.last_ip, { defs, extraPorts, connect, fetchImpl, limiter })
    const vendor = d.vendor ?? bestAttr(getState().attrs?.get(d.id), 'vendor')?.value ?? null
    const found = recognise(defs, { open: obs.open, resp: obs.resp, vendor, portOwners: defs.portOwners })
  // silent bootstrap based on the persistent "already probed" marker (kv), safe from the
  // event purge; store.js reduces it on deletion and merge
    const done = probedSet(kv)
    const bootstrap = !done.has(d.id)
    const refused = refusedGet()
    const ops = []
    const t = now()
    for (const [p, state] of obs.states) {
      const key = `${d.id}:${p}`
      const was = prev.get(p)
      const wasOpen = !!was && was.closed_at == null
      if (state === 'open') {
        refused.delete(key)
        const f = found.get(p)
        ops.push({ op: 'upsertPort', device: d.id, proto: 'tcp', port: p, ts: t, service: f?.service ?? null, confidence: f?.confidence ?? null, cfg_service: cfgIdx.get(`${d.last_ip}:${p}`) ?? null })
        if (!wasOpen && !bootstrap) ops.push({ op: 'insertEvent', device: d.id, type: 'port_opened', ts: t, detail: `tcp/${p}${f ? ` (${f.service})` : ''}` })
      } else if (state === 'refused') {
        if (!wasOpen) continue
        if (refused.has(key)) {
          refused.delete(key)
          ops.push({ op: 'closePort', device: d.id, proto: 'tcp', port: p, ts: t })
          if (!bootstrap) ops.push({ op: 'insertEvent', device: d.id, type: 'port_closed', ts: t, detail: `tcp/${p}${was.service ? ` (${was.service})` : ''}` })
        } else refused.add(key) // first refusal: remembered, nothing is closed
      } else refused.delete(key) // unknown: closes nothing, and breaks the run of refusals
    }
    ops.push({ op: 'insertEvent', device: d.id, type: 'probed', ts: t, detail: probedDetail(origin, obs.open.size, obs.requests, obs.c4xx, t - t0) })
    ns.transaction(() => {
      ns.applyOps(ops)
      done.add(d.id)
      kv.set(PROBED_KEY, JSON.stringify([...done]))
    })
    refusedSet(refused)
    afterWrite()
  }

  // one pass at a time: the queue is drained by a single loop; an error on one host does not
  // stop the next ones
  let active = null
  const safe = async (d, origin) => {
    try {
      await probeDevice(d, origin)
    } catch (e) {
      log.warn?.(`network: probe of ${d.last_ip}: ${String(e.message || e).slice(0, 200)}`)
    }
  }
  function pump() {
    if (active) return active
    running = true
    active = (async () => {
      while (queue.length) {
        const job = queue.shift()
        current = job
        if (job.kind === 'planned') {
          const st = getState()
          for (const d of plannedTargets(st.devices, cfg, { attrs: st.attrs })) {
            // checked again right before: the record may have changed during another host's pass
            const now2 = getState()
            const cur = now2.devices.get(d.id)
            if (cur && plannedTargets(new Map([[cur.id, cur]]), cfg, { attrs: now2.attrs }).length) await safe(cur, job.origin ?? 'planned') // one host at a time
          }
        } else {
          const d = getState().devices.get(job.id)
          if (d && !excluded(d, cfg) && probeable(d.last_ip, cfg)) await safe(d, 'admin')
        }
        lastRun = now()
      }
    })().finally(() => {
      current = null
      running = false
      active = null
    })
    return active
  }
  const idle = () => active ?? Promise.resolve()

  // on-demand request (writes.js): checks done by the caller, except queue and delay
  function request(id) {
    if (!usable) return { ok: false, status: 503, error: tr('net.probe.disabled_why', { why }) }
    const t = now()
    const last = lastAdmin.get(id)
    if (last != null && t - last < ADMIN_EVERY_MS) return { ok: false, status: 429, retryAfter: Math.ceil((ADMIN_EVERY_MS - (t - last)) / 1000), error: tr('net.probe.too_soon') }
    if (queue.length >= MAX_QUEUE) return { ok: false, status: 429, retryAfter: 60, error: tr('net.probe.queue_full') }
    lastAdmin.set(id, t)
    queue.push({ kind: 'admin', id })
    Promise.resolve().then(pump) // after the transaction of the write (audit)
    return { ok: true }
  }

  // "Probe all" (admin): the Sunday pass started by hand, same targets and same rules
  // (exclusions, sleepy profile, IoT and cameras left out); only one queued or running
  function requestAll() {
    if (!usable) return { ok: false, status: 503, error: tr('net.probe.disabled_why', { why }) }
    if (!enabled()) return { ok: false, status: 409, error: tr('net.probe.disabled') }
    if (current?.kind === 'planned' || queue.some(j => j.kind === 'planned')) return { ok: false, status: 409, error: tr('net.probe.running') }
    const t = now()
    if (lastAll != null && t - lastAll < ALL_EVERY_MS) return { ok: false, status: 429, retryAfter: Math.ceil((ALL_EVERY_MS - (t - lastAll)) / 1000), error: tr('net.probe.all_too_soon') }
    if (queue.length >= MAX_QUEUE) return { ok: false, status: 429, retryAfter: 60, error: tr('net.probe.queue_full') }
    lastAll = t
    const st = getState()
    const targets = plannedTargets(st.devices, cfg, { attrs: st.attrs }).length
    queue.push({ kind: 'planned', origin: 'admin' })
    Promise.resolve().then(pump) // after the transaction of the write (audit)
    return { ok: true, targets }
  }

  // schedule: checked every minute; Sunday 04:00–04:59 local time, once a week
  function tick() {
    if (!usable || !enabled()) return false
    const l = clock.local(now())
    if (l.weekday !== 7 || l.minutes < 240 || l.minutes >= 300) return false
    if (kv.get('network.probeWeek') === l.date) return false
    kv.set('network.probeWeek', l.date)
    if (queue.length >= MAX_QUEUE) return false
    queue.push({ kind: 'planned' })
    pump()
    return true
  }
  // next Sunday 04:00 (local time) not yet done this week: one-hour steps (the local 04 hour
  // always exists, DST changes happen at 02:00 or 03:00)
  function nextRun(t = now()) {
    if (!enabled() || !usable) return null
    const t0 = Math.floor(t / 60_000) * 60_000
    for (let k = 0; k <= 8 * 24; k++) {
      const x = t0 + k * 3_600_000
      const l = clock.local(x)
      if (l.weekday !== 7 || l.minutes < 240 || l.minutes >= 300) continue
      if (kv.get('network.probeWeek') === l.date) continue
      const at = x - (l.minutes - 240) * 60_000
      return at >= t0 ? at : t0 // within the window, not yet done: at the next minute
    }
    return null
  }

  // digest line: ports opened or closed (24 h) on the infrastructure records
  function digestLine(t = now()) {
    const st = getState()
    // infrastructure records: attached to a host of cfg.hosts (excluding external)
    const hosts = new Map((cfg.hosts ?? []).map(h => [h.id, h]))
    const infra = new Set([...st.devices.values()].filter(d => d.host_id && hosts.has(d.host_id) && hosts.get(d.host_id).kind !== 'external').map(d => d.id))
    const ev = [...ns.eventsSince('port_opened', t - DAY), ...ns.eventsSince('port_closed', t - DAY)].filter(e => infra.has(e.device_id))
    if (!ev.length) return null
    const byDev = new Map()
    for (const e of ev.sort((a, b) => a.ts - b.ts)) byDev.set(e.device_id, [...(byDev.get(e.device_id) ?? []), `${e.type === 'port_opened' ? '+' : '−'}${e.detail}`])
    const parts = [...byDev].slice(0, 5).map(([id, list]) => tr('net.digest.port_item', { label: deviceLabel(st.devices.get(id) ?? { id }), ports: `${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}` }))
    return `${tr('net.digest.ports', { list: parts.join(' ; ') })}${byDev.size > 5 ? ' ; …' : ''}`
  }

  const status = () => ({ enabled: enabled(), defsOk: defs.ok, error: why, lastRun: lastRun == null ? null : new Date(lastRun).toISOString(),
    nextRun: (() => { const n = nextRun(); return n == null ? null : new Date(n).toISOString() })(), running, queued: queue.length,
    // added sets (directories, plugins), only if there are some: file name (not its path, read
    // by /api/network; the path is in the log) or plugin, number of definitions, error
    ...(defs.sets?.length > 1 ? { extraDefs: defs.sets.slice(1).map(s => ({ ...s, source: s.source.startsWith('plugin ') ? s.source : path.basename(s.source) })) } : {}) })

  return { defs, usable, request, requestAll, tick, pump, idle, digestLine, status, probeDevice, nextRun, get running() { return running }, queue }
}


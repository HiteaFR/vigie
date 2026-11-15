#!/usr/bin/env node
// One-off analysis of presence profiles and of alertDown candidates, on API snapshots ALREADY
// dropped in a directory (non-admin view):
//
//   node server/scripts/presence-analyse.js --in <snapshot directory> --out <file outside the directory>
//
// No network, no database: only reads files (lstat, regular files, compliant names, 2 MiB at
// most, invalid JSON ignored and counted), only writes --out (refused inside the input
// directory). Output: counts, histograms and record NUMBERS, never an IP, a MAC or a name; under
// 16 KB, as two Markdown tables.
import fs from 'node:fs'
import path from 'node:path'

const MAX_FILE = 2 * 1024 * 1024
const MAX_OUT = 16 * 1024
const MIN = 60_000
const DAY = 86_400_000
const ROOT_FILE = /^(network|history-(7|30))\.json$/
const DEVICE_FILE = /^\d{1,6}\.json$/
const PROFILE_MIN = { fixed: 5, normal: 10, sleepy: 45 }
const ABSENCE_BINS = [['< 5', 0, 5], ['5–10', 5, 10], ['10–20', 10, 20], ['20–45', 20, 45], ['45–60', 45, 60], ['60–180', 60, 180], ['≥ 180', 180, Infinity]]
const SESSION_BINS = [['< 15 min', 0, 15], ['15–60 min', 15, 60], ['1–6 h', 60, 360], ['6–24 h', 360, 1440], ['≥ 24 h', 1440, Infinity]]
const INFRA_TYPES = new Set(['router', 'switch', 'ap', 'nas'])

// safe read of a JSON file: lstat (regular file, not a link), size ≤ 2 MiB;
// → object, or null (counted in stats)
function readJson(file, stats) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch {
    stats.missing++
    return null
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    stats.notRegular++
    return null
  }
  if (st.size > MAX_FILE) {
    stats.tooBig++
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    stats.invalidJson++
    return null
  }
}

// dropped directory → { network, devices: Map id → detail, stats }
export function loadInput(dir) {
  const stats = { files: 0, missing: 0, notRegular: 0, tooBig: 0, invalidJson: 0, badName: 0 }
  const top = fs.lstatSync(dir)
  if (!top.isDirectory() || top.isSymbolicLink()) throw new Error('--in: a regular directory is expected')
  let network = null
  for (const name of fs.readdirSync(dir)) {
    if (name === 'devices' || name === 'ids.txt' || name === 'fetched-at.txt') continue
    if (!ROOT_FILE.test(name)) {
      stats.badName++
      continue
    }
    stats.files++
    const j = readJson(path.join(dir, name), stats)
    if (name === 'network.json') network = j
  }
  const devices = new Map()
  const ddir = path.join(dir, 'devices')
  let dst = null
  try {
    dst = fs.lstatSync(ddir)
  } catch { /* no devices directory */ }
  if (dst && dst.isDirectory() && !dst.isSymbolicLink()) {
    for (const name of fs.readdirSync(ddir)) {
      if (!DEVICE_FILE.test(name)) {
        stats.badName++
        continue
      }
      stats.files++
      const j = readJson(path.join(ddir, name), stats)
      if (j && Number.isInteger(j.id)) devices.set(j.id, j)
    }
  }
  return { network, devices, stats, fetchedAt: readFetchedAt(dir, stats) }
}
function readFetchedAt(dir, stats) {
  try {
    const f = path.join(dir, 'fetched-at.txt')
    const st = fs.lstatSync(f)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64) return null
    const t = Date.parse(fs.readFileSync(f, 'utf8').trim())
    return Number.isFinite(t) ? t : null
  } catch {
    stats.missing++
    return null
  }
}

const bin = (bins, minutes) => bins.find(([, lo, hi]) => minutes >= lo && minutes < hi)[0]
const emptyHist = bins => Object.fromEntries(bins.map(([k]) => [k, 0]))

// 90th percentile (nearest-rank method) of a list of numbers
export function p90(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]
}

// sessions of a record → absences and durations (minutes) within the window [from, to]
export function analyseSessions(sessions, { from, to }) {
  const list = (sessions ?? []).map(s => ({ start: Date.parse(s.start), end: s.end == null ? to : Date.parse(s.end) }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= from && s.start <= to)
    .map(s => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .sort((a, b) => a.start - b.start)
  const absences = []
  for (let i = 1; i < list.length; i++) {
    const gap = (list[i].start - list[i - 1].end) / MIN
    if (gap >= 0) absences.push(gap)
  }
  const durations = list.map(s => (s.end - s.start) / MIN)
  return { absences, durations, capped: (sessions ?? []).length >= 200 }
}

// proposed profile: the smallest one whose delay covers the 90th percentile of the comings and goings
export function proposeProfile(flaps) {
  const q = p90(flaps)
  if (q == null) return null
  for (const p of ['fixed', 'normal', 'sleepy']) if (q <= PROFILE_MIN[p]) return { profile: p, p90: q, still: false }
  return { profile: 'sleepy', p90: q, still: true }
}

// already covered by another kind of monitoring, according to the dropped files: pve (guest or
// Proxmox node of a config host), agent (host with an agent, if the snapshot says so), checks
// (config services on the record); no effect on the method
function coveredBy(d) {
  const by = []
  if (d.hostId && ['vm', 'lxc', 'pve-node'].includes(d.host?.kind)) by.push('pve')
  if (d.hostId && d.host?.agent) by.push('agent')
  if (Array.isArray(d.services) && d.services.length) by.push('checks')
  return by
}

// full analysis → { flapping: [...], alertDown: [...], agg, stats }
export function analyse({ network, devices, fetchedAt, stats }) {
  const from = Date.parse(network?.presenceSince ?? '')
  const to = fetchedAt
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('undetermined window (presenceSince, fetched-at)')
  const days = (to - from) / DAY
  const agg = { devices: 0, absences: emptyHist(ABSENCE_BINS), sessions: emptyHist(SESSION_BINS) }
  const flapping = []
  const candidates = []
  for (const [id, d] of [...devices].sort((a, b) => a[0] - b[0])) {
    agg.devices++
    const { absences, durations, capped } = analyseSessions(d.sessions, { from, to })
    for (const a of absences) agg.absences[bin(ABSENCE_BINS, a)]++
    for (const s of durations) agg.sessions[bin(SESSION_BINS, s)]++
    const flaps = absences.filter(a => a <= 60)
    const isFlapping = capped || (flaps.length >= 6 && flaps.length / days >= 3)
    if (isFlapping) {
      const p = proposeProfile(flaps)
      flapping.push({ id, sessions: capped ? '≥ 200' : String(durations.length), flaps: flaps.length, perDay: Math.round((flaps.length / days) * 10) / 10,
        p90: p?.p90 == null ? null : Math.round(p.p90 * 10) / 10, current: d.profile ?? null, set: d.profileSet ? 'yes' : 'no',
        proposed: p ? `${p.profile}${p.still ? ' (still flapping)' : ''}` : '—' })
    }
    const infra = (d.hostId && d.host?.kind !== 'external') || INFRA_TYPES.has(d.type)
    if (infra && !d.alertDown && !isFlapping) {
      candidates.push({ id, kind: d.hostId ? `host (${d.host?.kind ?? '?'})` : String(d.type), absences: absences.length, longest: absences.length ? Math.round(Math.max(...absences)) : 0, profile: d.profile ?? null,
        covered: coveredBy(d) })
    }
  }
  return { from, to, days: Math.round(days * 10) / 10, flapping, candidates, agg, stats }
}

// Markdown rendering, without IP, MAC or name (record numbers only)
export function render(r) {
  const h = o => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(' · ')
  const lines = [
    `# Presence analysis (profiles and alertDown candidates)`,
    '',
    `Window: ${new Date(r.from).toISOString()} → ${new Date(r.to).toISOString()} (${r.days} d); devices: ${r.agg.devices}.`,
    `Files: ${r.stats.files} read; skipped: ${r.stats.notRegular} not regular, ${r.stats.tooBig} too big, ${r.stats.invalidJson} invalid JSON, ${r.stats.badName} non-conforming names.`,
    '',
    `Absences (min): ${h(r.agg.absences)}`,
    `Sessions: ${h(r.agg.sessions)}`,
    '',
    '## 1. Flapping devices',
    '',
  ]
  if (!r.flapping.length) lines.push('No device is flapping: the presence thresholds can stay as they are.')
  else {
    lines.push('| Device | Sessions | Flaps (≤ 60 min) | Per day | 90th percentile (min) | Current profile | Set | Proposed profile |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const f of r.flapping) lines.push(`| ${f.id} | ${f.sessions} | ${f.flaps} | ${f.perDay} | ${f.p90 ?? '—'} | ${f.current ?? '—'} | ${f.set} | ${f.proposed} |`)
  }
  lines.push('', '## 2. Candidates for alertDown', '')
  if (!r.candidates.length) lines.push('No candidate.')
  else {
    lines.push('| Device | Kind | Absences | Longest (min) | Profile | Already covered by |', '| --- | --- | --- | --- | --- | --- |')
    for (const c of r.candidates) lines.push(`| ${c.id} | ${c.kind} | ${c.absences} | ${c.longest} | ${c.profile ?? '—'} | ${c.covered.length ? c.covered.join(', ') : '—'} |`)
  }
  return `${lines.join('\n')}\n`
}

export function main(argv) {
  const get = k => {
    const i = argv.indexOf(k)
    const v = i >= 0 ? argv[i + 1] : null
    if (!v || v.startsWith('--')) throw new Error(`${k}: missing value`)
    return v
  }
  // REAL paths (links resolved) of --in and of the --out directory; --out neither a link nor existing
  const input = fs.realpathSync(path.resolve(get('--in')))
  const outArg = path.resolve(get('--out'))
  const outDir = fs.realpathSync(path.dirname(outArg))
  const out = path.join(outDir, path.basename(outArg))
  const inside = p => {
    const rel = path.relative(input, p)
    return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  if (inside(outDir) || inside(out)) throw new Error('--out: refused inside the input directory')
  let existing = null
  try {
    existing = fs.lstatSync(out)
  } catch { /* missing: expected */ }
  if (existing?.isSymbolicLink()) throw new Error('--out: refused, it is a link')
  const text = render(analyse(loadInput(input)))
  if (Buffer.byteLength(text) > MAX_OUT) throw new Error('output too big')
  fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' }) // exclusive creation: never through a link
  return text
}

if (process.argv[1] && process.argv[1] === import.meta.filename) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`presence-analyse: ${e.message}`)
    process.exit(1)
  }
}

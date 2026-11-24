// Versions and updates: information only, nothing is applied.
//
// A "component" = one versioned thing in one place: a service's app
// (config `version`), a container image, a host's OS, Proxmox, Home Assistant
// update.* entities, runtime (Node, PHP…), apt packages, deployment drift of a
// Gitea repository. For each one: installed, latest, gap, security, end of
// life, link to the release notes.
//
// The recomputation runs every 10 min but only triggers an upstream call
// when the source's cache has expired (6 h for forges and registries).
// Each new version is announced only once (versions table, notified_latest),
// in the digest; a security fix or a passed end of life goes through the
// alert engine (warning, no reminder).
import { versionGap, compareVersions, parseVersion, newest, majorOf, tagShape, GAP_RANK } from '../version.js'
import { parseImageRef, explicitRegistry } from './upstream.js'
import { createSecurityPending, autoActive } from './pending.js'
import { autoUpdateStatus } from './autostatus.js'
import { SLOW_SEC } from '../agents.js'
import { latestSources, currentSources } from '../registry.js'
import { redactError } from '../redact.js'
import './source-types.js'
import { localeTag, t as tr } from '../i18n.js'

// a slow report older than 2 cycles (2 h) says nothing more about the night: the host
// leaves the "applied tonight" lines and goes to "no recent report"
export const SLOW_REPORT_MAX_AGE_MS = 2 * SLOW_SEC * 1000

const TICK_MS = 10 * 60_000
const MAX_CONCURRENT = 4
const EOL_SOON_DAYS = 90
const SECURITY = /\bCVE-\d{4}-\d{4,}\b|\bGHSA(-[a-z0-9]{4}){3}\b|security (fix|update|release|patch|issue|advisor)|vulnerabilit(y|ies) (fix|in|was|has)|fix(es|ed)? (a )?(security|vulnerabilit)/i
const CVE = /\bCVE-\d{4}-\d{4,}\b/
// Debian codename of a Proxmox VE major version
const PVE_CODENAME = { 7: 'bullseye', 8: 'bookworm', 9: 'trixie', 10: 'forky' }
// packages reported by the agent: endoflife.date product and cycle from the version
const RUNTIMES = {
  nodejs: { name: 'Node.js', eol: 'nodejs', cycle: v => String(majorOf(v)) },
  php: { name: 'PHP', eol: 'php', cycle: v => parseVersion(v)?.nums.slice(0, 2).join('.') },
  mariadb: { name: 'MariaDB', eol: 'mariadb', cycle: v => parseVersion(v)?.nums.slice(0, 2).join('.') },
  postgresql: { name: 'PostgreSQL', eol: 'postgresql', cycle: v => String(majorOf(v)) },
}

const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const dayMs = 86400_000

// "a.b" or ["nas", "Synology (DSM 7.2.2+)", "version"]
function pick(obj, path) {
  const keys = Array.isArray(path) ? path : String(path).split('.')
  let cur = obj
  for (const k of keys) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

function limiter(n) {
  let active = 0
  const q = []
  const next = () => {
    if (active >= n || !q.length) return
    active++
    const [fn, res, rej] = q.shift()
    fn().then(res, rej).finally(() => {
      active--
      next()
    })
  }
  return fn => new Promise((res, rej) => {
    q.push([fn, res, rej])
    next()
  })
}

// releases (forge, PyPI, nodejs.org) → latest, skipped versions, security
export function fromReleases(list, current, { tagPattern } = {}) {
  const re = tagPattern ? new RegExp(tagPattern) : null
  const rels = list.filter(r => !r.prerelease && (!re || re.test(r.tag)) && parseVersion(r.tag) && !parseVersion(r.tag).prerelease)
  const latest = newest(rels, { pick: r => r.tag })
  if (!latest) return null
  const cur = parseVersion(current)
  const between = cur ? rels.filter(r => compareVersions(r.tag, cur) > 0 && compareVersions(r.tag, latest.tag) <= 0) : []
  const sec = between.filter(r => SECURITY.test(r.body || ''))
  const major = cur?.nums[0]
  const sameMajor = cur ? newest(rels.filter(r => majorOf(r.tag) === major), { pick: r => r.tag }) : null
  return {
    latest: latest.tag, url: latest.url ?? null, publishedAt: latest.published ?? null,
    notes: latest.body ? latest.body.slice(0, 3000) : null,
    skipped: between.length,
    breaking: between.filter(r => /breaking/i.test(r.body || '')).length,
    security: sec.length > 0,
    cve: sec.map(r => r.body.match(CVE)?.[0]).find(Boolean) ?? null,
    // (skipped) version whose notes announce the fix
    securityIn: sec.length ? sec[sec.length - 1].tag : null,
    latestSameMajor: sameMajor?.tag ?? null,
  }
}

export function eolInfo(cycles, cycle, now = Date.now()) {
  const c = cycles?.find(x => x.cycle === String(cycle))
  if (!c) return null
  const date = typeof c.eol === 'string' ? c.eol : null
  const passed = c.eol === true || (date != null && Date.parse(date) <= now)
  const soon = !passed && date != null && Date.parse(date) - now < EOL_SOON_DAYS * dayMs
  return { cycle: c.cycle, date, passed, soon, link: c.link ?? null }
}

// most recent published cycle (for "new major version available")
const newestCycle = cycles => newest(cycles.filter(c => !c.releaseDate || Date.parse(c.releaseDate) <= Date.now()), { pick: c => c.cycle })

// extraComponents: items from modules and plugins (host.components(): repositories of the gitea plugin…),
// formatted like the others (component)
// pluginTimeoutMs: timeout of a plugin's version source (tests)
export function createUpdates({ cfg, store, agents, sources, collector, upstream, decisions = null, env = process.env, log = console, extraComponents = () => [], pluginTimeoutMs = 30_000 }) {
  const { db } = store
  // age of pending security fixes under automatic updates (in the database)
  const pending = createSecurityPending({ db, hostIds: cfg.hosts.filter(h => h.agent).map(h => h.id) })
  const observePending = now => {
    try { pending.observe(agents, now) } catch (e) { log.error(`pending fixes: ${e.message}`) }
  }
  const q = {
    all: db.prepare('SELECT * FROM versions'),
    upsert: db.prepare(`INSERT INTO versions (id, latest, first_seen, notified_latest, updated_at) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET latest = excluded.latest,
        first_seen = CASE WHEN versions.latest IS excluded.latest THEN versions.first_seen ELSE excluded.first_seen END,
        updated_at = excluded.updated_at`),
    notified: db.prepare('UPDATE versions SET notified_latest = ? WHERE id = ?'),
  }
  const hosts = new Map(cfg.hosts.map(h => [h.id, h]))
  const pveNode = id => cfg.hosts.find(h => h.kind === 'pve-node' && h.pve === id)
  const limit = limiter(MAX_CONCURRENT)
  const U = cfg.updates
  let components = []
  let raw = [] // before decisions: a decision taken from the UI is reapplied without an upstream call
  let checkedAt = null
  let running = null
  const errors = new Map() // component → collection error

  function where(hostId) {
    const h = hosts.get(hostId)
    if (!h) return null
    if (h.kind === 'vm' || h.kind === 'lxc') return `${h.kind === 'lxc' ? 'CT' : 'VM'} ${h.vmid} · ${pveNode(h.pve)?.name || h.pve}`
    return h.name
  }
  const envOf = hostId => hosts.get(hostId)?.env ?? 'prod'

  function secretHeaders(auth) {
    if (!auth) return {}
    const v = env[auth.secretEnv]
    if (!v) throw new Error(tr('updates.var_missing', { name: auth.secretEnv }))
    return { [auth.name]: v }
  }

  // --- installed version and latest version through the registries (lib/updates/source-types.js
  // for core ones, then plugins). A plugin entry is time-bounded (pluginTimeoutMs) and its
  // error prefixed and masked (lib/redact.js); it stays DATA of the component (error field,
  // counted in the errors of the updates page), like an unreachable upstream source: no
  // plugin_error, the page already shows it
  function bounded(entry, what, fn) {
    if (entry.owner === 'core') return fn()
    let timer
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(tr('updates.timeout'))), pluginTimeoutMs)
    })
    return Promise.race([Promise.resolve().then(fn), deadline])
      .catch(e => { throw new Error(tr('updates.plugin_error', { what, owner: entry.owner, error: redactError(e, entry.secretValues) })) })
      .finally(() => clearTimeout(timer))
  }
  async function resolveCurrent(src, hostId) {
    const e = currentSources.get(src.from)
    if (!e) throw new Error(tr('updates.unknown_current', { from: src.from }))
    const v = await bounded(e, tr('updates.what_current', { name: e.name }), () => e.current(src, { hostId, agents, upstream, secretHeaders, pick }))
    if (e.owner !== 'core' && (v == null || typeof v === 'object')) throw new Error(tr('updates.no_version', { name: e.name, owner: e.owner }))
    return e.owner === 'core' ? v : String(v)
  }
  async function resolveLatest(src, current) {
    const e = latestSources.get(src.from)
    if (!e) return { latest: null }
    const releases = list => fromReleases(list, current, src) ?? { latest: null }
    const r = await bounded(e, tr('updates.what_latest', { name: e.name }), () => e.latest(src, { current, upstream, releases, pick }))
    if (e.owner === 'core') return r
    // plugin: known fields only
    return {
      latest: r?.latest != null ? String(r.latest) : null,
      ...(r?.url != null ? { url: String(r.url) } : {}),
      ...(r?.publishedAt != null ? { publishedAt: String(r.publishedAt) } : {}),
      ...(r?.latestSameMajor != null ? { latestSameMajor: String(r.latestSameMajor) } : {}),
      ...(r?.nextMajor != null ? { nextMajor: String(r.nextMajor) } : {}),
      ...(Number.isInteger(r?.skipped) ? { skipped: r.skipped } : {}),
      ...(r?.notes != null ? { notes: String(r.notes) } : {}),
    }
  }
  // displayed source of a latest version (github:<repo>, otherwise the source name)
  const sourceLabel = src => {
    if (!src) return null
    const e = latestSources.get(src.from)
    return e?.label ? e.label(src) : src.from ?? null
  }

  // "1.26.1 → v28.1.0": same prefix convention on both sides
  const sameStyle = (cur, lat) => (cur != null && lat != null && /^\d/.test(cur) && /^v\d/.test(lat) ? lat.slice(1) : lat)

  function component(base) {
    base = { ...base, latest: sameStyle(base.current, base.latest), latestSameMajor: sameStyle(base.current, base.latestSameMajor), nextMajor: sameStyle(base.current, base.nextMajor) }
    return {
      id: base.id, name: base.name, kind: base.kind, host: base.host ?? null, where: base.where ?? where(base.host),
      env: base.env ?? envOf(base.host), service: base.service ?? null,
      current: base.current ?? null, latest: base.latest ?? null,
      gap: base.gap !== undefined ? base.gap : versionGap(base.current, base.latest),
      url: base.url ?? null, publishedAt: base.publishedAt ?? null, notes: base.notes ?? null,
      skipped: base.skipped ?? null, breaking: base.breaking ?? 0, security: !!base.security, cve: base.cve ?? null, securityIn: base.securityIn ?? null,
      latestSameMajor: base.latestSameMajor ?? null, nextMajor: base.nextMajor ?? null,
      eol: base.eol ?? null, auto: !!base.auto, local: !!base.local, detail: base.detail ?? null,
      source: base.source ?? null, error: base.error ?? null, apt: base.apt ?? null,
      newImage: !!base.newImage,
    }
  }

  async function serviceComponents() {
    const jobs = []
    for (const s of cfg.services) {
      if (!s.version) continue
      if (s.version.from === 'ha') {
        jobs.push(limit(() => haComponents(s)))
        continue
      }
      const list = Array.isArray(s.version) ? s.version : [s.version]
      for (const v of list) {
        const id = list.length > 1 ? `svc:${s.id}:${slug(v.name || 'app')}` : `svc:${s.id}`
        const base = { id, name: v.name || s.name, kind: 'app', host: s.host, env: s.env, service: s.id, auto: v.auto, source: sourceLabel(v.latest) }
        jobs.push(limit(async () => {
          let current = null
          try {
            current = await resolveCurrent(v.current, s.host)
            const r = v.latest ? await resolveLatest(v.latest, current) : { latest: null }
            return [component({ ...base, current, ...r, url: r.url ?? v.notes ?? null })]
          } catch (e) {
            return [component({ ...base, current, gap: null, error: String(e.message || e) })]
          }
        }))
      }
    }
    return (await Promise.all(jobs)).flat()
  }

  async function haComponents(s) {
    const v = s.version
    const base = { kind: 'ha', host: s.host, env: s.env, service: s.id, source: 'home-assistant' }
    try {
      const token = env[v.secretEnv]
      if (!token) throw new Error(tr('updates.var_missing', { name: v.secretEnv }))
      const states = await upstream.httpJson(`${v.url.replace(/\/$/, '')}/api/states`, { headers: { Authorization: `Bearer ${token}` }, secret: true })
      if (!Array.isArray(states)) throw new Error(tr('updates.ha_unexpected'))
      return states.filter(x => x.entity_id?.startsWith('update.') && x.attributes?.installed_version)
        .map(x => {
          const a = x.attributes
          return component({
            ...base, id: `ha:${x.entity_id.slice(7)}`,
            name: a.title || a.friendly_name || x.entity_id,
            current: String(a.installed_version), latest: a.latest_version != null ? String(a.latest_version) : null,
            // HA itself says whether an update is available (state on/off)
            gap: x.state === 'on' ? versionGap(a.installed_version, a.latest_version) ?? 'unknown' : 'same',
            url: a.release_url || null, auto: !!a.auto_update, detail: a.release_summary || null,
          })
        })
    } catch (e) {
      return [component({ ...base, id: `ha:${s.id}`, name: s.name, gap: null, error: String(e.message || e) })]
    }
  }

  // containers reported by the agent: tag digest, and more recent tags of the same shape
  async function dockerComponents() {
    const jobs = []
    const declared = new Set(cfg.services.filter(s => s.version && s.container).map(s => `${s.host}/${s.container}`))
    for (const h of agents?.hosts || []) {
      // containers of this host kept off the updates page (host option)
      if (hosts.get(h.id)?.updates?.containers === false) continue
      const st = agents.get(h.id)
      for (const c of st?.fast?.docker?.containers || []) {
        const img = st.slow?.images?.find(i => i.id === c.imageId)
        const ref = parseImageRef(c.image)
        const svc = cfg.services.find(s => s.host === h.id && s.container && (c.name === s.container || c.service === s.container))
        const base = { id: `docker:${h.id}/${c.name}`, name: c.name, kind: 'docker', host: h.id, service: svc?.id ?? null, detail: c.image, source: ref ? `${ref.registry}/${ref.repo}` : null }
        const digests = (img?.digests || []).filter(d => d.includes('@sha256:'))
        if (!ref || (img && !digests.length)) {
          jobs.push(Promise.resolve([component({ ...base, current: ref?.tag ?? c.image, local: true, gap: null })]))
          continue
        }
        jobs.push(limit(async () => {
          try {
            const remote = await upstream.remoteDigest(ref)
            let gap = 'same'
            let latest = ref.tag
            let extra = {}
            // image the slow inventory does not know yet (rebuilt since the last slow
            // report), implicit docker.io, and Docker Hub does not know it either (401: repository
            // does not exist): image built locally, like a known image without a digest. A 404
            // (public repository, missing tag), explicit registries and known images keep
            // their error
            if (remote.denied && !img && !explicitRegistry(c.image)) {
              return [component({ ...base, current: ref.tag, local: true, gap: null })]
            }
            if (remote.denied) return [component({ ...base, current: ref.tag, gap: null, error: `${ref.registry} : HTTP 401` })]
            if (remote.missing) return [component({ ...base, current: ref.tag, gap: null, error: tr('updates.tag_missing', { tag: ref.tag }) })]
            if (img && remote.digest && !digests.some(d => d.endsWith(remote.digest))) gap = 'digest'
            // kept aside: a more recent tag hides the gap, pinning restores it
            const newImage = gap === 'digest'
            // fixed tag (16-alpine, v1.21): is there a more recent tag of the same shape?
            if (/\d/.test(ref.tag) && !declared.has(`${h.id}/${c.name}`) && !declared.has(`${h.id}/${c.service}`)) {
              const tags = await upstream.remoteTags(ref)
              const shape = tagShape(ref.tag)
              const same = tags.filter(t => tagShape(t.tag) === shape)
              const best = newest(same, { pick: t => t.tag })
              if (best && compareVersions(best.tag, ref.tag) > 0) {
                latest = best.tag
                gap = versionGap(ref.tag, best.tag)
                const sameMajor = newest(same.filter(t => majorOf(t.tag) === majorOf(ref.tag)), { pick: t => t.tag })
                extra = { publishedAt: best.published, latestSameMajor: sameMajor?.tag ?? null }
              }
            }
            return [component({ ...base, current: ref.tag, latest, gap, newImage, ...extra, detail: gap === 'digest' ? tr('updates.new_image', { tag: ref.tag }) : c.image })]
          } catch (e) {
            return [component({ ...base, current: ref.tag, gap: null, error: String(e.message || e) })]
          }
        }))
      }
    }
    return (await Promise.all(jobs)).flat()
  }

  // OS of equipped hosts: end of life and new major version
  async function osComponents() {
    const out = []
    for (const h of agents?.hosts || []) {
      const f = agents.get(h.id)?.fast
      if (!f?.osId || !['debian', 'ubuntu'].includes(f.osId)) continue
      const base = { id: `os:${h.id}`, name: f.osId[0].toUpperCase() + f.osId.slice(1), kind: 'os', host: h.id, source: `endoflife:${f.osId}` }
      try {
        const cycles = await limit(() => upstream.eol(f.osId))
        const cycle = f.osId === 'debian' ? String(majorOf(f.osVersion)) : f.osVersion
        const top = newestCycle(cycles)
        const nextMajor = top && compareVersions(top.cycle, cycle) > 0 ? top.cycle : null
        out.push(component({
          ...base, current: f.osVersion, latest: nextMajor, gap: nextMajor ? 'major' : 'same',
          eol: eolInfo(cycles, cycle), nextMajor, url: top?.link ?? null,
        }))
      } catch (e) {
        out.push(component({ ...base, current: f.osVersion, gap: null, error: String(e.message || e) }))
      }
    }
    return out
  }

  // runtimes reported by the agent (Node: latest of the same branch; others: end of life)
  async function runtimeComponents() {
    const jobs = []
    for (const h of agents?.hosts || []) {
      const vers = agents.get(h.id)?.slow?.versions || {}
      for (const [pkg, v] of Object.entries(vers)) {
        const key = Object.keys(RUNTIMES).find(k => pkg === k || pkg.startsWith(`${k}-`) || (k === 'php' && /^php\d/.test(pkg)) || (k === 'postgresql' && /^postgresql-\d/.test(pkg)))
        if (!key) continue
        const R = RUNTIMES[key]
        const base = { id: `runtime:${h.id}/${key}`, name: R.name, kind: 'runtime', host: h.id, current: v, source: `endoflife:${R.eol}` }
        jobs.push(limit(async () => {
          try {
            const cycles = await upstream.eol(R.eol)
            const eol = eolInfo(cycles, R.cycle(v))
            let r = {}
            if (key === 'nodejs') {
              const rel = await upstream.node()
              const line = rel.filter(x => majorOf(x.tag) === majorOf(v))
              const best = newest(line, { pick: x => x.tag })
              const lts = newest(rel.filter(x => x.lts), { pick: x => x.tag })
              r = {
                latest: best?.tag ?? null, publishedAt: best?.published ?? null,
                url: best ? `https://nodejs.org/en/blog/release/${best.tag}` : null,
                nextMajor: lts && majorOf(lts.tag) > majorOf(v) ? lts.tag : null,
              }
            }
            return [component({ ...base, ...r, gap: r.latest ? versionGap(v, r.latest) : 'same', eol })]
          } catch (e) {
            return [component({ ...base, gap: null, error: String(e.message || e) })]
          }
        }))
      }
    }
    return (await Promise.all(jobs)).flat()
  }

  // Proxmox VE: installed pve-manager, latest of the branch (public apt index), end of life
  async function pveComponents() {
    const out = []
    let data
    try {
      data = await sources.pveVersions()
    } catch (e) {
      return [component({ id: 'pve', name: 'Proxmox VE', kind: 'pve', gap: null, error: String(e.message || e) })]
    }
    for (const c of data) {
      const node = pveNode(c.id)
      for (const n of c.nodes || [{ error: c.error }]) {
        const base = { id: `pve:${c.id}${(c.nodes?.length ?? 1) > 1 ? `/${n.node}` : ''}`, name: 'Proxmox VE', kind: 'pve', host: node?.id ?? null, where: n.node || node?.name || c.id, env: node?.env, source: 'download.proxmox.com' }
        if (n.error || c.error) {
          out.push(component({ ...base, gap: null, error: n.error || c.error }))
          continue
        }
        try {
          const major = majorOf(n.version)
          const [pkgs, cycles] = await Promise.all([
            PVE_CODENAME[major] ? limit(() => upstream.pvePackages(PVE_CODENAME[major])) : null,
            limit(() => upstream.eol('proxmox-ve')),
          ])
          const latest = newest(pkgs?.['pve-manager'] || [])
          const top = newestCycle(cycles)
          const nextMajor = top && Number(top.cycle) > major ? top.latest || top.cycle : null
          out.push(component({
            ...base, current: n.version, latest,
            eol: eolInfo(cycles, String(major)), nextMajor,
            url: 'https://pve.proxmox.com/wiki/Roadmap',
            detail: n.kernel ? `noyau ${n.kernel}` : null,
          }))
        } catch (e) {
          out.push(component({ ...base, current: n.version, gap: null, error: String(e.message || e) }))
        }
      }
    }
    return out
  }

  // apt packages of hosts (agent, slow mode): one line per host
  function aptComponents() {
    const out = []
    for (const h of agents?.hosts || []) {
      const st = agents.get(h.id)
      const apt = st?.slow?.apt
      if (!apt) continue
      const ageDays = apt.listsAt ? (Date.now() / 1000 - apt.listsAt) / 86400 : null
      // agent v5: held packages (apt-mark hold) left out of the "pending" count
      const held = (apt.packages || []).filter(p => p.held).map(p => p.name)
      out.push(component({
        id: `apt:${h.id}`, name: tr('updates.apt.name'), kind: 'apt', host: h.id,
        current: `${tr('updates.apt.pending', { count: apt.upgradable })}${apt.held ? tr('updates.apt.held', { count: apt.held }) : ''}`, latest: null,
        gap: apt.upgradable > 0 ? 'patch' : 'same',
        security: apt.security > 0,
        detail: [
          apt.security ? tr('updates.apt.security', { count: apt.security }) : null,
          held.length ? tr('updates.apt.holds', { list: `${held.slice(0, 6).join(', ')}${held.length > 6 ? '…' : ''}` }) : null,
          ageDays > cfg.alerts.aptMaxAgeDays ? tr('updates.apt.lists_age', { d: Math.floor(ageDays) }) : null,
        ].filter(Boolean).join(' · ') || null,
        // "automatic updates" state of the host
        apt: { upgradable: apt.upgradable, security: apt.security, held: apt.held ?? 0, ageDays, autoUpdate: autoUpdateStatus(st.slow, { maxAgeHours: cfg.alerts.autoUpdateMaxAgeHours }) },
      }))
    }
    return out
  }

  // decisions: config (updates.ignore) then those taken from the UI or the bot
  // (update_decisions table): ignore a version, postpone, pin
  const rules = () => [
    ...U.ignore.map(r => ({ ...r, source: 'config' })),
    ...(decisions?.active() || []).map(r => ({ ...r, source: 'ui' })),
  ]
  function decide(c, now) {
    for (const rule of rules()) {
      const match = rule.id.endsWith('*') ? c.id.startsWith(rule.id.slice(0, -1)) : c.id === rule.id
      if (!match) continue
      if (rule.until && Date.parse(rule.until) < now) continue
      if (rule.pin === 'major' && c.gap === 'major') {
        // pinned to its major version: only the same branch is considered
        const sm = c.latestSameMajor
        let g = sm ? versionGap(c.current, sm) : 'same'
        // floating tag (16-alpine): new image of the same major version
        if (g === 'same' && c.newImage) g = 'digest'
        return { ...c, latest: sm ?? c.current, gap: g, detail: g === 'digest' ? tr('updates.new_image', { tag: c.current }) : c.detail, pinned: { pin: 'major', reason: rule.reason ?? null, hidden: c.latest, source: rule.source, decisionId: rule.decisionId ?? null } }
      }
      if (rule.pin) continue
      if (rule.version && rule.version.replace(/^v/, '') !== String(c.latest).replace(/^v/, '')) continue
      return { ...c, ignored: { reason: rule.reason ?? null, until: rule.until ?? null, version: rule.version ?? null, source: rule.source, decisionId: rule.decisionId ?? null } }
    }
    return c
  }

  async function refresh(now = Date.now()) {
    if (running) return running
    running = (async () => {
      observePending(now)
      const parts = await Promise.allSettled([
        serviceComponents(), dockerComponents(), osComponents(), runtimeComponents(), pveComponents(),
      ])
      const list = [...aptComponents(), ...extraComponents().map(component)]
      for (const p of parts) {
        if (p.status === 'fulfilled') list.push(...p.value)
        else log.error(`versions: ${p.reason?.message || p.reason}`)
      }
      const seen = q.all.all()
      const byId = new Map(seen.map(r => [r.id, r]))
      for (const c of list) {
        if (c.latest == null) continue
        q.upsert.run(c.id, c.latest, now, now)
        const row = byId.get(c.id)
        c.firstSeenAt = row && row.latest === c.latest ? row.first_seen : now
      }
      raw = list
      components = list.map(c => decide(c, now))
      checkedAt = now
      for (const c of components) {
        if (c.error) errors.set(c.id, c.error)
        else errors.delete(c.id)
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  // outdated and to be reported (neither ignored nor auto-updated: config auto, HA)
  const outdated = c => !c.ignored && !c.auto && ['major', 'minor', 'patch', 'digest', 'unknown'].includes(c.gap) && c.kind !== 'apt' && c.kind !== 'deploy'

  function counts(list) {
    const k = { security: 0, eol: 0, major: 0, minor: 0, patch: 0, digest: 0, deploy: 0, auto: 0, ignored: 0, total: 0, errors: 0 }
    for (const c of list) {
      if (c.error) k.errors++
      if (c.ignored) {
        k.ignored++
        continue
      }
      if (c.eol?.passed) k.eol++
      if (c.security && (outdated(c) || c.kind === 'apt')) k.security++
      if (c.auto && c.gap !== 'same') k.auto++
      if (outdated(c)) {
        k.total++
        if (k[c.gap] != null) k[c.gap]++
      }
      if (c.gap === 'deploy') k.deploy++
    }
    return k
  }

  // signals for the alert engine: one alert per version (the key carries the
  // version, a new release starts a new alert, the old one goes away by itself)
  function signals(now = Date.now()) {
    const out = []
    for (const c of components) {
      if (c.ignored || c.error) continue
      const base = { entity: c.id, env: c.env, hostId: c.host, host: c.where, link: `/updates?q=${encodeURIComponent(c.name)}`, parents: [], noRepeat: true }
      if (c.eol && (c.eol.passed || c.eol.soon)) {
        out.push({
          ...base, key: `eol:${c.id}`, rule: 'eol', title: `${c.name} ${c.eol.cycle}`,
          cond: true, severity: c.eol.passed ? 'warning' : 'info',
          detail: c.eol.passed
            ? `${c.eol.date ? tr('updates.eol.since', { date: new Date(c.eol.date).toLocaleDateString(localeTag()) }) : tr('updates.eol.passed')}${c.nextMajor ? tr('updates.eol.next', { version: c.nextMajor }) : ''}`
            : tr('updates.eol.on', { date: new Date(c.eol.date).toLocaleDateString(localeTag()) }),
        })
      } else if (c.eol) {
        // move to a still-supported cycle (PVE 8 → 9): resolved right away, with a notification
        out.push({ ...base, key: `eol:${c.id}`, rule: 'eol', cond: false })
      }
      if (c.security && outdated(c) && c.kind !== 'apt') {
        out.push({
          ...base, key: `security_release:${c.id}@${c.latest}`, rule: 'security_release', title: c.name,
          cond: true, severity: 'warning',
          detail: tr('updates.security', { current: c.current, latest: c.latest, cve: c.cve ? ` (${c.cve})` : '' }),
        })
      } else if (c.latest && c.gap === 'same') {
        // announced version installed: the alert for that version resolves
        out.push({ ...base, key: `security_release:${c.id}@${c.latest}`, rule: 'security_release', cond: false })
      }
    }
    return out
  }

  const label = c => `${c.name}${c.where ? ` (${c.where})` : ''}`

  // security fixes applied by unattended-upgrades in the last 24 h (agent
  // v7: applied and lastRunAt of the last run): one summary line, then one per host (5
  // packages at most). No host under automatic updates (whole fleet on v6): no line, digest unchanged
  function autoUpdateLines(now) {
    const hosts = []
    const stale = []
    let active = 0
    for (const h of agents?.hosts || []) {
      const st = agents.get(h.id)
      const slow = st?.slow
      if (!autoActive(slow)) continue
      // last slow report too old (agent unreachable, slow failing): silence does not
      // mean "no fix"
      if (st.slowAt == null || now - st.slowAt > SLOW_REPORT_MAX_AGE_MS) { stale.push(h.name); continue }
      active++
      const au = slow.autoUpdate
      const at = au.lastRunAt != null ? au.lastRunAt * 1000 : null
      if (at == null || at > now || now - at > 24 * 3600_000 || !au.applied.length) continue
      hosts.push({ name: h.name, applied: au.applied })
    }
    const staleLine = tr('updates.digest.stale', { count: stale.length, list: stale.join(', ') })
    if (!active) return stale.length ? [tr('updates.digest.auto_stale', { line: staleLine })] : []
    const n = hosts.reduce((k, h) => k + h.applied.length, 0)
    return [
      hosts.length
        ? tr('updates.digest.applied', { fixes: tr('updates.digest.fixes', { count: n }), hosts: tr('updates.digest.hosts', { count: hosts.length }) })
        : tr('updates.digest.none_applied', { hosts: tr('updates.digest.hosts', { count: active }) }),
      ...hosts.map(h => `  ${h.name} : ${h.applied.slice(0, 5).map(p => p.name).join(', ')}${h.applied.length > 5 ? ` (+${h.applied.length - 5})` : ''}`),
      ...(stale.length ? [`  ${staleLine}`] : []),
    ]
  }

  // services to restart (agent v8, slow report less than 2 h old): a headline, then one
  // indented line per host (3 units at most per host); none: nothing
  function restartLines(now) {
    const hosts = []
    for (const h of agents?.hosts || []) {
      const st = agents.get(h.id)
      const r = st?.slow?.version >= 8 ? st.slow.restart : null
      if (!r?.units.length || st.slowAt == null || now - st.slowAt > SLOW_REPORT_MAX_AGE_MS) continue
      hosts.push(`  ${h.name} : ${r.units.slice(0, 3).map(u => u.replace(/\.service$/, '')).join(', ')}${r.units.length > 3 ? ` +${r.units.length - 3}` : ''}`)
    }
    return hosts.length ? [tr('updates.digest.restart', { hosts: tr('updates.digest.hosts', { count: hosts.length }) }), ...hosts] : []
  }

  // digest section: new versions never announced, then end of life; fixes
  // applied by automatic updates
  function digestLines({ mark = false, now = Date.now() } = {}) {
    const rows = new Map(q.all.all().map(r => [r.id, r]))
    const fresh = components.filter(c => outdated(c) && c.latest && rows.get(c.id)?.notified_latest !== c.latest)
      .sort((a, b) => (GAP_RANK[a.security ? 'security' : a.gap] ?? 9) - (GAP_RANK[b.security ? 'security' : b.gap] ?? 9))
    const lines = []
    if (fresh.length) {
      // headline, then one indented line per version (the digest puts them in a quote)
      lines.push(tr('updates.digest.new', { count: fresh.length }))
      lines.push(...fresh.slice(0, 8).map(c => `  ${label(c)} ${c.gap === 'digest' ? tr('updates.digest.new_image', { current: c.current }) : `${c.current} → ${c.latest}`}${c.gap === 'major' ? ' ▲' : ''}${c.security ? ' 🛡' : ''}`))
      if (fresh.length > 8) lines.push(`  +${fresh.length - 8}`)
    }
    const eol = components.filter(c => !c.ignored && c.eol?.passed)
    if (eol.length) {
      lines.push(tr('updates.digest.eol', { count: eol.length }))
      lines.push(...eol.slice(0, 6).map(c => `  ${c.name} ${c.eol.cycle} (${c.where || '?'})`))
      if (eol.length > 6) lines.push(`  +${eol.length - 6}`)
    }
    if (mark) for (const c of fresh) q.notified.run(c.latest, c.id)
    lines.push(...autoUpdateLines(now))
    lines.push(...restartLines(now))
    return lines
  }

  return {
    start() {
      setTimeout(() => refresh().catch(e => log.error(`versions: ${e.message}`)), 45_000)
      setInterval(() => refresh().catch(e => log.error(`versions: ${e.message}`)), TICK_MS)
    },
    refresh,
    signals,
    digestLines,
    counts: (envFilter = 'all') => ({
      ...counts(components.filter(c => envFilter === 'all' || c.env === envFilter)),
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
    }),
    // active decision on a component (e.g. ignored apt packages: the security alert goes quiet)
    isIgnored: id => !!components.find(c => c.id === id)?.ignored,
    // pending security fixes under automatic updates, with their age: [{ name, version, since }]
    securityPending: host => pending.get(host),
    observePending,
    // reapplies the decisions (taken or lifted from the UI / the bot)
    redecide(now = Date.now()) {
      components = raw.map(c => decide(c, now))
    },
    view() {
      return {
        checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
        components: [...components].sort((a, b) => (GAP_RANK[rank(a)] ?? 9) - (GAP_RANK[rank(b)] ?? 9) || a.name.localeCompare(b.name)),
        counts: counts(components),
        sources: upstream.errors(),
        stats: upstream.stats(),
      }
    },
  }
}

// display rank: security / EOL first
function rank(c) {
  if (c.ignored) return 'same'
  if (c.eol?.passed || (c.security && c.gap !== 'same')) return 'security'
  return c.gap || 'unknown'
}

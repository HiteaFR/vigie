// Upstream version sources: GitHub and gitea.com releases, PyPI,
// nodejs.org, endoflife.date, Proxmox apt index, Docker registries.
//
// Everything goes through a persistent cache (http_cache table): a response is
// only requested again after maxAge, with If-None-Match / If-Modified-Since (an
// authenticated GitHub 304 does not use quota). On failure the last known
// value is kept and the error is reported per source.
import zlib from 'node:zlib'
import { fetch as uFetch } from 'undici'
import { agentFor } from '../tls.js'
import { USER_AGENT } from '../user-agent.js'
import { t as tx } from '../i18n.js'

const TIMEOUT = 15_000
const UA = USER_AGENT
const H = 3600_000

// truncated release notes: only the first lines are shown
const trimBody = s => String(s || '').replace(/\r/g, '').slice(0, 6000)

export function createUpstream({ store, env = process.env, fetch = uFetch, log = console }) {
  const { db } = store
  const q = {
    get: db.prepare('SELECT * FROM http_cache WHERE url = ?'),
    put: db.prepare(`INSERT INTO http_cache (url, etag, last_modified, body, fetched_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, body = excluded.body,
        fetched_at = excluded.fetched_at, checked_at = excluded.checked_at`),
    touch: db.prepare('UPDATE http_cache SET checked_at = ? WHERE url = ?'),
  }
  const errors = new Map() // source → { msg, at }
  const stats = { requests: 0, notModified: 0, github: 0 }
  const inflight = new Map()

  function fail(source, e) {
    const msg = String(e?.cause?.code || e?.message || e).slice(0, 200)
    errors.set(source, { msg, at: Date.now() })
    return msg
  }

  // agent from agentFor; secret declared by the caller, and any Authorization header
  // is one. Permissive only without a secret towards a literal private IPv4.
  async function request(url, { headers = {}, method = 'GET', secret = false } = {}) {
    stats.requests++
    const isSecret = secret || Object.keys(headers).some(k => k.toLowerCase() === 'authorization')
    return fetch(url, {
      method, headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(TIMEOUT), dispatcher: agentFor(url, { secret: isSecret }),
    })
  }

  // memoised value (free-form key): fn() is only called again after maxAge. A value
  // returned with store: false is served as is, without cache and without effect on the
  // source's errors (registry answer about a specific repository, not an outage)
  async function memo(key, maxAgeMs, source, fn) {
    const row = q.get.get(key)
    const now = Date.now()
    if (row && now - row.checked_at < maxAgeMs) return JSON.parse(row.body)
    if (inflight.has(key)) return inflight.get(key)
    const p = (async () => {
      try {
        const v = await fn(row)
        if (v === NOT_MODIFIED) {
          q.touch.run(Date.now(), key)
          return JSON.parse(row.body)
        }
        if (v.store === false) return v.value
        q.put.run(key, v.etag ?? null, v.lastModified ?? null, JSON.stringify(v.value), Date.now(), Date.now())
        errors.delete(source)
        return v.value
      } catch (e) {
        const msg = fail(source, e)
        if (row) return JSON.parse(row.body) // last known value
        throw new Error(msg)
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
    return p
  }

  // conditional GET: transform(response) → stored value (never the raw body)
  function conditional(url, { maxAgeMs, source, headers = {}, transform }) {
    return memo(url, maxAgeMs, source, async row => {
      const h = { ...headers }
      if (row?.etag) h['If-None-Match'] = row.etag
      if (row?.last_modified) h['If-Modified-Since'] = row.last_modified
      const r = await request(url, { headers: h })
      if (r.status === 304 && row) {
        stats.notModified++
        await r.body?.cancel()
        return NOT_MODIFIED
      }
      if (!r.ok) {
        await r.body?.cancel()
        const reset = r.headers.get('x-ratelimit-remaining') === '0' ? tx('errors.http.rate_limited') : ''
        throw new Error(`HTTP ${r.status}${reset}`)
      }
      return { value: await transform(r), etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified') }
    })
  }

  // --- forges ---
  const releaseOf = x => ({
    tag: x.tag_name, name: x.name || null, published: x.published_at || x.created_at || null,
    prerelease: !!x.prerelease, url: x.html_url || null, body: trimBody(x.body),
  })

  function github(repo) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
    return conditional(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      maxAgeMs: 6 * H, source: 'GitHub', headers,
      transform: async r => {
        stats.github++
        return (await r.json()).filter(x => !x.draft).map(releaseOf)
      },
    })
  }

  // repositories without GitHub releases: tags are enough (no notes)
  function githubTags(repo) {
    const headers = { Accept: 'application/vnd.github+json' }
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
    return conditional(`https://api.github.com/repos/${repo}/tags?per_page=50`, {
      maxAgeMs: 6 * H, source: 'GitHub', headers,
      transform: async r => (await r.json()).map(t => ({ tag: t.name, url: `https://github.com/${repo}/releases/tag/${t.name}` })),
    })
  }

  const giteaCom = repo => conditional(`https://gitea.com/api/v1/repos/${repo}/releases?limit=30`, {
    maxAgeMs: 6 * H, source: 'gitea.com',
    transform: async r => (await r.json()).filter(x => !x.draft).map(releaseOf),
  })

  const pypi = pkg => conditional(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
    maxAgeMs: 6 * H, source: 'PyPI',
    transform: async r => {
      const j = await r.json()
      return Object.entries(j.releases || {}).filter(([, files]) => files.length)
        .map(([v, files]) => ({ tag: v, published: files[0].upload_time_iso_8601 || null, url: `https://pypi.org/project/${pkg}/${v}/` }))
    },
  })

  const node = () => conditional('https://nodejs.org/dist/index.json', {
    maxAgeMs: 12 * H, source: 'nodejs.org',
    transform: async r => (await r.json()).map(x => ({ tag: x.version, published: x.date, lts: x.lts || false })),
  })

  const eol = product => conditional(`https://endoflife.date/api/${encodeURIComponent(product)}.json`, {
    maxAgeMs: 24 * H, source: 'endoflife.date',
    transform: async r => (await r.json()).map(c => ({
      cycle: String(c.cycle), eol: c.eol ?? null, support: c.support ?? null, latest: c.latest ?? null,
      releaseDate: c.releaseDate ?? null, codename: c.codename ?? null, link: c.link ?? null,
    })),
  })

  // latest published pve-manager for a Debian version (no-subscription repository)
  const pvePackages = codename => conditional(`http://download.proxmox.com/debian/pve/dists/${codename}/pve-no-subscription/binary-amd64/Packages.gz`, {
    maxAgeMs: 12 * H, source: 'download.proxmox.com',
    transform: async r => {
      const text = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')
      const out = {}
      for (const block of text.split('\n\n')) {
        const pkg = block.match(/^Package: (.+)$/m)?.[1]
        const ver = block.match(/^Version: (.+)$/m)?.[1]
        if (pkg === 'pve-manager' || pkg === 'proxmox-ve') (out[pkg] ||= []).push(ver)
      }
      return out
    },
  })

  // JSON from a local or public API (installed version of an app, Plex…)
  // secret: the call carries an auth header (installed version, Home Assistant) → never permissive
  function httpJson(url, { headers = {}, secret = false, maxAgeMs = 10 * 60_000 } = {}) {
    return memo(`json:${url}`, maxAgeMs, new URL(url).host, async () => {
      const r = await request(url, { headers, secret })
      if (!r.ok) {
        await r.body?.cancel()
        throw new Error(`HTTP ${r.status}`)
      }
      const text = await r.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        value = { __text: text.slice(0, 20_000) }
      }
      return { value }
    })
  }

  // --- Docker registries (API v2, anonymous token) ---
  const tokens = new Map()
  async function registryFetch(registry, pathname, { method = 'GET', accept } = {}) {
    const base = registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`
    const headers = accept ? { Accept: accept } : {}
    const scopeKey = `${registry}${pathname.split('/manifests/')[0].split('/tags/')[0]}`
    const tok = tokens.get(scopeKey)
    if (tok && tok.exp > Date.now()) headers.Authorization = `Bearer ${tok.token}`
    let r = await request(`${base}${pathname}`, { method, headers })
    if (r.status === 401) {
      await r.body?.cancel()
      const auth = r.headers.get('www-authenticate') || ''
      const realm = auth.match(/realm="([^"]+)"/)?.[1]
      if (!realm) throw new Error(tx('errors.registry.unknown_auth', { registry }))
      const p = new URLSearchParams()
      for (const k of ['service', 'scope']) {
        const v = auth.match(new RegExp(`${k}="([^"]+)"`))?.[1]
        if (v) p.set(k, v)
      }
      const tr = await request(`${realm}?${p}`)
      if (!tr.ok) throw new Error(tx('errors.registry.token', { registry, status: tr.status }))
      const tj = await tr.json()
      const token = tj.token || tj.access_token
      tokens.set(scopeKey, { token, exp: Date.now() + 240_000 })
      r = await request(`${base}${pathname}`, { method, headers: { ...headers, Authorization: `Bearer ${token}` } })
    }
    return r
  }

  const MANIFESTS = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
  ].join(', ')

  // tag digest on the registry side: a HEAD is not counted by Docker Hub
  const remoteDigest = ref => memo(`digest:${ref.registry}/${ref.repo}:${ref.tag}`, 6 * H, `registre ${ref.registry}`, async () => {
    const r = await registryFetch(ref.registry, `/v2/${ref.repo}/manifests/${encodeURIComponent(ref.tag)}`, { method: 'HEAD', accept: MANIFESTS })
    await r.body?.cancel()
    if (r.status === 404) return { value: { digest: null, missing: true } }
    // 401 despite the anonymous token = inaccessible repository (does not exist, or private).
    // Neither cache (a 401 freezes nothing for 6 h: requested again on the next tick), nor source
    // error; dockerComponents decides: image built locally, or an "HTTP 401" error.
    // Any other failure (5xx, 429, network, token refused) stays an error, unchanged
    if (r.status === 401) return { value: { digest: null, denied: true }, store: false }
    if (!r.ok) throw new Error(`${ref.registry} : HTTP ${r.status}`)
    return { value: { digest: r.headers.get('docker-content-digest') } }
  })

  // repository tags (to report a new minor / major of a fixed tag)
  const remoteTags = ref => memo(`tags:${ref.registry}/${ref.repo}`, 12 * H, `registre ${ref.registry}`, async () => {
    const tags = []
    if (ref.registry === 'docker.io') {
      let url = `https://hub.docker.com/v2/repositories/${ref.repo}/tags?page_size=100&ordering=last_updated`
      for (let i = 0; i < 3 && url; i++) {
        const r = await request(url)
        if (!r.ok) throw new Error(`Docker Hub : HTTP ${r.status}`)
        const j = await r.json()
        for (const t of j.results || []) tags.push({ tag: t.name, published: t.last_updated || null })
        url = j.next
      }
    } else {
      let pathname = `/v2/${ref.repo}/tags/list?n=1000`
      for (let i = 0; i < 5 && pathname; i++) {
        const r = await registryFetch(ref.registry, pathname)
        if (!r.ok) throw new Error(`${ref.registry} : HTTP ${r.status}`)
        const j = await r.json()
        for (const t of j.tags || []) tags.push({ tag: t, published: null })
        const next = r.headers.get('link')?.match(/<([^>]+)>/)?.[1]
        pathname = next ? (next.startsWith('http') ? new URL(next).pathname + new URL(next).search : next) : null
      }
    }
    return { value: tags }
  })

  return {
    github, githubTags, giteaCom, pypi, node, eol, pvePackages, httpJson, remoteDigest, remoteTags,
    errors: () => [...errors].map(([source, e]) => ({ source, ...e })),
    stats: () => ({ ...stats, githubAuth: !!env.GITHUB_TOKEN }),
    log,
  }
}

const NOT_MODIFIED = Symbol('304')

// does the reference name its registry ("ghcr.io/…", "docker.io/…",
// "localhost:5000/…")? Without an explicit registry, docker.io is implicit ("my-api",
// "postgres:16-alpine"): same rule as parseImageRef
export function explicitRegistry(image) {
  const parts = String(image || '').split('@')[0].split('/')
  return parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')
}

// "postgres:16-alpine", "ghcr.io/home-assistant/home-assistant:stable",
// "lscr.io/linuxserver/sonarr" → registry, repository, tag
export function parseImageRef(image) {
  let s = String(image || '').split('@')[0]
  if (!s) return null
  let tag = 'latest'
  const slash = s.lastIndexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) {
    tag = s.slice(colon + 1)
    s = s.slice(0, colon)
  }
  const parts = s.split('/')
  let registry = 'docker.io'
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) registry = parts.shift()
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io'
  // lscr.io is a mirror of ghcr.io (same repository, same digest)
  if (registry === 'lscr.io') registry = 'ghcr.io'
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library')
  return { registry, repo: parts.join('/'), tag }
}

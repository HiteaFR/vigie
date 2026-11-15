// Registries of version sources (lib/registry.js). Core entries below, in a fixed order
// (validation messages unchanged); a plugin adds some through definePlugin({ extensions:
// { latestSources, currentSources } }). No dependency on the updates engine: the tools come
// through the context (lib/updates/index.js).
//
// Latest version: { schema (from field), latest(src, ctx) → { latest, url?, … } (result of
//   ctx.releases or an equivalent object), label?(src) → displayed source (default: the name) }
//   ctx = { current, upstream, releases(list) → pick from a list of releases, as for
//   GitHub (tag pattern, pre-releases, same major, skipped versions) }
// Installed version: { schema (from field), current(src, ctx) → text }
//   ctx = { hostId, agents, upstream, secretHeaders(auth), pick(object, path) }
import { z } from 'zod'
import { envName, jsonPath } from '../config-types.js'
import { latestSources, currentSources } from '../registry.js'
import { t as tr } from '../i18n.js'

// --- latest version -------------------------------------------------------------------------------
latestSources.add('github', {
  schema: z.object({ from: z.literal('github'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), tagPattern: z.string().optional(), tags: z.boolean().optional() }).strict(),
  label: src => `github:${src.repo}`,
  async latest(src, { upstream, releases }) {
    let list = await upstream.github(src.repo)
    if (!list.length || src.tags) list = await upstream.githubTags(src.repo)
    return releases(list)
  },
})
// releases from gitea.com (public forge): unrelated to the gitea plugin (self-hosted instance)
latestSources.add('gitea', {
  schema: z.object({ from: z.literal('gitea'), repo: z.string(), tagPattern: z.string().optional() }).strict(),
  latest: async (src, { upstream, releases }) => releases(await upstream.giteaCom(src.repo)),
})
latestSources.add('pypi', {
  schema: z.object({ from: z.literal('pypi'), package: z.string(), tagPattern: z.string().optional() }).strict(),
  latest: async (src, { upstream, releases }) => releases(await upstream.pypi(src.package)),
})
latestSources.add('http-json', {
  schema: z.object({ from: z.literal('http-json'), url: z.string().url(), path: jsonPath, notes: z.string().url().optional() }).strict(),
  async latest(src, { upstream, pick }) {
    const j = await upstream.httpJson(src.url, { maxAgeMs: 6 * 3600_000 })
    const v = pick(j, src.path)
    if (v == null) throw new Error(tr('errors.version.latest_missing'))
    return { latest: String(v), url: src.notes ?? null }
  },
})

// --- installed version ----------------------------------------------------------------------------
currentSources.add('http-json', {
  schema: z.object({
    from: z.literal('http-json'), url: z.string().url(), path: jsonPath,
    auth: z.object({ type: z.literal('header'), name: z.string(), secretEnv: envName }).strict().optional(),
  }).strict(),
  async current(src, { upstream, secretHeaders, pick }) {
    const j = await upstream.httpJson(src.url, { headers: secretHeaders(src.auth), secret: !!src.auth })
    const v = pick(j, src.path)
    if (v == null) throw new Error(tr('errors.version.field_missing', { path: Array.isArray(src.path) ? src.path.join('.') : src.path }))
    return String(v)
  },
})
currentSources.add('http-regex', {
  schema: z.object({ from: z.literal('http-regex'), url: z.string().url(), regex: z.string() }).strict(),
  async current(src, { upstream }) {
    const j = await upstream.httpJson(src.url, { headers: {}, secret: false })
    const m = String(j.__text ?? JSON.stringify(j)).match(new RegExp(src.regex))
    if (!m) throw new Error(tr('errors.version.not_in_answer'))
    return m[1] ?? m[0]
  },
})
// whitelisted package or binary in dash-report (the service's host)
currentSources.add('agent', {
  schema: z.object({ from: z.literal('agent'), package: z.string() }).strict(),
  current(src, { hostId, agents }) {
    const st = agents?.get(hostId)
    if (!st) throw new Error(tr('errors.version.no_agent'))
    const v = st.slow?.versions?.[src.package]
    if (v == null) throw new Error(st.slow ? tr('errors.version.package_missing', { package: src.package }) : tr('errors.version.no_inventory'))
    return v
  },
})

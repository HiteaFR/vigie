// Example plugin. NOT in the active list (server/plugins/index.js): it documents the v0
// plugin interface (docs/plugins.md quotes it verbatim) and is loaded only by its tests, in a bench
// host. It watches the depth of a job queue exposed by some HTTP service:
//   - one collected source (example-queue), read every 60 s through ctx.http;
//   - one alert rule (example_queue) plus source_error for its own source;
//   - one digest line, one /api/summary key, one read route (/api/example, served from the last
//     collected value);
//   - extensions: a probe type, a widget auth and format, two version sources, service definitions;
//   - texts in two languages: locales/en.json and locales/fr.json, read with ctx.t.
import { z } from 'zod'
import { definePlugin, pluginLocales } from '../../lib/plugins/host.js'
import { envName } from '../../lib/config-types.js'
import { withUserAgent } from '../../lib/http.js'

const configSchema = z.object({
  url: z.string().url(),
  maxDepth: z.number().int().min(0).default(10),
}).strict()

export default definePlugin({
  id: 'example',
  apiVersion: 0,
  label: 'Example',
  configSchema,
  secrets: ['EXAMPLE_TOKEN'],
  // catalog next to the plugin: locales/<locale>.json, translated by ctx.t in the instance locale
  locales: pluginLocales(import.meta.url),
  setup(ctx) {
    const token = ctx.secret('EXAMPLE_TOKEN')
    const base = ctx.config.url.replace(/\/+$/, '')

    async function readQueue() {
      const r = await ctx.http(`${base}/api/queue`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      if (!r.ok) throw new Error(ctx.t('source.http', { status: r.status }))
      const { depth } = await r.json()
      if (!Number.isInteger(depth)) throw new Error(ctx.t('source.no_depth'))
      return { depth }
    }

    // last value read by the collector: the route serves it and never calls the service itself
    let last = null
    let lastAt = null

    return {
      collect: {
        'example-queue': {
          periodSec: 60,
          fn: async () => {
            last = await readQueue()
            lastAt = ctx.now()
            return last
          },
        },
      },

      rules: ['example_queue', 'source_error'],
      labels: { example_queue: ctx.tAll('label.queue') },
      signals(snap) {
        const s = snap['example-queue']
        return [
          {
            key: 'source_error:example-queue', rule: 'source_error', entity: 'example-queue',
            title: ctx.t('source.title'), env: 'prod', cond: s ? !!s.error : null, forSec: 600,
            severity: 'warning', detail: s?.error ?? null, link: '/example', parents: [],
          },
          {
            key: 'example_queue:main', rule: 'example_queue', entity: 'main', title: ctx.t('queue.title'),
            env: 'prod', cond: s?.data && !s.error ? s.data.depth > ctx.config.maxDepth : null, forSec: 300,
            severity: 'warning', detail: s?.data ? ctx.t('queue.detail', { count: s.data.depth }) : null, link: '/example', parents: [],
          },
        ]
      },

      digest: {
        slot: 'end',
        lines: ({ snap }) => [ctx.t('digest.line', { depth: snap['example-queue']?.data?.depth ?? ctx.t('digest.unknown') })],
      },

      summary: {
        key: 'example',
        value: ({ snap }) => ({ depth: snap['example-queue']?.data?.depth ?? null, max: ctx.config.maxDepth }),
      },

      // served from the last collected value: a request (anonymous read included) never triggers
      // an outgoing call
      routes(router, { wrap }) {
        router.get('/api/example', wrap(async (req, res) => res.json({ depth: last?.depth ?? null, max: ctx.config.maxDepth, at: lastAt })))
      },
    }
  },

  // Extensions are static: they are registered before config.json is read, so a check, widget or
  // version source of this plugin can be used in config.json.
  extensions: {
    probes: {
      'example-health': {
        fields: { url: z.string().url() },
        intervalSec: 120,
        async run(check, { timeoutMs, now }) {
          const started = now()
          const r = await fetch(check.url, { headers: withUserAgent(), signal: AbortSignal.timeout(timeoutMs) })
          const body = await r.json().catch(() => ({}))
          return body.status === 'ok'
            ? { state: 'ok', latencyMs: now() - started, code: r.status }
            : { state: 'crit', latencyMs: now() - started, code: r.status, error: `status: ${body.status ?? 'missing'}` }
        },
        describe: check => ({ label: check.label || 'health', display: check.url }),
      },
    },
    widgetAuths: {
      'example-key': {
        fields: { secretEnv: envName },
        headers: (auth, { secret }) => ({ 'X-Example-Key': secret(auth.secretEnv) }),
      },
    },
    widgetFormats: {
      'example-mb': { numeric: true, format: v => `${(Number(v) / 1e6).toFixed(1)} MB` },
    },
    latestSources: {
      'example-feed': {
        fields: { url: z.string().url() },
        latest: async (src, { upstream, releases }) => releases(await upstream.httpJson(src.url)),
      },
    },
    currentSources: {
      'example-version': {
        fields: { url: z.string().url() },
        async current(src, { upstream }) {
          const j = await upstream.httpJson(src.url)
          if (!j.version) throw new Error('no version in the answer')
          return String(j.version)
        },
      },
    },
    serviceDefs: {
      attribution: 'Example plugin',
      defs: [{ id: 'example-app', name: 'Example app', category: 'dev', match: { allOf: [{ port: 7070 }, { http: { port: 7070, path: '/health', contains: 'example' } }] } }],
    },
  },
})

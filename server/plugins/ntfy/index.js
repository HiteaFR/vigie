// ntfy, a second notification channel (plugin). Immediate notifications go to ntfy in addition
// to Telegram, with the same policy (quiet hours, digest, grouping, retries:
// lib/notify/notifier.js); only the rendering is specific to ntfy: plain text, title (first
// line), priority from the severity, tags.
//
// Config: plugins.ntfy { url (server, e.g. https://ntfy.example.net), topic, priorities
// { critical, warning, info, other } (1 to 5; other: digest, acknowledgements, tests),
// minSeverity (info, warning, critical: nothing below), untyped (digest, acknowledgements and
// tests, without a severity: sent or not) }. Secret: NTFY_TOKEN (access token, optional), sent
// as Authorization: Bearer; ctx.http then enforces the strict agent (secret). Without a
// plugins.ntfy block: plugin not configured, no channel, nothing is sent.
// Published as JSON on the server root (topic in the body): titles and emojis need no header
// encoding.
import { z } from 'zod'
import { definePlugin, pluginLocales } from '../../lib/plugins/host.js'

const prio = z.number().int().min(1).max(5)
const configSchema = z.object({
  url: z.string().url().refine(s => /^https?:\/\//.test(s), 'http(s)://'),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'topic: letters, digits, - and _ (64 at most)'),
  priorities: z.object({ critical: prio.default(5), warning: prio.default(4), info: prio.default(3), other: prio.default(3) }).strict().prefault({}),
  minSeverity: z.enum(['info', 'warning', 'critical']).default('info'),
  untyped: z.boolean().default(true),
}).strict()

const RANK = { info: 0, warning: 1, critical: 2 }
const TAGS = { critical: 'rotating_light', warning: 'warning', info: 'information_source' }
export const NTFY_TIMEOUT_MS = 10_000

export default definePlugin({
  id: 'ntfy', apiVersion: 0, label: 'ntfy',
  configSchema,
  secrets: ['NTFY_TOKEN'],
  locales: pluginLocales(import.meta.url),
  setup(ctx) {
    const cfg = ctx.config
    const token = ctx.secret('NTFY_TOKEN')
    const endpoint = `${cfg.url.replace(/\/+$/, '')}/`
    return {
      channel: {
        label: 'ntfy',
        maxBatch: 12,
        maxLen: 3800,
        accepts: r => (r.severity == null ? cfg.untyped : (RANK[r.severity] ?? 0) >= RANK[cfg.minSeverity]),
        async send(list) {
          const message = list.map(r => r.plain).join('\n\n').slice(0, 4000)
          const first = list[0].plain.split('\n')[0]
          const title = (list.length > 1 ? `${first} (+${list.length - 1})` : first).slice(0, 250)
          const priority = Math.max(...list.map(r => cfg.priorities[r.severity] ?? cfg.priorities.other))
          const tags = [...new Set(list.map(r => TAGS[r.severity]).filter(Boolean))]
          const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
          let r
          try {
            r = await ctx.http(endpoint, { method: 'POST', headers, body: JSON.stringify({ topic: cfg.topic, title, message, priority, tags }), timeoutMs: NTFY_TIMEOUT_MS })
          } catch (e) {
            // neither URL nor token in the message
            throw new Error(ctx.t('error', { why: e?.name === 'TimeoutError' ? ctx.t('error.timeout') : e?.cause?.code || ctx.t('error.network') }))
          }
          await r.body?.cancel?.().catch(() => {})
          if (r.ok) return
          const err = new Error(`ntfy ${r.status}`)
          // 429: wait; 4xx (token refused, forbidden topic, message too large): retrying is pointless
          if (r.status === 429) err.retryAfter = Number(r.headers.get('retry-after')) || 60
          else if (r.status >= 400 && r.status < 500 && r.status !== 408) err.permanent = true
          throw err
        },
      },
    }
  },
})

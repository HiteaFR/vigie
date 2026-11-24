# Writing a plugin

Vigie has a small plugin interface. The built-in Gitea integration and the ntfy notification
channel are plugins; the network module and the version page are core modules that go through
the same host (Proxmox, the probes and the agents stay in the core itself).

This guide covers interface **v0**. Read the [stability](#stability-and-security) section before
you start: v0 is internal and unstable.

All code below is quoted verbatim from the example plugin (`server/plugins/example/`,
`client/src/plugins/example/`) or from the ntfy plugin, and a test checks that it still is.
The example is a complete plugin, covered by tests, but it is not in the active list: it is never
loaded in production.

## Contents

- [What a plugin is](#what-a-plugin-is)
- [Server side](#server-side)
  - [definePlugin](#defineplugin)
  - [Configuration](#configuration)
  - [The ctx object](#the-ctx-object)
  - [Hooks](#hooks)
  - [Extensions](#extensions)
  - [Notification channels](#notification-channels)
  - [Translations](#translations)
- [Client side](#client-side)
- [Rules](#rules)
- [Isolation](#isolation)
- [Error masking](#error-masking)
- [Registering a plugin](#registering-a-plugin)
- [Testing](#testing)
- [Stability and security](#stability-and-security)

## What a plugin is

A plugin is a directory in the repository, with a server part and, if it needs one, a client
part:

```
server/plugins/<id>/index.js        definePlugin({ id, apiVersion: 0, configSchema, setup(ctx), extensions })
client/src/plugins/<id>/index.jsx   routes and cockpit tiles
client/src/plugins/<id>/nav.js      navigation entries
client/src/plugins/<id>/meta.js     rule labels and data sources (no component)
```

Plugins are listed statically (`server/plugins/index.js`, `client/src/plugins/index.jsx`,
`nav.js`, `meta.js`) and built with Vigie. **There is no external loading in v0**: no plugin
directory scanned at startup, no npm package, no remote script. A plugin is a pull request.

## Server side

### definePlugin

```js
import { z } from 'zod'
import { definePlugin, pluginLocales } from '../../lib/plugins/host.js'
import { envName } from '../../lib/config-types.js'
import { withUserAgent } from '../../lib/http.js'
```

```js
export default definePlugin({
  id: 'example',
  apiVersion: 0,
  label: 'Example',
  configSchema,
  secrets: ['EXAMPLE_TOKEN'],
  // catalog next to the plugin: locales/<locale>.json, translated by ctx.t in the instance locale
  locales: pluginLocales(import.meta.url),
  setup(ctx) {
```

- `id`: lowercase letters, digits and `-`, 32 characters at most. It names the configuration
  block (`plugins.<id>`), the error alert (`plugin_error:<id>`) and the key-value namespace. Some
  ids are reserved for the core and refused at load time: `cluster`, `backups`, `nodes`, `disks`,
  `updates`, `network`, `proxmox`.
- `apiVersion`: must be `0`; any other value is refused with a clear message.
- `label`: shown on the Integrations page and in alert titles.
- `configSchema`: a zod schema for `plugins.<id>` (see below).
- `secrets`: the environment variables the plugin may read through `ctx.secret`. Nothing else.
- `locales` (optional): the plugin's catalog, one object per locale (`en`, `fr`); see
  [Translations](#translations).
- `configured(parsed, env)` (optional): decides whether the plugin runs. By default it runs when
  its configuration block is present. Without it, `setup` is never called and nothing is read.
- `setup(ctx)`: returns the hooks. It must not do network calls; work happens in hooks.
- `extensions` (optional): static declarations (probe types, widget auths and formats, version
  sources, service definitions), registered **before** `config.json` is read.
- `configKeys` (optional): extra accepted configuration keys, for a transition (the Gitea plugin
  still accepts its old top-level `gitea` block, with a warning).

### Configuration

The block `plugins.<id>` of `config.json` is validated by `configSchema` at startup and by
`npm run check-config` (from `server/`). An invalid block stops the server with the zod messages.
Vigie uses zod 4: for an object field with a default whose own fields have defaults, write
`.prefault({})` (the default goes through the schema); `.default({})` returns `{}` as is.

```js
const configSchema = z.object({
  url: z.string().url(),
  maxDepth: z.number().int().min(0).default(10),
}).strict()
```

```json
{ "plugins": { "example": { "url": "http://192.0.2.10:8080", "maxDepth": 20 } } }
```

Secrets never go in `config.json`: declare them in `secrets` and read them with `ctx.secret`.

### The ctx object

`setup(ctx)` receives a frozen object:

| Field | Meaning |
| --- | --- |
| `ctx.id` | the plugin id |
| `ctx.config` | the parsed configuration block (defaults applied), `undefined` without block |
| `ctx.configKey` | the key it was read from (`plugins.<id>`, or a `configKeys` entry) |
| `ctx.now()` | current time in ms (use it rather than `Date.now()`: tests inject a clock) |
| `ctx.http(url, options)` | `fetch` with the `vigie/<version>` User-Agent and a bounded timeout (`timeoutMs`, 0.1 to 30 s); the TLS agent is strict as soon as the request carries a secret (an `Authorization` or `Cookie` header, or `secret: true`) |
| `ctx.kv.get(key)`, `ctx.kv.set(key, value)` | small persistent strings, namespaced `plugin.<id>.*` (null without a store) |
| `ctx.secret(name)` | an environment variable listed in `secrets`, otherwise `null` |
| `ctx.log.log`, `.warn`, `.error` | the server log, prefixed with `[<id>]` |
| `ctx.t(key, params)` | a text of the plugin's catalog in the instance locale (fallback: `en`, then the key) |
| `ctx.tAll(key)` | the same text in every locale of the catalog, `{ en, fr }` (for `labels`) |

```js
    const token = ctx.secret('EXAMPLE_TOKEN')
    const base = ctx.config.url.replace(/\/+$/, '')

    async function readQueue() {
      const r = await ctx.http(`${base}/api/queue`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      if (!r.ok) throw new Error(ctx.t('source.http', { status: r.status }))
      const { depth } = await r.json()
      if (!Number.isInteger(depth)) throw new Error(ctx.t('source.no_depth'))
      return { depth }
    }
```

### Hooks

`setup` returns an object; every hook is optional. Unknown hooks are refused.

| Hook | Called | Contract |
| --- | --- | --- |
| `collect` | by the shared collector, each source at its period | `{ <source>: { periodSec (≥ 10), fn, configured?, timeoutSec? } }` (`timeoutSec` defaults to `min(periodSec, 60)`); the result is in `snap[<source>]` as `{ data, at, error }` |
| `rules` | at load time | rule types this plugin emits; required with `signals` |
| `signals(snap, now, helpers)` | every evaluation (15 s) | alert signals (see [Rules](#rules)) |
| `signalsAt` | — | `'end'` (default) or `'ci'`: where the signals go among the core ones |
| `labels` | at load time | `{ <rule>: <label> \| { en, fr } }` for Telegram and the bot; an object is read in the instance locale |
| `digest` | when the daily digest is built | `{ slot: 'end' \| 'ci', lines({ snap, mark, now }) → string[] }` (plain text, escaped by the host; in the `end` slot, the lines of a module form their own section and indented lines go into a quote under the line above, folded beyond 3) |
| `summary` | `/api/summary` | `{ key, value({ snap, env, now }) }`; must return a value, not a promise |
| `routes(router, helpers)` | at startup | an `express.Router` mounted by the host; wrap handlers with `helpers.wrap` |
| `routesAt` | — | `'modules'` (default) or `'sources'` (with the source read routes; only `wrap` is given) |
| `components()` | version page | items of the updates page (same shape as the core ones) |
| `status()` | Integrations page | `{ configured }`: a running plugin can say it is not configured |
| `invalidate()` | before a manual refresh | clear caches |
| `start()` | after startup | start timers; a rejected promise disables the plugin |
| `refresh()` | manual refresh | run the plugin's own refresh (sources are re-read by the collector) |
| `afterRefresh()` | after a manual refresh | follow-up work once every source is re-read |
| `purge()` | nightly | housekeeping |
| `stop()` | shutdown | release resources (2 s at most for everything) |
| `channel` | notifier | a notification channel (see [Notification channels](#notification-channels)) |

A collected source, which also keeps the last value it read (for the route, below):

```js
    // last value read by the collector: the route serves it and never calls the service itself
    let last = null
    let lastAt = null
```

```js
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
```

A collection error is **data**, not a plugin failure: it is stored in `snap[<source>].error`
(previous data kept), and the plugin's rules decide what to do with it, here a `source_error`:

```js
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
```

A digest line, a summary key and a read route:

```js
      digest: {
        slot: 'end',
        lines: ({ snap }) => [ctx.t('digest.line', { depth: snap['example-queue']?.data?.depth ?? ctx.t('digest.unknown') })],
      },
```

```js
      summary: {
        key: 'example',
        value: ({ snap }) => ({ depth: snap['example-queue']?.data?.depth ?? null, max: ctx.config.maxDepth }),
      },
```

```js
      // served from the last collected value: a request (anonymous read included) never triggers
      // an outgoing call
      routes(router, { wrap }) {
        router.get('/api/example', wrap(async (req, res) => res.json({ depth: last?.depth ?? null, max: ctx.config.maxDepth, at: lastAt })))
      },
```

**Rule for plugin routes: serve what the collector already read.** A route must never call the
remote service on each request: with anonymous read enabled (`security.anonymousRead`), anyone on
the network could make Vigie send outgoing requests at will. Keep the last collected value (or a
cache with a lifetime, like the Gitea plugin) and answer from it.

### Extensions

Extensions are declared on the definition (`extensions`), not in `setup`, because the
configuration is validated against them: a probe type of a plugin must be known when
`config.json` is read. They are registered all or nothing per plugin; a name already taken (by
the core or another plugin) refuses all of them, with `plugin_error:<id>`.

**Probe types** (`services[].checks[]`). `fields` is a zod shape; the host adds `type`, `label` and
`interval`. `run(check, { timeoutMs, now })` returns `{ state: 'ok' | 'warn' | 'crit', latencyMs?,
code?, error? }`; measure time with the `now` it receives, never `Date.now()` (tests inject a
clock):

```js
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
    widgetAuths
```

**Widget authentications and formats** (`services[].widget`). An auth gives `headers` and/or
`query`; `secret(name)` reads the environment. A format gives `numeric` (non-numeric values show
`—`) and `format`:

```js
    widgetAuths: {
      'example-key': {
        fields: { secretEnv: envName },
        headers: (auth, { secret }) => ({ 'X-Example-Key': secret(auth.secretEnv) }),
      },
    },
    widgetFormats: {
      'example-mb': { numeric: true, format: v => `${(Number(v) / 1e6).toFixed(1)} MB` },
    },
    latestSources
```

**Version sources** (`services[].version`). `latest` receives `{ current, upstream, releases, pick }`;
`releases(list)` picks from a list of releases as for GitHub (tag pattern, pre-releases, same
major). `current` receives `{ hostId, agents, upstream, secretHeaders, pick }`:

```js
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
    serviceDefs
```

**Service definitions** for the network probe, in the format of the shipped file (see "Additional
service definitions" in [docs/network.md](network.md#additional-service-definitions)):

```js
    serviceDefs: {
      attribution: 'Example plugin',
      defs: [{ id: 'example-app', name: 'Example app', category: 'dev', match: { allOf: [{ port: 7070 }, { http: { port: 7070, path: '/health', contains: 'example' } }] } }],
    },
  },
```

### Notification channels

A `channel` hook makes the plugin a notification channel next to Telegram. The notifier keeps the
policy (what and when: immediate or digest, quiet hours, 15 s grouping, expiry, retries) and the
queue; the channel only renders and sends. Each channel has its own delivery state: a failing
channel blocks neither Telegram nor the others. From the ntfy plugin:

```js
      channel: {
        label: 'ntfy',
        maxBatch: 12,
        maxLen: 3800,
        accepts: r => (r.severity == null ? cfg.untyped : (RANK[r.severity] ?? 0) >= RANK[cfg.minSeverity]),
        async send(list) {
```

`send(list)` receives queue items `{ id, key, kind, severity, silent, text, plain, incidentId,
createdAt }` (`text` is Telegram HTML, `plain` the same as plain text). Throw to report a failure;
mark it permanent (not retried) or give a `retryAfter` in seconds (capped at 15 min):

```js
          const err = new Error(`ntfy ${r.status}`)
          // 429: wait; 4xx (token refused, forbidden topic, message too large): retrying is pointless
          if (r.status === 429) err.retryAfter = Number(r.headers.get('retry-after')) || 60
          else if (r.status >= 400 && r.status < 500 && r.status !== 408) err.permanent = true
          throw err
```

A channel only receives what is created after it first runs; `accepts(item)` filters (filtered
items are recorded as such). The channel state is in `notifier.channels` of `/api/alerts`, and a
channel that keeps failing raises `channel_error:<id>`.

### Translations

Every text a person reads (alert titles and details, rule labels, digest lines, errors shown in
the interface) goes through the plugin's own catalog. The catalog lives next to the plugin,
one JSON file per locale, and `pluginLocales(import.meta.url)` reads it (see `locales` in
[definePlugin](#defineplugin)):

```json
{
 "digest.line": "🧪 Example queue: {depth}",
 "digest.unknown": "unknown",
 "label.queue": "Queue too long",
 "queue.detail": {
  "one": "{count} job waiting",
  "other": "{count} jobs waiting"
 },
 "queue.title": "Example queue",
 "source.http": "queue: HTTP {status}",
 "source.no_depth": "queue: no depth in the answer",
 "source.title": "Example queue unreadable"
}
```

```json
{
 "digest.line": "🧪 File d'exemple : {depth}",
 "digest.unknown": "inconnue",
 "label.queue": "File trop longue",
 "queue.detail": {
  "one": "{count} tâche en attente",
  "other": "{count} tâches en attente"
 },
 "queue.title": "File d'exemple",
 "source.http": "file : HTTP {status}",
 "source.no_depth": "file : aucune profondeur dans la réponse",
 "source.title": "File d'exemple illisible"
}
```

- `ctx.t(key, params)` renders a text in the locale of the instance (`locale` in `config.json`);
  `{name}` is replaced by `params.name`.
- A plural entry is `{ "one": …, "other": … }` and is chosen from `params.count` with the rules
  of the locale (in French, 0 and 1 are singular).
- `ctx.tAll(key)` gives `{ en, fr }` for the `labels` hook, as in the signals excerpt above.
- Keep the same keys and the same `{params}` in every locale. Under `node --test`, a missing key
  throws, so a test catches it.
- Logs are not translated: they stay in English.

## Client side

The client part is registered statically too: `client/src/plugins/index.jsx` (routes and
tiles), `nav.js` (navigation) and `meta.js` (labels and sources). `meta.js` must stay free of
components and icons: it is read by `lib/alerts.js` and `api.js`.

```js
import { registerCatalog } from '../../i18n/index.js'
import fr from './locales/fr.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

registerCatalog('example', { fr, en })

export default {
  id: 'example',
  labels: { example_queue: { label: { en: 'Queue too long', fr: 'File trop longue' }, order: 1000 } },
  sources: {
    example: { url: '/api/example', period: 60_000 },
  },
}
```

`labels` give the rule labels shown in the alert pages, as a string or `{ en, fr }` read in the
instance locale; `order` places them among the core ones (10, 20, 30… in file order). `sources` become available to `useSource(name)` once the plugin is
listed in `plugins/meta.js`. `meta.js` also registers the plugin's client catalog (see
[Client translations](#client-translations)).

```js
import { ListOrdered } from 'lucide-react'
import { t } from '../../i18n/index.js'

export default [
  { path: '/example', get label() { return t('example.nav.label') }, icon: ListOrdered, order: 85, mobile: false },
]
```

Navigation entries are sorted by `order` with the core views. `mobile: false` keeps an entry out
of the mobile bar, which holds 8 entries at most; `placement: 'bottom'` puts it at the bottom of
the sidebar.

```jsx
import { lazy } from 'react'
import { ExampleKpi } from './tiles.jsx'

const ExampleView = lazy(() => import('./ExampleView.jsx'))

export default {
  id: 'example',
  routes: [{ path: '/example', component: ExampleView }],
  tiles: {
    kpi: [{ order: 90, component: ExampleKpi }],
  },
}
```

Views are lazy chunks of the same build. Tile slots are `kpi` (the indicator row) and `cards`
(the card row); a `kpi` tile receives `{ s, env, mural }`, `s` being `/api/summary`:

```jsx
export function ExampleKpi({ s, env, mural }) {
  const e = s.example
  return (
    <Kpi mural={mural} icon={ListOrdered} label={t('example.tile.label')} value={e?.depth ?? '—'}
      sub={e?.depth == null ? t('example.tile.unknown') : t('example.tile.max', { max: e.max })}
      state={e?.depth == null ? 'unknown' : e.depth > e.max ? 'warn' : 'ok'} href={withEnv('/example', env)} />
  )
}
```

```jsx
export default function ExampleView() {
  const q = useJson('/api/example', 60_000)
  const over = q.data && q.data.depth > q.data.max
  return (
    <Panel icon={ListOrdered} title={t('example.view.title')} query={q}>
      {q.data && q.data.depth != null && (
        <div className={`${card} p-4 text-sm`}>
          <span className={over ? 'text-warn font-semibold' : 'text-fg'}>{q.data.depth}</span> {t('example.view.waiting', { count: q.data.depth, max: q.data.max })}
        </div>
      )}
    </Panel>
  )
}
```

### Client translations

The client has its own catalog, separate from the server's: every text of a plugin's views,
tiles and navigation goes through it. Put one JSON file per locale in `locales/` next to the
plugin's client files, with the same keys and the same `{params}` in each:

```json
{
 "nav.label": "Example",
 "tile.label": "Queue",
 "tile.max": "alert above {max}",
 "tile.unknown": "unknown",
 "view.title": "Example queue",
 "view.waiting": {
  "one": "job waiting (alert above {max})",
  "other": "jobs waiting (alert above {max})"
 }
}
```

- `registerCatalog(id, { fr, en })` (from `client/src/i18n/index.js`) adds the catalog under the
  plugin id: the key `view.title` is read as `t('example.view.title')`. Call it once, in
  `meta.js`, which the core imports first (`plugins/meta.js`): the catalog is then known before
  any view of the plugin renders, for the locales already loaded and for those loaded later.
- `t(key, params)` renders a text in the instance locale (`locale` in `config.json`, loaded before
  the first render); a missing key falls back to English, then to the key itself. A plural entry
  `{ "one": …, "other": … }` is chosen from `params.count`, as on the server.
- Never call `t()` when a module loads: the locale is not known yet. A text needed in a constant
  (a navigation label) is a getter, as in `nav.js` above; rule labels in `meta.js` stay
  `{ en, fr }` objects.
- `npm test` checks that no text is hard-coded in `client/src`, that every key called exists in
  `fr` and `en`, that both catalogs of a plugin have the same keys, and that its `meta.js`
  registers them.

Structure rules, checked by `npm test`: the core reaches a plugin only through the registries;
`lib/` and `ui/` read only `plugins/meta.js`; a plugin does not import another plugin; `import()`
takes a literal string.

## Rules

A signal is an object:

```
{ key, rule, entity, title, env, cond, forSec?, severity, detail?, link?, parents, hostId?, host? }
```

`cond` is `true` (firing after `forSec`), `false` (resolved) or `null` (unknown: no change).

- **Key ownership.** Every signal must be of a rule type the plugin declares in `rules`, with a key
  `<rule>:…`. A rule type of the core (`CORE_RULES` in `server/lib/alerts/rules.js`, and the types
  of the core modules) cannot be declared. A key already emitted in the same evaluation, by the
  core or another module, is refused. A refused signal is dropped and `plugin_error:<id>` is
  raised.
- **`source_error`** is shared, but limited: a plugin may emit `source_error:<id>`,
  `source_error:<id>/…` or `source_error:<one of its collected sources>`.
- **`plugin_error`** is reserved to the host: one per module, raised (after 60 s) while a hook is
  failing, with the hook and a short masked message.
- **`channel_error`** is a core rule: one per configured channel, raised while it keeps failing
  (10 min); it goes to every channel, and the failing one gets it when it is back.

## Isolation

The host isolates each module:

- `signals` that throws: its last signals are **frozen** (`cond: null`: neither fired nor
  resolved, an alert is never forgotten silently), `plugin_error` is raised, the other modules and
  the evaluation go on (so does the heartbeat).
- `digest` or `summary` that throws: a "⚠️ … : unavailable" line takes its place, its summary key
  is `null`.
- `setup`, `start` or `routes` that throws: the plugin is disabled, the rest starts.
- A collected source that never answers: it fails after its `timeoutSec` (default
  `min(periodSec, 60)` s) and the error is data.
- Extensions: a probe that hangs is `crit` after its timeout + 1 s, like a core probe; a probe that
  throws is `unknown`, then a failure after `alerts.failAfter` passes in a row; a widget auth is
  bounded at 8 s and a version source at 30 s, their errors being data of the widget or the
  component; a channel send is bounded at 30 s.

**Limit:** a synchronous infinite loop in a hook blocks the whole process. There is no isolation
inside one Node process. Plugins are internal and reviewed: this is accepted for v0.

## Error masking

Every error message that leaves the process (Integrations page, `plugin_error` detail and so the
alerts, digest and Telegram, the log, widget and version errors, channel errors) goes through
`server/lib/redact.js` first: the values of the secrets the plugin declared (case-insensitive),
URL credentials (`//user:password@`), query values, `Authorization` and `Bearer`/`Basic`/`Token`
values, `password=`-like pairs, JWTs, base64 and long letter-and-digit tokens. Messages are then
cut to 200 characters. Still, do not put secrets in error messages: masking is a safety net.

## Registering a plugin

Add it to the static lists:

```diff
--- a/server/plugins/index.js
+++ b/server/plugins/index.js
 import ntfy from './ntfy/index.js'
+import example from './example/index.js'
```

```diff
--- a/client/src/plugins/index.jsx
+++ b/client/src/plugins/index.jsx
 import gitea from './gitea/index.jsx'
+import example from './example/index.jsx'
```

and put it in the exported arrays (`PLUGINS`, `CLIENT_PLUGINS`, and likewise in `nav.js` and
`meta.js`). Then add its block to `config.json` and its secrets to the environment file.

## Testing

Load the plugin in a bench host, against a local fake service; never against a real one. The
example's tests (`server/test/example-plugin.test.js`) show how: `createHost({ cfg, env, plugins })`,
then `host.collectors()`, `host.signals(snap, now)`, `host.digestLines(slot, opts)`,
`host.summaries(opts)`, `host.mount(app, helpers)`, and `registerExtensions([plugin])` for the
extensions. The client part renders with `server/test/client-render.js`.

## Stability and security

- **Unstable.** `apiVersion` stays at `0` until three real plugins have validated the interface;
  hooks, ctx and extensions may change. A stable interface comes after the publication.
- **No external loading in v0.** Plugins are part of the build and reviewed like any code.
- **No sandbox.** A plugin has every right of the server process (files, network, database). The
  host isolates failures, not malice.

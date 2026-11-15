# Development

How Vigie is built, how the client code is organized, and how to run it from a copy of the
repository. To install an instance, see [Installation](installation.md) or [Docker](docker.md).
To write a plugin, see the [plugin guide](plugins.md). The views are described in
[Views, history and widgets](features.md).

## Architecture

```
browser ──HTTP──▶ Node/Express (:8088)
                    ├─ /api/services ─▶ probe snapshot (no outbound call)
                    │                    ▲ scheduler: HTTP / TCP / TLS / DNS probes in the background
                    ├─ /api/cluster  ─▶ Proxmox API, one per cluster (PVEAuditor tokens, read-only)
                    ├─ /api/backups  ─▶ vzdump: storage content or task logs (per cluster),
                    │                    /cluster/backup schedule, 7-day matrix, orphans
                    ├─ /api/proxmox  ─▶ nodes, disks and SMART, failed tasks, PVE notifications
                    ├─ /api/agents   ─▶ dash-report reports (SSH forced command, read-only)
                    ├─ /api/gitea    ─▶ Gitea API (read token; Gitea plugin)
                    ├─ /api/runners  ─▶ Gitea admin API (read:admin token; Gitea plugin)
                    ├─ /api/network  ─▶ network module
                    ├─ /api/summary  ─▶ cockpit KPIs (?env=prod|dev), weather
                    ├─ /api/history/…─▶ uptime bands, per-service series (SQLite)
                    ├─ /api/rrd/…    ─▶ charts of a node or a guest (Proxmox rrddata)
                    ├─ /api/alerts   ─▶ active alerts, 7-day incidents, channel state
                    ├─ /api/updates  ─▶ versions and updates (SQLite cache of upstream sources)
                    ├─ /api/plugins  ─▶ modules and plugins: state, last error (Integrations page)
                    ├─ /api/healthz  ─▶ process liveness (CI, Docker healthcheck)
                    └─ /             ─▶ client/dist (React SPA, path-based routing)
alert engine (15 s) ─▶ SQLite (state directory) ─▶ send queue ─▶ api.telegram.org
```

The stack: React 19, Vite and Tailwind v4 for the client; Node and Express for the server. The
server holds the tokens (Proxmox, Gitea and others), exposes `/api/*` and serves the SPA.

Secrets never leave the server. Probes run in the background: every 60 s by default, every 6 h for
certificates, at most 8 at a time, with a second attempt before a failure is declared. The other
sources keep an in-memory cache with a TTL (cluster 5 s, Gitea 60 s), so upstream APIs are not
hammered.

## Client structure

`client/src` (React, Vite, Tailwind). This section is the reference for that structure.

- `views/`: one view per route (`Cockpit`, `Services`, `Infra`, `Network`, `Updates`, `Backups`,
  `Alerts`, `Integrations` and `Mural`). Every view except the Cockpit is loaded on demand
  (`React.lazy` in `App.jsx`, one chunk per view, fallback `ui/ViewFallback.jsx`). The CI view
  belongs to the Gitea plugin (`plugins/gitea/Ci.jsx`).
- `components/`: interface blocks shared by several views (`CompactTile`, `GapBadge`, `InfraGrid`,
  `BackupsGrid`, `NetworkSuggestions`…).
- `ui/`: generic building blocks with no business logic (`Panel`, `Section`, `Status`, `TimeAgo`,
  `UptimeBand`…).
- `lib/`: pure functions and data, without JSX: formats (including the only "time ago" helper,
  `ago` in `lib/format.js`), labels, color rules, calculations. Only `lib/deviceTypes.js`
  references `lucide-react` icons (the table of device types).
- `hooks/`: React hooks (state in the URL, theme, favorites).
- `plugins/`: client side of the plugins, reached by the core only through the registries
  (`plugins/index.jsx`, `plugins/nav.js`, `plugins/meta.js`). See the [plugin guide](plugins.md).
- `i18n/`: the client catalogs (`en.json`, `fr.json`).
- At the root: the application (`App.jsx`, `Shell.jsx`, `api.js`, `admin.jsx`) and what serves
  several views or is mounted once: the Ctrl K palette, the alert bell, the drawers and their
  sections (`DeviceForm`, `MapParent`, `PortsSection`), and the network map (`NetworkMap`, loaded on
  demand).

Import rules, checked by `server/test/client-structure.test.js`:

- only `App.jsx` imports `views/` (exception: `views/Mural.jsx` imports `views/Cockpit.jsx`);
- `lib/` imports neither `ui/`, nor `components/`, nor `views/`;
- `ui/` imports neither `components/` nor `views/`;
- the core goes through the plugin registries only; `lib/` and `ui/` read only the plugin data
  (`plugins/meta.js`); a plugin does not import another plugin; `meta.js` files import neither
  `ui/`, nor `components/`, nor `views/`, nor any `.jsx` file;
- a dynamic `import()` must take a string literal, so the rule can read it.

Size, checked by `server/test/bundle-size.test.js`: main bundle at most 476,000 bytes, each view
chunk at most 200,000 bytes.

## Local development

Node.js 22.13 or later.

```bash
cp .env.example .env   # fill in the tokens
cd server && npm install && node index.js   # backend :8088
cd client && npm install && npm run dev      # front :5173 (proxy /api → :8088)
cd client && npm run lint                    # ESLint (React hooks rules), 0 warnings
cd server && npm test                        # full suite (without network: unshare -rn)
```

The Vite dev server proxies `/api` and `/icons` to the backend on port 8088. Without a
`config.json`, the backend starts in the "setup needed" mode: see
[Installation](installation.md#without-a-config-the-setup-needed-mode). `config.example.json` is a
local config that works as is (see [Manual setup](installation.md#manual-setup)).

## README screenshots

The screenshots of the README (`docs/screenshots/*.png`) are taken on a made-up demo world, never
on a real instance: `scripts/screenshots/demo-data.mjs` holds the data (example.net domains,
RFC 5737 addresses, generic host names, invented MAC addresses), `demo-server.mjs` serves the
built client and answers the read routes of `/api` from it (no config, no database, no outbound
call), and `capture.mjs` builds the client, starts that server on a free local port and takes the
five views in Chromium (English, dark theme, clock pinned so the "ago" texts do not move).

Playwright is not a dependency of the project: `PLAYWRIGHT` points at the folder of an installed
`playwright` package whose Chromium is already downloaded.

```bash
cd client && npm ci && cd ..
PLAYWRIGHT=/path/to/node_modules/playwright node scripts/screenshots/capture.mjs
#   --no-build: reuse client/dist   --only cockpit,wall: some views only
node scripts/screenshots/demo-server.mjs --port 8099   # browse the demo at http://127.0.0.1:8099/
```

When a view or an API answer changes shape, update `demo-data.mjs` with it (copy the shape, never
real data), take the screenshots again and check them by eye.

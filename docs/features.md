# Views, history and widgets

## Views

| Route | What it shows |
| --- | --- |
| `/` | The cockpit: status banner, six KPIs, alerts, hypervisors with 24 h graphs, service health as 24 h uptime bars, backups, CI and pinned items. |
| `/services` | All services and their probes. |
| `/infra` | Hosts and guests, with what the [agent](agent.md) reports. |
| `/network` | The [network module](network.md). |
| `/updates` | [Versions and updates](updates.md). |
| `/backups` | Backups. |
| `/ci` | CI runs. |
| `/alerts` | Current and past [alerts](alerts.md). |
| `/integrations` | Integrations. |
| `/wall` | The cockpit in full screen, for a dedicated display. |

Query parameters open a detail panel:

- `?s=<id>` opens a service: probes, uptime over 24 h, 7, 30 and 90 days, latency, failures and
  incidents.
- `?h=<id>` (on `/infra`) opens a host.

**`/wall`** is meant for a screen that stays on. The cursor is hidden, the page reloads itself
every 6 hours, and a "disconnected" banner appears when the server stops answering.

### Former route names

The routes used to have French names. `/reseau`, `/maj`, `/sauvegardes`, `/alertes` and `/mural`
are still served, and will stay, so that old Telegram links and bookmarks keep working. They show
the same view, then the address switches to the English name. The query string and the fragment
are kept.

The same goes for the Telegram bot: the commands are `/network`, `/device` and `/known`, and the
old `/reseau`, `/appareil` and `/connu` are still accepted.

## History

Every probe result is stored in SQLite. Raw results are kept for 8 days, hourly aggregates for
400 days.

## Widgets

A generic widget engine, modeled on [Homepage](https://gethomepage.dev/), queries the APIs of your
services from the server, every minute by default. A widget is declared on a service, under
`services[].widget`:

```json
"widget": { "url": "http://192.0.2.10:8989", "interval": "2m",
  "auth": { "type": "header", "name": "X-Api-Key", "secretEnv": "SONARR_KEY" },
  "fields": [ { "label": "Missing", "path": "/api/v3/wanted/missing?pageSize=1", "json": "totalRecords", "format": "int" } ] }
```

- `interval`: how often the widget is refreshed (default: every minute).
- `auth.type`: `header`, `bearer`, `query`, `pihole` (Pi-hole v6 session) or `qbittorrent`
  (cookie).
- Each field is read either with `json` (a dotted path; `length` gives the size of an array) or
  with `prom` (a Prometheus metric), not both. `path` starts with `/`.
- `format`: `int`, `number`, `percent`, `mbps`, `ms`, `rate`, `until`, `ago`, `bool` or `text`.
  `text` shows the value as is, which suits an identifier or a port such as `41634` (`int` would
  add a thousands separator). An optional `unit` can be added to a field.

Plugins can register more authentication types and formats: see
[Writing a plugin](plugins.md#extensions).

**Secrets never go in `config.json`.** `secretEnv` names an environment variable (on a systemd
install, one defined in `/etc/vigie/vigie.env`). `check-config` refuses any field named `key`,
`password`, `token`, `secret` (and similar names) that holds a value in plain text. See
[Configuration](configuration.md) and [Security](security.md).

## Weather

```json
"weather": { "label": "Paris", "lat": 48.8566, "lon": 2.3522 }
```

The forecast comes from [Open-Meteo](https://open-meteo.com/), which needs no API key. An optional
`timezone` key sets the forecast's time zone (default: `Europe/Paris`).

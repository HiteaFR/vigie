# Configuration

An instance reads two files:

- `config.json`: hypervisors, hosts, groups, services and their probes, bookmarks, Gitea
  repositories. Nothing sensitive: it can live in version control.
- an environment file with the secrets (`.env` at the root by default, or the file named by
  `ENV_FILE`, for example `/etc/vigie/vigie.env`). Never commit it.

The [setup wizard](installation.md#setup-wizard-init) writes both. This page describes the keys.

## `config.json`

The config uses schema **v2**. It is validated at startup and can be checked in CI
(`cd server && npm run check-config`), so an invalid config is never deployed. All default values
are in the schema (`server/lib/config.js`).

- A v1 config (`links[]` and `health[]`, without `version`) is refused:
  `config v1 no longer supported: move to version 2 (see docs/configuration.md)`.
- An empty config (`{}`), `null`, an array or a scalar gets
  `empty or invalid config: version 2 expected (see docs/configuration.md)`.
- A **warning** ("⚠") blocks neither startup nor CI: it is logged. Today, the only one is an entry of
  `network.probe.exclude` that is neither an IPv4 address nor a host, which only disables the
  service probe (see [Network](network.md)).

## Locale

`locale` is the language of the instance: interface, Telegram, digest, bot replies, date and
number formats (`en`: en-GB, `fr`: fr-FR). **`en` by default**; a French instance sets
`"locale": "fr"`. Logs, `check-config` and `init` stay in English.

If the browser cannot read `/api/config` at load time (4 s timeout, error), or cannot load the
language catalog, the interface uses the last language of the instance seen by this browser
(stored at each successful load), or else English.

## Host names and proxies

### `allowedHosts`

Host names or IPv4 addresses (without port) accepted in the `Host` header, on top of `localhost`,
`127.0.0.1`, `[::1]` and the host name of `alerts.dashboardUrl`.

Any other request gets **421** "host not allowed", with no data from the instance (protection
against DNS rebinding). The response gives the name received (truncated to 100 characters) and what
to do: an HTML page for a browser (`Accept: text/html`, outside `/api`), JSON otherwise
(`{ error, host, hint }`).

To allow a new name (DNS alias, Tailscale name), add it to `allowedHosts`, then restart.
`X-Forwarded-Host` is never read: the proxy must pass the original `Host`.

### `trustedProxies`

Trusted proxies: exact IPv4 or IPv6 addresses, or IPv4 and IPv6 CIDR ranges. A proxy in a container
changes address within its subnet: give the network of the proxy's Docker bridge, for example
`"172.18.0.0/16"`, as narrow as possible.

- The prefix must be at least `/8` in IPv4 and `/32` in IPv6. Names and ports are refused.
- An IPv6 range that covers the IPv4-mapped addresses (`::ffff:0:0/96`, for example `::/32`) is
  refused: it would trust every IPv4 address. A mapped entry (`::ffff:a.b.c.d/n`) counts as its IPv4
  form (`a.b.c.d/(n-96)`, IPv4 rules).
- Empty by default.

From these addresses only, Vigie reads:

- `X-Forwarded-For`, from right to left, skipping proxies: the real client IP, used for the admin
  network, the login lock and the audit log;
- `X-Forwarded-Proto`, for the `Secure` cookie flag.

A request from a trusted proxy without a readable client IP is refused (403), never treated as
coming from the proxy. A proxy is never a "known" address. Direct access (without a proxy) is
unchanged, with a cookie without `Secure`. Express's `trust proxy` is not used.

Example: [Behind an HTTPS proxy](installation.md#behind-an-https-proxy).

## Listening and security

`listenHost` and `security` hold the security settings of the instance. **Without them, a new
installation listens only on `127.0.0.1`, requires a session to read the API, refuses admin login
over HTTP outside the loopback, and accepts only the loopback as admin network.**

Priority: **non-empty** environment variable > config > default. An empty variable (`X=`) is
ignored. That is why an instance should set these options here rather than in `Environment=` lines
of a systemd unit, which an empty value in the environment file would override.

At startup, one log line gives the effective values and their source, without any secret:
`security: listenHost=:: (config) ; anonymousRead=true (config) ; …`.

- `listenHost`: listen address (a non-empty `LISTEN_HOST` wins; default `127.0.0.1`). `"::"` means
  every interface, dual stack (IPv6 and IPv4).
- `security.anonymousRead`: `true` allows reading the API without a session (default `false`:
  session required). These stay public in every case: `GET /api/healthz`, `GET /api/session`,
  `GET /api/config` (title, subtitle, footer), `POST /api/login` and `/api/logout`, and the static
  files. `GET /api/audit` always requires a session, and writes keep their checks. Without anonymous
  read or a session, the client (wall mode included) shows the login screen.
- `security.httpLogin`: `true` accepts admin login over HTTP from the network (default `false`:
  HTTPS, either direct or through a proxy listed in `trustedProxies` with
  `X-Forwarded-Proto: https`, or the loopback). Only the login is guarded: a cookie obtained over
  HTTPS is `Secure` and is never sent over HTTP.
- `security.adminCidrs`: networks allowed to log in and write, as IPv4 addresses or `a.b.c.d/nn`
  (a non-empty `ADMIN_ALLOWED_CIDRS` wins; default `["127.0.0.1/32"]`, `::1` included). Example for
  a LAN and Tailscale: `["192.0.2.0/24", "100.64.0.0/10", "127.0.0.1/32"]`.

## Framing and security headers

`frameAncestors` lists the origins `http(s)://host[:port]` (no path, query or fragment) allowed to
show the dashboard in a frame, for example a kiosk that displays `/wall`. Empty by default: no frame
(`frame-ancestors 'none'`, `X-Frame-Options: DENY`).

Every response also carries:

- a strict CSP: the dashboard's scripts and the hash of the theme script of `client/index.html`,
  never `'unsafe-inline'` or `'unsafe-eval'` for scripts;
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`;
- no `X-Powered-By`.

Editing the inline script of `client/index.html` changes its hash: the test
`security-headers.test.js` then fails and gives the new value of `THEME_SCRIPT_HASH`
(`server/lib/security-headers.js`).

## Gitea

The `plugins.gitea` block (optional) holds `owner` and `repos`, the repositories to follow. The old
top-level `gitea` block is still accepted, with a warning at startup; both at once are refused.

Gitea is read only if this block is present **and** `GITEA_URL` is not empty (`GITEA_TOKEN` for
authentication). Otherwise `/api/gitea` and `/api/runners` answer `{ "configured": false }`, the CI
tile says "not configured", the digest says the CI is not configured, and no `source_error` is
raised. Plugins in general: see the [plugin guide](plugins.md).

## Secrets file

The environment file holds the secrets, never `config.json`. The ones written by the wizard:

- `ADMIN_PASSWORD_HASH`: the admin password hash (`server/scripts/admin-password.js`);
- `<PREFIX>_TOKEN_ID` and `<PREFIX>_TOKEN_SECRET` for each Proxmox cluster, where `<PREFIX>` is
  its `proxmox[].env` value (for example `PVE_TOKEN_ID`); `<PREFIX>_HOST`, if set, overrides the
  cluster URL;
- `GITEA_URL` and `GITEA_TOKEN`.

## Launch variables

Optional. Without them, the server keeps its default behavior. The Docker image and the example
systemd unit set `CONFIG_PATH` and `PKI_DIR` (see [Docker](docker.md) and
[systemd](installation.md#systemd)).

- `CONFIG_PATH`: config file to load (default: `config.json` at the root). See also the
  ["setup needed" mode](installation.md#without-a-config-the-setup-needed-mode).
- `PKI_DIR`: directory of the pinned CAs (default: `server/pki`). `proxmox[].ca` keeps the form
  `pki/<name>.pem` and points to `<PKI_DIR>/<name>.pem`, so the config and CAs can live outside the
  deployed tree (see `deploy/vigie.service.example`).
- `ENV_FILE=none`: no environment file is read. `ENV_FILE=<path>` reads that file instead of
  `.env`. Without `ENV_FILE`, `.env` at the root is read if it exists. Its variables are added
  without overwriting those already set.
- `LISTEN_HOST`: listen address. When not empty, it wins over `listenHost` from the config
  (default: `127.0.0.1`). The `HOST` variable, which some environments export, has no effect.
- `PORT`: listen port (default 8088). With `PORT=0`, the port chosen by the system is written to
  the log (`vigie listening on :<port>`). The tests (`server/test/server-boot.js`) start the real
  server this way: dummy config, `ENV_FILE=none`, `LISTEN_HOST=127.0.0.1`, temporary database
  (`STATE_DIRECTORY`), empty environment.
- `STATE_DIRECTORY`: state directory (SQLite database, icons; default `<root>/data`). systemd sets
  it from `StateDirectory=`.

## Services

```json
{
  "id": "dns", "name": "Pi-hole", "group": "network", "host": "dns1", "icon": "pi-hole",
  "url": "http://192.0.2.53/admin/", "desc": "LAN DNS and DHCP", "pinned": true,
  "checks": [
    { "type": "dns", "server": "192.0.2.53", "name": "vigie.example.net", "label": "local resolution", "expect": { "address": "192.0.2.10" } },
    { "type": "http", "url": "http://192.0.2.53/admin/", "expect": { "status": 200, "body": "Pi-hole" } },
    { "type": "tcp", "target": "192.0.2.53:53" },
    { "type": "tls", "host": "dns1.example.net", "port": 443, "warnDays": 21, "critDays": 7 }
  ]
}
```

- `id` is the history key: **never rename it**.
- `host` points to an entry of `hosts[]` (VM or LXC with `pve` and `vmid`, node, appliance,
  external). The service's environment (prod or dev) comes from it; otherwise `env` is required.
- Probe types:
  - `http`: status below 500 by default, or `expect.status` / `expect.body`. A virtual host is
    probed by its name in `url`; `hostHeader` is no longer accepted.
  - `tcp`.
  - `tls`: certificate expiry, warning below 21 days, critical below 7 days; every 6 h by default.
    If no certificate can be read (connection dropped, timeout), it retries after 60 s, then
    doubles the delay up to the normal interval. "Refresh" re-runs only the failed `tls` probes.
  - `dns`: A record lookup through a given server. With `expect.address` (an IPv4 address), the
    check fails if that address is not among the answers: `answer <addresses>, expected <address>`.
- `interval`: `30s`, `5m`, `6h`.
- Without `checks`: an HTTP probe on `url`. `"checks": []` means a link only.
- **TLS of outbound calls** (`server/lib/tls.js`): a call that carries a secret (token, password,
  auth header) accepts only a verified certificate, from Node's built-in CA store or from the
  pinned CA of a Proxmox cluster. Every host name and every public IP is verified too. The only
  exceptions:
  - a call **without a secret** to a literal private IPv4 address (10/8, 172.16/12, 192.168/16,
    127/8), for LAN probes with self-signed certificates;
  - an `http` probe that carries `"tls": "insecure"` with `"tlsReason"` (required text), for
    example a probe without a secret to a staging service signed by a private CA.

  `tls` is refused everywhere else (widgets, versions, `proxmox[]`). A probe never follows a
  redirect, and the `tls` probe type reads the expiry even of an unknown certificate. A widget with
  `auth` over `https://` to a private IP is refused (the certificate cannot be verified).
- **Plain HTTP on the LAN**: the secrets of services reached over `http://` (widgets, version
  sources, plugins such as Gitea) travel **in clear text** on the network. This is an accepted risk, like admin login over
  HTTP. If such a service moves to HTTPS, the rule above applies automatically.
- `icon`: a [dashboard-icons](https://dashboardicons.com) or selfh.st slug (as in Homepage). Icons
  are not in the repository: they are downloaded into the state directory by
  `scripts/vendor-icons.mjs` (in Docker: `docker compose run --rm vigie icons`); see
  [Icons](icons.md). Without an icon, a monogram is shown.

## Hosts

An entry of `hosts[]`, here a development machine whose containers stay off the updates page and
which raises no `port_new` alert:

```json
{ "id": "devbox", "name": "devbox", "kind": "vm", "pve": "lab", "vmid": 120, "ip": "192.0.2.36",
  "parent": "pve-lab", "env": "dev", "agent": "ssh",
  "updates": { "containers": false }, "alerts": { "ports": false } }
```

- `updates.containers` (optional): `false` removes the host's containers from the updates page (no
  `docker:` component), for development containers started by hand that come and go (see
  [Versions and updates](updates.md)). Absent or `true`: default behavior. Any other value, or any other key under `updates`, is refused.
- `alerts`: `severity` and `mute`, as for a service. For a host only, `ports` (optional): `false`
  turns off the `port_new` alerts of the host (see [the agent](agent.md)). Absent or `true`:
  default behavior.
- For a VM or LXC only, `alerts.backups` (optional): `false` turns off the `not_backed_up` and
  `backup_late` alerts of a guest you deliberately leave out of your backup jobs (a test VM, a
  guest you can recreate), and leaves it out of the backup figures of the cockpit and the digest.
  `backup_failed` still applies (a failed task brings it back into the figures), and the Backups
  page still lists the guest as not backed up. Absent or `true`: default behavior. On another kind of host,
  `check-config` warns (the option is ignored).
- For a host with an agent only, `alerts.diskFreeMinGB` (optional): absolute threshold of free
  space on the root `/`, in GB of 1024³ bytes (as shown in the interface and by `df -h`), a positive
  number up to 100,000, decimals accepted. Below the threshold: a `disk_free` alert. Absent: no
  alert of this kind, only the percentages of `alerts.disk` apply. On a host without an agent,
  `check-config` warns (the option is ignored).

# Installation

Vigie runs either in a container or directly with Node.js (22.13 or later).

- In a container: see [Docker](docker.md) (`docker compose run --rm init`).
- With Node.js: run the setup wizard below, or [set it up by hand](#manual-setup).

Every configuration key is described in [Configuration](configuration.md).

## Setup wizard (`init`)

Run it from `server/`, after `npm ci`:

```bash
cd server && npm run init                     # interactive wizard (terminal required)
npm run init -- --config /etc/vigie/config.json --env /etc/vigie/vigie.env --pki /etc/vigie/pki
```

It asks, in this order, with defaults, and shows a summary before writing anything:

1. the title, then the interface language (`en` by default, or `fr`), written to the config
   (`locale`; non-interactive: `--locale en|fr`, default `en`);
2. the admin password (hidden input, typed twice, at least 12 characters; same code as
   `scripts/admin-password.js`);
3. the listen address (`127.0.0.1` by default). `::` or `0.0.0.0` open the instance to the
   network: the wizard then offers `allowedHosts`, `security.adminCidrs` and, not recommended, admin
   login over HTTP;
4. Proxmox, optional, one or more clusters: URL, variable prefix, token (hidden secret), **pinned
   CA** (see [Proxmox TLS](#proxmox-tls)), then a connection test (version and nodes). On failure:
   retry, fix, keep or give up;
5. Gitea, optional: URL, hidden token, test (user; a warning if the token lacks `read:admin` for
   the runners, or `read:repository`);
6. the agent's ed25519 SSH key, optional (`<state>/ssh/`, with an empty `known_hosts`).

It writes a minimal valid config (with an explicit `security` block, set to the safe defaults), the
environment file with mode **0600** (`ADMIN_PASSWORD_HASH`, Proxmox and Gitea tokens) and the CAs in
the `PKI_DIR` directory. It then prints the paths, the access address and the `check-config`
command.

Default paths: `config.json` and `.env` at the root of the repository, `server/pki`, and
`<root>/data` for the state. The variables `CONFIG_PATH`, `ENV_FILE`, `PKI_DIR` and
`STATE_DIRECTORY` change them, and so do the options `--config`, `--env`, `--pki` and `--state`.

Safeguards:

- it refuses to overwrite a file without `--force`;
- it never writes to a system path (`/etc`, `/var/lib`, the paths of a running instance) that comes
  from a variable, unless an explicit option gives it. Symbolic links are resolved: a link to `/etc`
  or to the state directory of an instance does not get through;
- write order: CAs, key, environment file, and the config last. On failure, the message says what
  is already written, and no temporary file is left behind.

It sets up neither services nor Telegram: add them afterwards (see
[Configuration](configuration.md) and [Alerts and notifications](alerts.md)).

**Warning**: `npm run init`, without options, writes `<root>/.env` (and `<root>/config.json`). The
server loads that file at startup if it exists, and adds its variables without overwriting those
already set (for example by the `EnvironmentFile` of a systemd unit). Do not run it that way on a
running instance. On a systemd installation: always `--config` and `--env` (and `--pki`, `--state`).

## Proxmox TLS

There is no permissive fallback. The CA to pin is either a PEM file (on a node:
`/etc/pve/pve-root-ca.pem`), or the CA presented by the server, kept only after you compare its
SHA-256 fingerprint. On the node:

```bash
openssl x509 -in /etc/pve/pve-root-ca.pem -noout -fingerprint -sha256
```

The presented certificate is read without verification and without sending any secret. The
connection test itself goes through the pinned HTTPS agent, as in production.

## Non-interactive mode

For Docker and scripts: `--non-interactive` (or `--yes`). No question is asked, and a missing value
is a clear failure.

Options: `--title`, `--locale`, `--listen`, `--allowed-hosts`, `--admin-cidrs`, `--http-login`,
`--pve-url`, `--pve-name`, `--pve-id`, `--pve-env`, `--pve-token-id`, `--pve-ca <PEM>` or
`--pve-ca-fingerprint <SHA-256>` (one or the other), `--pve-allow-http` (Proxmox over http: the
token travels in clear text, refused without this option), `--gitea-url`, `--gitea-owner`,
`--ssh-key`, `--skip-tests`, `--keep-failed`, `--timeout` (1 to 300 s), plus the path options
`--config`, `--env`, `--pki`, `--state` and `--force`. The full list: `npm run init -- --help`.

Error messages never repeat a value they received.

Secrets are **never** passed as arguments. Use the variables `VIGIE_INIT_ADMIN_PASSWORD`,
`VIGIE_INIT_PVE_TOKEN_SECRET` and `VIGIE_INIT_GITEA_TOKEN`, or `--secrets-stdin` (`NAME=value`
lines with these names; non-interactive mode only).

## Without a config: the "setup needed" mode

Without a config, the server starts in the **"setup needed"** mode. Nothing is read or probed:
no collection, no versions, no digest, no bot, no heartbeat. The client shows what to do (run
`init`), `/api/healthz` returns `unconfigured: true`, and the log says so
(`config missing (…): "to configure" mode`).

This mode happens only if `CONFIG_PATH` is **absent** from the environment **and** nothing exists
at the default location (`config.json` at the root; a symbolic link, even a broken one, counts). In
every other case the server stops: `CONFIG_PATH` set but empty or made of spaces (a `CONFIG_PATH=`
line in an environment file), file missing or unreadable, invalid config. A declared instance never
starts empty.

## Manual setup

`config.example.json` is a local example that works as is: Vigie monitors itself on
`127.0.0.1:8088`.

1. Copy it to `config.json`.
2. Generate the admin password hash with `node server/scripts/admin-password.js`. It prints an
   `ADMIN_PASSWORD_HASH=…` line for the environment file (`.env` at the root by default);
   `--write <file>` replaces that line in the given file.
3. Validate: `cd server && node scripts/check-config.js ../config.json`.

The server serves the built client (`client/dist`): build it with `cd client && npm ci && npm run build`.

Gitea and Proxmox are **optional**. Without a Gitea block (or without `GITEA_URL`), the CI view says
"Gitea not configured" and no `source_error` alert is sent. `proxmox: []` is accepted.

## systemd

`deploy/vigie.service.example` is a generic unit to copy to `/etc/systemd/system/vigie.service`
and adapt. Its layout:

| Path | Role |
| --- | --- |
| `/opt/vigie` | the code (`WorkingDirectory=/opt/vigie/server`) |
| `/etc/vigie/config.json` | `CONFIG_PATH`; `root:root 0644`, no secret |
| `/etc/vigie/pki/<name>.pem` | `PKI_DIR`; pinned CAs of the Proxmox clusters over https (`pki/<name>.pem` in the config) |
| `/etc/vigie/vigie.env` | secrets (tokens, password hash); `root:root 0600`, optional (`EnvironmentFile=-`) |
| `/var/lib/vigie` | state: SQLite database, icons (`StateDirectory=vigie`, exported as `STATE_DIRECTORY`) |

The service runs as a dedicated `vigie` user and is hardened: it writes only to its state
directory; it reads `/opt/vigie`, `/etc/vigie`, `/run/net-scan` and `/proc/net/route`; it listens on
one TCP port and on 5353/udp (mDNS); it runs `ssh` and `ip`. `CAP_NET_BIND_SERVICE` is there only to
listen on a port below 1024 (`PORT=80`) without running as root.

Put the listen address, anonymous read, HTTP login and admin networks in `config.json`
(`listenHost`, `security`; see [Configuration](configuration.md#listening-and-security)), not in
`Environment=` lines of the unit: an empty variable in the environment file would override an
`Environment=` line, whereas it is ignored against the config.

To create these files with the wizard, give it every path:

```bash
cd /opt/vigie/server && npm run init -- --config /etc/vigie/config.json --env /etc/vigie/vigie.env --pki /etc/vigie/pki --state /var/lib/vigie
```

Then check that owners and modes match the table above.

## Behind an HTTPS proxy

With a proxy such as Traefik or Caddy, on another machine or in a container: listen on the network,
accept only the names it serves, trust only that proxy, and open admin login only to the network
you want:

```json
"listenHost": "::",
"allowedHosts": ["vigie.example.net"],
"trustedProxies": ["192.0.2.153"],
"security": { "anonymousRead": false, "httpLogin": false, "adminCidrs": ["192.0.2.0/24", "127.0.0.1/32"] }
```

`trustedProxies` also accepts the network of a Docker bridge (`"172.18.0.0/16"`). Admin login then
goes over HTTPS through the proxy (`X-Forwarded-Proto: https`), without `httpLogin`. Details:
[`allowedHosts` and `trustedProxies`](configuration.md#host-names-and-proxies).

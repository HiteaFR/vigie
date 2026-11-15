# Deployment

This page describes a native installation under systemd, and how to update it without breaking
the browser tabs that are already open. The repository ships no deployment pipeline: it provides
an example unit and a few scripts that any deployment circuit can reuse. To run Vigie in a
container instead, see [Docker](docker.md). The setup wizard is described in
[Installation](installation.md).

## Contents

- [Requirements](#requirements)
- [Layout](#layout)
- [systemd unit](#systemd-unit)
- [First installation](#first-installation)
- [Checks before deploying](#checks-before-deploying)
- [Updating an instance](#updating-an-instance)
- [Deployment scripts](#deployment-scripts)

## Requirements

- **Node.js 22.13 or later**. Vigie uses the built-in `node:sqlite` module.
- `rsync` on the build machine and the target (used by `deploy/sync.sh`).
- `ssh` and `ip` on the target if you use SSH agents or the network module: the service runs
  them.

## Layout

The example unit uses this layout. Code, configuration and state are kept apart, so that a
deployment can replace the code without touching anything else.

| Path | Content | Owner and mode |
| --- | --- | --- |
| `/opt/vigie` | The code (server, built client). Overwritten by each deployment. | |
| `/etc/vigie/config.json` | Configuration (`CONFIG_PATH`). No secret. | `root:root` 0644 |
| `/etc/vigie/pki/<name>.pem` | Pinned CAs of the `https://` Proxmox clusters (`PKI_DIR`), referred to as `pki/<name>.pem` in the config. | |
| `/etc/vigie/vigie.env` | Secrets: tokens, password hash. Optional. | `root:root` 0600 |
| `/var/lib/vigie` | State: SQLite database, icons, SSH key of the agent. | the service user |

The **state directory** is the unit's `StateDirectory=`, exported by systemd as
`STATE_DIRECTORY`. Never put it under `/opt`: the deployment overwrites that tree. Without
`STATE_DIRECTORY`, Vigie uses `<root>/data` (local development). Icons go to `ICONS_DIR`, or
`<state directory>/icons` by default.

## systemd unit

`deploy/vigie.service.example` is a generic unit. Copy it to
`/etc/systemd/system/vigie.service` and adapt it. It:

- runs as the user `vigie`, from `/opt/vigie/server`, with
  `node --disable-warning=ExperimentalWarning index.js`;
- reads `/etc/vigie/vigie.env` if it exists (`EnvironmentFile=-…`);
- sets `NODE_ENV=production`, `CONFIG_PATH=/etc/vigie/config.json` and
  `PKI_DIR=/etc/vigie/pki`;
- creates the state directory `/var/lib/vigie` (`StateDirectory=vigie`, mode 0750);
- restarts on failure after 3 seconds;
- is hardened: it writes only to its state directory; it reads `/opt/vigie`, `/etc/vigie`,
  `/run/net-scan` and `/proc/net/route`; it listens on one TCP port and on 5353/udp (mDNS);
  it runs `ssh` and `ip`. `CAP_NET_BIND_SERVICE` is there only to listen on a port below 1024
  (`PORT=80`) without running as root.

The port is `PORT` (default 8088). Set the listen address, anonymous read, HTTP login and admin
networks in `config.json` (`listenHost`, `security`), not in the unit: an empty variable in the
environment file would override an `Environment=` line of the unit, while it is ignored in
favour of the config. See [Security](security.md#safe-defaults).

```bash
useradd --system --home-dir /var/lib/vigie --shell /usr/sbin/nologin vigie
cp deploy/vigie.service.example /etc/systemd/system/vigie.service
systemctl daemon-reload
systemctl enable --now vigie
```

## First installation

1. Build the client and install the server's production dependencies (see
   [Updating an instance](#updating-an-instance)), then copy the tree to `/opt/vigie`.
2. Create the configuration with the [`init` wizard](installation.md#setup-wizard-init). On a
   systemd installation, **always** give
   the paths explicitly: without options, `init` writes `config.json` and `.env` at the root of
   the code, and the server loads that `.env` at startup if it exists.

   ```bash
   cd /opt/vigie/server
   npm run init -- --config /etc/vigie/config.json --env /etc/vigie/vigie.env --pki /etc/vigie/pki --state /var/lib/vigie
   ```

3. Check the configuration:

   ```bash
   CONFIG_PATH=/etc/vigie/config.json PKI_DIR=/etc/vigie/pki npm run check-config
   ```

4. Install and start the unit (see above), then check `/api/healthz`.
5. Download the service icons, if your config uses any. They are not distributed with Vigie,
   and the server reads the list only at startup, so restart it afterwards (details in
   [Icons](icons.md)):

   ```bash
   cd /opt/vigie
   runuser -u vigie -- env CONFIG_PATH=/etc/vigie/config.json ICONS_DIR=/var/lib/vigie/icons timeout 120 node scripts/vendor-icons.mjs
   systemctl restart vigie
   ```

## Checks before deploying

Run the same checks as the project's CI, which only tests and never deploys:

```bash
(cd client && npm ci && npm run lint)                       # ESLint, 0 warning
(cd server && npm ci --omit=dev \
  && node scripts/check-config.js ../config.example.json \
  && npm test)                                              # no test may be skipped
(cd client && npm run build)
```

Install the client before running `npm test`: the server tests also render the real client
components. Check your own config the same way (`node scripts/check-config.js <file>`, or
`CONFIG_PATH`).

`node server/scripts/alerts-preview.mjs` shows which alerts a new config would raise on a running
instance, without sending anything. See [alerts.md](alerts.md#previewing-rules-before-a-deployment).

## Updating an instance

A typical deployment, from a prepared source tree:

1. Build: `npm ci && npm run build` in `client/`, `npm ci --omit=dev` in `server/`.
2. Optionally write the commit to a `REVISION` file at the root of the source tree
   (`git rev-parse --short HEAD > REVISION`). `/api/healthz` then reports it as `commit`, next
   to `version`, so you can check that the instance runs the expected code. The content must be
   a hexadecimal SHA of 7 to 40 characters; otherwise `commit` is `null`.
3. `deploy/icons-migrate.sh /opt/vigie /var/lib/vigie/icons`, only when you upgrade an older
   installation that kept icons inside the code tree.
4. `deploy/sync.sh <source> /opt/vigie` (or `host:/opt/vigie`).
5. Restart the service and check `/api/healthz`.
6. After a successful health check:
   `node deploy/prune-assets.mjs --dist /opt/vigie/client/dist --manifest <source>/client/dist/.vite/manifest.json`.

`/api/healthz` is public. It returns `ok`, `version`, `commit`, the uptime, the number of
checks, and the time of the last alert evaluation.

## Deployment scripts

### `deploy/sync.sh`

```bash
deploy/sync.sh <source> <destination> [extra rsync options]
```

`<destination>` is a local path or `host:path` (over SSH). Old chunks are **kept for one
cycle**:

1. The hashed assets of the new build are **added** next to the old ones (`client/dist/assets/`,
   never with `--delete`). The served build does not change yet.
2. The rest is synchronized with `--delete`, **except** `client/dist/assets/` and
   `client/dist/.vite/`, which are neither transferred nor deleted. `.git` and `.env` are
   always excluded. `index.html` switches to the new build, whose chunks are already there; a
   tab on the old build still finds its own.

The script stops if `<source>/client/dist/assets` is missing (no build). Extra arguments are
passed to rsync, for example `--exclude /client/node_modules/`.

### `deploy/prune-assets.mjs`

```bash
node deploy/prune-assets.mjs --dist <served client/dist> --manifest <build manifest | ->
```

Run it **after** the health check. It keeps the chunks of the served build and of the previous
one, and deletes the older ones. A tab open on build N therefore still loads its chunks after
N+1 is deployed, and gets a 404 after N+2; the view then offers to reload.

- `--manifest` is the Vite manifest of the new build (`client/dist/.vite/manifest.json` in the
  source tree, since `sync.sh` does not transfer `.vite/`), or `-` to read it from standard
  input (for example through SSH).
- Its state lives in `<dist>/.vite/`: `manifest.json` (served build) and
  `manifest.previous.json` (previous build).
- Redeploying the same build shifts nothing. On the first deployment without state, nothing is
  deleted.
- Only regular files directly inside `assets/` are deleted: never a symbolic link, a directory
  or anything outside `assets/`.
- If a manifest is unreadable, a path points outside `assets/`, or a file of the current build is
  missing, it stops with an error, deletes nothing and leaves its state unchanged.
- Known edge case: if deployment N+1 fails after the synchronization (restart or health check),
  the cleanup does not run and the state still records N as current. At deployment N+2, the
  chunks of N+1 are deleted. This is rare, and the failed deployment of N+1 makes it visible.

### `deploy/icons-migrate.sh`

```bash
deploy/icons-migrate.sh <old tree> <icons directory>
```

Run it **before** the synchronization, which deletes `<old tree>/client/{dist,public}/icons`. It
needs no network.

- It copies, file by file, each icon of the old tree (`client/dist/icons`, then
  `client/public/icons`) that is **missing** from the icons directory. It never overwrites one:
  a partial directory is completed, a complete one does not change.
- Only regular files named `<slug>.svg` or `<slug>.png` (`[a-z0-9-]`) are copied. No link is
  followed.
- No source: nothing happens, exit code 0. A failed copy gives a non-zero exit code: the
  deployment stops before the synchronization, and the old tree and its icons stay in place.
- The directory and its files are then given to the owner of the parent directory (read with
  `stat`, no name hard-coded), with modes 0755 and 0644.
- It prints one summary line `icons: …`.

The script is self-contained: you can send it over SSH on standard input, for example
`ssh host sh -s -- /opt/vigie /var/lib/vigie/icons < deploy/icons-migrate.sh`.

# Docker

Each release publishes the image **`ghcr.io/hiteafr/vigie`** for `linux/amd64` and `linux/arm64`,
tagged `x.y.z`, `x.y`, `x` and `latest`, with a signed build provenance. `docker-compose.yml` pins
the version of its release. The image can also be built locally from the repository (see
[From source](#from-source)).

- `Dockerfile` in three stages: client (`npm ci`, then `vite build`), server (`npm ci --omit=dev`),
  runtime.
- Base `node:22.x-bookworm-slim`, pinned by version and digest; user `node` (uid 1000); port 8088;
  `HEALTHCHECK` on `/api/healthz`.
- Added packages: `openssh-client` (`ssh` agents), `iproute2` (`ip neigh`), `ca-certificates`.
- `.dockerignore` keeps out of the build context `.env*`, `config.json`, `data/`, the
  `node_modules`, `.git`, keys and drafts.
- Requires Docker Compose 2.24 or later.

**Proven on 2026-11-11** on a test Docker machine (amd64, Docker 29.9, Compose v5.7) with
`scripts/docker-proof.sh`, in host mode: build of the image and of the ARP companion (not started),
start without a config in the "setup needed" mode, non-interactive `init`, healthcheck "healthy" and
`/api/healthz` with the commit, admin login over the loopback, uid 1000 on the state volume and the
database, `vigie.env` in mode 0600, `/etc/vigie` read-only for the service, restart with the
database kept, stop and cleanup.

**Each release** (`.github/workflows/release.yml`) pushes the image by digest only, pulls that digest
back for each platform and runs the same `scripts/docker-proof.sh` on it, `linux/arm64` under QEMU
emulation; the version tags are set on that digest only when both proofs pass, and the release is
created after.

**Not proven yet**: the bridge variant; the ARP companion started and its `arp.json` read by the
service; an agent over `ssh` to a host; the `icons` command; the arm64 image on real arm64 hardware
(proven under emulation only); the hardening (`read_only`, `cap_drop: [ALL]`) under real
conditions with `ssh` and mDNS.

To check an image: `gh attestation verify oci://ghcr.io/hiteafr/vigie:<version> --repo HiteaFR/vigie`.

## Installation

From a copy of the repository, at a release tag (`git checkout v<version>`): the compose file uses
the published image of that version.

```bash
docker compose pull
docker compose run --rm init               # interactive wizard (terminal)
docker compose up -d
```

Without a config, the service starts anyway, in the "setup needed" mode: the log
(`docker compose logs vigie`) says to run `docker compose run --rm init`. The entry point **never**
creates a password or any other secret.

The wizard's questions and options are described in [Installation](installation.md#setup-wizard-init),
and the keys it writes in [Configuration](configuration.md).

### From source

Build the image yourself under another name, and use that name everywhere (`VIGIE_IMAGE`, in the
shell or in a `.env` file next to `docker-compose.yml`):

```bash
export VIGIE_IMAGE=vigie:local VIGIE_REVISION="$(git rev-parse HEAD)"   # commit shown by /api/healthz
docker compose build
docker compose run --rm init
docker compose up -d
```

## `init` in a container

`init` is a separate service (profile `init`, never started by `up`). It is the only one that mounts
`/etc/vigie` read-write; the service mounts it read-only.

The entry point passes the image paths to the wizard **as explicit options** (`--config
/etc/vigie/config.json --env /etc/vigie/vigie.env --pki /etc/vigie/pki --state /var/lib/vigie`).
That is what lifts its system-path safeguards: `/etc` and `/var/lib` are refused when they come
from a variable, and accepted when given explicitly. An extra option passed after them wins.

Non-interactive (scripts): the secret goes through a variable, never as an argument (`-e NAME`
without a value takes the one from the shell):

```bash
read -rs VIGIE_INIT_ADMIN_PASSWORD; export VIGIE_INIT_ADMIN_PASSWORD
docker compose run --rm -T -e VIGIE_INIT_ADMIN_PASSWORD init --non-interactive --title "Vigie"
unset VIGIE_INIT_ADMIN_PASSWORD
```

Other entry point commands: `docker compose run --rm vigie check-config`,
`docker compose run --rm vigie icons` (downloads the icons of the config into the state volume;
`--force` downloads them all again), and `help`.

## Volumes

Same paths as `deploy/vigie.service.example` (see [systemd](installation.md#systemd)).

| Volume | Path | Content | Service | `init` |
| --- | --- | --- | --- | --- |
| `vigie-config` | `/etc/vigie` | `config.json`, `vigie.env` (0600), `pki/` | read-only | read-write |
| `vigie-state` | `/var/lib/vigie` | SQLite database, icons, `ssh/` (key, `known_hosts`) | read-write | read-write |
| `net-scan` | `/run/net-scan` | `arp.json` from the ARP companion | read-only | — |

`local` agent (report of the machine itself): install `dash-report-local` on the host
(`LOCAL=1 ./agent/dash-report/install.sh …`) and uncomment the read-only `/run/dash-report` mount in
`docker-compose.yml`.

The service is hardened: read-only file system (`/tmp` in a tmpfs), no capabilities,
`no-new-privileges`, `init: true` (signals forwarded, `ssh` processes reaped).

## Update

`git pull` (or `git checkout v<new version>`), then `docker compose pull` and `docker compose up -d`
(from source: `docker compose build` instead of `pull`). The service restarts on the new image; the
database, icons and config stay in the volumes. Read the release notes first: they say when a
config key changes.

## Backup

Stop the service (`docker compose stop vigie`: the SQLite database is closed cleanly), copy both
volumes, then `docker compose start vigie`:

```bash
docker compose stop vigie
docker run --rm -v vigie_vigie-state:/v:ro -v "$PWD":/b debian:bookworm-slim tar -C /v -czf /b/vigie-state.tgz .
docker run --rm -v vigie_vigie-config:/v:ro -v "$PWD":/b debian:bookworm-slim tar -C /v -czf /b/vigie-config.tgz .
docker compose start vigie
```

`vigie_` is the compose project name. `vigie-config.tgz` contains the secrets of `vigie.env`: keep
it as safe as they are.

Restore: extract into empty volumes, with the same ownership (uid 1000).

## Host or bridge mode

The compose file uses `network_mode: host` **by default**. The network module then works in full,
and the safe defaults stay right: the service listens on `127.0.0.1` of the machine, and admin login
works over the loopback.

The bridge variant, `docker-compose.bridge.yml`, goes on top
(`docker compose -f docker-compose.yml -f docker-compose.bridge.yml …`): the port is published on
`127.0.0.1:8088` of the host only, on the fixed subnet `172.31.88.0/24`.

| Feature | Bridge | Host |
| --- | --- | --- |
| Web, API, HTTP, TCP, TLS and DNS probes, widgets, Proxmox, Gitea, Pi-hole, Telegram | yes | yes |
| `ssh` agents, service probe (outbound) | yes (NAT) | yes |
| Neighbors (`ip neigh`) | no (neighbors of the bridge) | yes |
| ARP scan | through the companion (in host mode) | through the companion |
| mDNS (multicast 5353) | no | yes |
| Default gateway (`/proc/net/route`) | the bridge's (wrong) | yes |
| Admin login over the loopback | no: it comes from the bridge gateway | yes |

In bridge mode, admin login comes from `172.31.88.1` (neither the loopback nor a default admin
network). Run `init` with `--listen 0.0.0.0 --admin-cidrs 172.31.88.1/32 --http-login`. Login over
HTTP is acceptable only because the port is published on the host's loopback only; otherwise, use
an HTTPS proxy and `trustedProxies` (see [Behind an HTTPS proxy](installation.md#behind-an-https-proxy)).

Open `http://localhost:8088`; any other name needs `allowedHosts`. To change the subnet (for example
if it conflicts with an existing network), edit `docker-compose.bridge.yml` and change `adminCidrs`
(or the `--admin-cidrs` option) to match.

## Network under Docker

The [network module](network.md) needs host mode: `ip neigh`, mDNS listening and the gateway from
`/proc/net/route` see the real network only that way.

### ARP companion

The `arp` profile runs `net-scan` (from `agent/net-scan/`) in a second container
(`docker/net-scan/Dockerfile`, pinned Debian slim, `arp-scan`), in `network_mode: host`, with
**the `NET_RAW` capability only** (`cap_drop: [ALL]`, `no-new-privileges`, read-only, never
`privileged`).

It scans every 120 s (container variable `NET_SCAN_INTERVAL`, 30 to 3600; the compose file does not
set it) and writes `/run/net-scan/arp.json` (by
rename) to the `net-scan` volume, which the service mounts read-only.

It runs as root **inside** the container, with no other capability. Docker gives no ambient
capabilities to a non-root user, and a file capability on `arp-scan` would be canceled by
`no-new-privileges`. The file, owned by root, is read by the service (uid 1000), which refuses any
file it owns itself.

```bash
cp docker/net-scan.conf.example net-scan.conf      # IFACE and CIDR of the network to scan
docker compose --profile arp up -d
```

`net-scan.conf` takes two keys: `IFACE`, the host interface on the network to scan, and `CIDR`, a
private IPv4 range (10/8, 172.16/12, 192.168/16) with a prefix from 16 to 30.

Then, in `config.json`: `"network": { …, "sources": { "arp": { "file": "/run/net-scan/arp.json" } } }`.

If `net-scan.conf` is missing, the companion does not start (the mount refuses to create a
directory in its place). If the file is invalid, `arp.json` says `"ok":false` and why, and no scan
runs.

### Scan only your own network

**Warning: scanning a network that is not yours may be forbidden.** Run the ARP companion (and the
service probe) only on a network you are responsible for, or with the agreement of its owner. The
service probe (TCP ports, then HTTP) stays disabled until `network.probe.enabled` is `true`.

### `arp-scan` license

`arp-scan` is under the GPL (version 3 or later). The companion image is never published, only built
locally (`docker compose --profile arp up -d` builds it); a published image would have to provide
its sources.

### Proof script

`scripts/docker-proof.sh` runs on a test Docker machine, in a throwaway compose project with a
unique name (no existing container, volume or image is touched): build, start without a config,
non-interactive `init`, healthcheck, admin login over the loopback, volume ownership, restart,
cleanup.

```bash
sh scripts/docker-proof.sh            # or VIGIE_PROOF_PORT=18188 sh scripts/docker-proof.sh
```

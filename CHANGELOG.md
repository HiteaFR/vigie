# Changelog

All notable changes to Vigie are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-24

First release. Vigie was published as a source snapshot on 2026-11-15; this release adds a
published Docker image and the changes listed below. The number continues the private history of
the project (1.0.0 to 1.1.2 were never published).

### Highlights

- **Docker image** `ghcr.io/hiteafr/vigie` for `linux/amd64` and `linux/arm64`, with a signed build
  provenance. `docker-compose.yml` pins the image of its release: `docker compose pull`, then
  `init` and `up` (building from source stays possible, see [docs/docker.md](docs/docker.md)).
- **Readable Telegram messages**: the daily digest, the bot replies and the alert notifications
  were reworked to be read at a glance (sections, one line per item, details in quotes).
- **Release files**: an archive of the agents (`dash-report`, `net-scan`) and its checksums.

### Features

- **Services**: HTTP, TCP, TLS certificate and DNS probes, uptime history, latency, widgets that
  read the API of your apps, bookmarks and favourites.
- **Proxmox**: nodes, guests, storage, SMART and disk wear, failed tasks, backups, per-guest charts,
  through a read-only API token and a pinned CA.
- **Hosts**: the `dash-report` agent (shell, over SSH or local) for file systems, Docker containers,
  systemd units, pending updates, reboot needed, SSH and firewall posture, listening ports.
- **Network**: device inventory (ARP scans, DHCP leases, Pi-hole, Proxmox, mDNS), presence history,
  topology map, alerts for new devices, optional service probe.
- **Updates**: installed versus latest versions, security fixes, end-of-life dates.
- **Alerts**: rules with grace periods and quiet hours, Telegram messages and bot, daily digest,
  acknowledgements and silences, ntfy as a second channel.
- **Plugins**: an internal plugin interface, version 0 and unstable (`apiVersion: 0`, static list,
  no external loading), with the Gitea and ntfy plugins and an example plugin; guide in
  [docs/plugins.md](docs/plugins.md).
- **Install**: `npm run init` or `docker compose run --rm init` writes a working configuration;
  safe defaults (listens on 127.0.0.1, reading the API requires a session, admin login from the
  loopback only).
- **Docker**: image and Compose file, see [docs/docker.md](docs/docker.md). Proven on 2026-11-11
  (amd64, host network mode, init, server), then by the release workflow on each published image
  (amd64, and arm64 under emulation). Not proven yet: the bridge variant, the ARP companion
  running and `arp.json` read, the agent over `ssh` to a host, `icons`, arm64 on real hardware.
- English and French interface, English by default.

### Changed since the source snapshot of 2026-11-15

- **Daily digest**: sections separated by a blank line; alerts sorted by severity then age, alerts of
  the same rule grouped (one title, one line per item, the shared detail once, in italics); beyond
  12 alerts, "... and N more on the cockpit". Silences and incidents as bullet lists. The detail
  lines of the modules (fixes per host, new versions, end of life, services to restart, network)
  in quotes, collapsible beyond 3 lines. Plugins: `host.digestBlocks(slot)` renders the lines per
  module.
- **Bot replies**: `/status` gives a head line ("2 critical, 1 warning") then one line per domain,
  stopped guests in a quote; `/down` has one section per severity, and beyond 25 alerts says how
  many more; `/silences` one block per silence; `/network` the counts, then new devices, MACs to
  confirm and failing sources in separate sections; `/help` groups the commands.
- **Alert notifications**: the rule label is no longer repeated when the title already contains it.
- **Ports**: the TCP port of `tailscaled` listening only on tailnet addresses (Tailscale peerapi,
  random at each start) is shown without a `port_new` alert, like the loopback.
- **Docker**: the client stage of the image is built on the platform of the build machine (its
  output does not depend on the architecture).

### Fixed

- `container_unhealthy` only for a running container: Docker keeps the last health state after a
  stop, so a container stopped on purpose while unhealthy stayed in alert until its restart.

### Dependencies

- Client: React and react-dom 19.3.1, @tanstack/react-query 5.107.1, d3-hierarchy 3.1.3,
  d3-selection 3.0.1, d3-zoom 3.0.1, Tailwind CSS 4.3.5, lucide-react 0.577.0, eslint 10.14.0,
  globals 17.14.0.
- Server: undici 7.30.2.

### Upgrade notes

- From the source snapshot: no configuration change. With Docker, `docker-compose.yml` now names
  the published image: run `docker compose pull` instead of `docker compose build`, or keep
  building with `VIGIE_IMAGE=vigie:local` (see [docs/docker.md](docs/docker.md)).

[Unreleased]: https://github.com/HiteaFR/vigie/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/HiteaFR/vigie/releases/tag/v1.2.0

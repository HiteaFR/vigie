# Changelog

All notable changes to Vigie are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions will follow
[Semantic Versioning](https://semver.org/) from the first release.

## [Unreleased]

First public snapshot. No release has been published yet.

### Added

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
  (amd64, host network mode, init, server). Not proven yet: the bridge variant, the ARP companion
  running and `arp.json` read, the agent over `ssh` to a host, `icons`, arm64.
- English and French interface, English by default.

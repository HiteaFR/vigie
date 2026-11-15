# Versions and updates

The `/updates` view and its cockpit widget are **for information only**: nothing is ever applied
from the dashboard. Apps marked `"auto": true` in `services[].version`, and Home Assistant
entities that update automatically, are flagged "auto-update" and never announced.

## What is tracked

- Apps declared with `services[].version`. The installed version comes from the app's API, a
  regular expression or the [agent](agent.md); the latest one from GitHub, gitea.com, PyPI or a
  JSON URL.
- Home Assistant `update.*` entities (`"version": { "from": "ha" }`).
- Container images: the tag's digest, checked with a `HEAD` request on the registry, and newer
  tags of the same shape (`16-alpine` → `18-alpine`).
- Host operating systems and the Node, PHP, MariaDB and PostgreSQL runtimes, through
  [endoflife.date](https://endoflife.date/).
- Proxmox VE: `pve-manager` compared with the public apt index of `download.proxmox.com`, and the
  end of life of its branch.
- apt packages (from the agent).
- Gitea repositories whose HEAD has no successful run.

Plugins can add version sources: see [Writing a plugin](plugins.md#extensions).

## Refresh rate

Everything is recomputed every 10 minutes, but each upstream source is only queried again when
its cache expires (`http_cache`: 6 hours for forges and registries, 12 to 24 hours for Proxmox and
endoflife.date), with `If-None-Match`. For example, 15 GitHub repositories cost fewer than 70
requests a day. `GITHUB_TOKEN` (a fine-grained personal access token with no permission) is
optional.

## Notifications

Each new version is announced **only once**, in the digest (`versions` table, `notified_latest`).
Two alerts go through the alert engine, as warnings and without reminders:

- `security_release`: the release notes of the skipped versions mention a CVE, a GHSA or a
  security fix. One alert per version.
- `eol`: the end of life has passed. It is info when the end of life falls within the next 90
  days.

## Automatic security updates

See [automatic security updates](agent.md#automatic-security-updates) for how hosts are checked.
On this page:

- Each "apt packages" row shows the host's automatic-update state: active, disabled, failed, or
  unknown (agent v6). Its detail shows the last run and the packages applied.
- A summary row lists hosts by state, up-to-date ones included.
- The host drawer shows the same state, in its apt packages section.
- The digest says "N security fixes applied last night on M hosts", then one line per host (5
  packages at most), based on the last run within 24 hours. Without any fix, a line says so.
  Without any host on automatic updates, nothing is shown.
- A host whose last slow report is more than 2 hours old (2 cycles) is not counted. It is listed
  as "without a recent report", so that silence is not mistaken for a night without fixes.
- With automatic updates on, pending fixes only show up here when they are stuck
  (`security_updates`).

## Locally built images

An image with no registry digest in the agent's slow inventory is "local": the registry is never
called, and the image is never in error.

Right after a rebuild, the fast report carries an `imageId` that the hourly inventory does not
know yet. If the reference has no explicit registry (implicit docker.io, such as `my-api`) and
Docker Hub answers 401 despite the anonymous token (the repository does not exist), the image is
also local. A 401 is never cached nor counted as a registry outage: it is asked again at the next
tick.

These cases are still errors:

- a registry that answers 5xx or 429, or cannot be reached;
- a refused token;
- a 404 ("tag missing from the registry": the repository exists);
- a 401 from an explicit registry (`ghcr.io/…`, `docker.io/…`), or for an image that the
  inventory knows with a digest.

## Hosts whose containers are not tracked

With `"updates": { "containers": false }` on a host in `hosts[]`, none of its containers is tracked
here: no `docker:` component, no registry call, nothing in the counters, in the "Updates" badge of
the menu, in the cockpit or in the digest. This suits a development workstation whose containers
are started by hand.

The host's OS, apt packages, runtimes, and the apps declared with `services[].version` are still
tracked. Nothing else changes: container alerts (`container_unhealthy`, `container_restarting`,
`container_down`), the host drawer (containers section), the network module and the agent's
inventory.

## Ignore, snooze, pin

From the `/updates` page, an admin can ignore a version, snooze a component until a date (at most
400 days ahead), or pin it to its major version. A reason (3 to 200 characters) is required. These
decisions are stored in the database.

Durable decisions can also live in `config.json`, under `updates.ignore`; the page shows them
read-only. Each entry has:

- `id`: the component id, shown in the detail of a row; a trailing `*` is accepted;
- one of `version` (ignore this version, until the next one), `until` (snooze, as `YYYY-MM-DD`)
  or `pin: "major"` (only look at the same major version);
- an optional `reason`.

```json
"updates": {
  "ignore": [
    { "id": "docker:server-1/postgres", "pin": "major", "reason": "Waiting for the v3 migration guide" }
  ]
}
```

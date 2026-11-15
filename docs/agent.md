# The dash-report agent (hosts and Docker)

Hosts marked `"agent": "ssh"` in `config.json` are read over SSH:

- every 60 s (the "fast" report): system, filesystems, systemd, reboot state, containers, and
  processes killed by earlyoom (v9);
- every hour (the "slow" report): apt, images, and the versions of allow-listed packages.

The dashboard connects with the key `/var/lib/vigie/ssh/id_ed25519`, which runs a forced
command on the host, and checks the host against a pinned `known_hosts` in the same folder.

The host that runs the dashboard itself can use `"agent": "local"`: a root timer writes
`/run/dash-report/*.json`, and the dashboard reads those files.

The script, the installer, the test bench and the audits are in `agent/dash-report/`, documented
in [`agent/README.md`](../agent/README.md). The repository is the single source of the agent. If
you keep your own copy on a host, compare it with the repository by the sha256 of the script body,
as `agent/README.md` explains.

Per-host options (`hosts[].alerts.ports`, `hosts[].alerts.diskFreeMinGB`,
`hosts[].updates.containers`) are described in [Configuration](configuration.md).

## View

`/infra` shows a badge per guest: containers, units, apt, reboot. A guest without an agent shows
"not instrumented". `?h=<id>` opens a host's detail.

## Alerts

Default thresholds come from the `alerts` block of `config.json`. See [Alerts](alerts.md) for the
engine, severities and notifications.

- `guest_disk`: disk usage at 85 % (warning) and 95 % (critical), set by `alerts.disk`. For an LXC
  container declared **without** an agent, the root filesystem is read from Proxmox, with the
  same key `guest_disk:<host>:/`, the same thresholds, and "per Proxmox" in the detail. Never for
  a VM: Proxmox cannot see its disk.
- `container_unhealthy`.
- `container_restarting`: a restart loop, or 3 restarts within 15 minutes.
- `container_down`: a container declared by `services[].container` (container name or compose
  service) is missing from the agent's report, or has not been `running` for 2 minutes. It takes
  the host's severity. Without a fresh report that has a Docker block, nothing is raised. It is the
  parent of the service's `service_down`, and is hidden by `container_restarting` when the
  container is in a restart loop. A silence or a maintenance window on a service that declares the
  container also covers this alert.
- `systemd_failed`: a failed unit, or a tracked unit that is inactive. **Warning**, or
  **critical** when one of them is listed in `alerts.criticalUnits`; critical units are listed
  first in the detail.
- `apt_stale`: package lists older than `alerts.aptMaxAgeDays` (7 days).
- `security_updates` and `reboot_required`: info, digest only. `security_updates` changes meaning
  when automatic updates are on (see below).
- `agent_unreachable`: after 5 minutes; immediately if the host key changes.

## Automatic security updates

**The OS patches, the agent watches.** Security fixes are meant to be applied by
`unattended-upgrades`: security updates only, no automatic reboot, held packages respected.
`dash-report` stays read-only, and the dashboard only checks that these updates actually run.

From version 7, the agent adds an `autoUpdate` block to the slow report: `installed`, `enabled`,
`securityOnly`, `lastRunAt`, `lastResult`, and `applied` (at most 50 packages from the last run).
The block is filtered field by field, and read only from agents v7 and later.

`securityOnly` is true only when the host says so through `/etc/dash-report.conf` (agent v9):
`SECURITY_ONLY_FILE` is the absolute path of the apt configuration file that limits automatic
updates to security fixes, and `SECURITY_ONLY_MARK` a fixed text this file must contain (empty: the
file only has to exist). `install.sh` writes this file when it is given `SECURITY_ONLY_FILE` and
`SECURITY_ONLY_MARK`; the report reads it with `sed` and never executes it. Without it,
`securityOnly` is false, and `autoupdate_off` says that updates are not limited to security fixes.

Rules for a host with an agent v7 or later (same severity in prod and dev; parents: the agent,
then the host):

- `autoupdate_off` (warning): unattended-upgrades is missing, automatic updates are disabled, or
  they are not limited to security updates. The detail says which.
- `autoupdate_failed` (warning): the last run failed, or is older than
  `alerts.autoUpdateMaxAgeHours` (48 h).
  - When no run has been recorded yet (a freshly set-up host), nothing is shown, not even as
    pending, as long as automatic updates have been seen active for less than that same delay.
    After that, the alert is raised with no further wait.
  - "Seen active since" is the first time the dashboard saw them active. It is stored in the
    database (kv `agentmemory.autoActiveSince`, read again at restart) and cleared when the host
    is no longer active (automatic updates turned off, or agent older than v7).
  - Never raised while automatic updates are off: `autoupdate_off` is enough.
- `security_updates` while automatic updates are active: **warning**, only when a security fix
  (from a `-security` suite, excluding `apt-mark hold`) has been pending for more than
  `alerts.securityPendingHours` (48 h), which means it is stuck.
  - The age counts from the first time each package was seen pending on each host. It is stored
    in the database (`apt_security_pending`): neither a restart of the service nor a new candidate
    version resets it. Age only counts while automatic updates are active; a host's rows are
    deleted as soon as they are not.
  - **When this feature first runs**, everything pending starts from "now": nothing is reported
    as stuck for the first 48 hours.
  - A package from another repository (Firefox from Mozilla's repository, for example) is not a
    security fix in the report's sense, and is never "stuck".
  - Snoozing or ignoring a package on the `/updates` page still takes precedence.
- Agent v6, or no `autoUpdate` block: the state is "unknown", none of these alerts is raised, and
  `security_updates` keeps its former behavior (info as soon as a fix is pending).

## Agent v8

Version 8 adds five fields. They are filtered field by field (bounds and regular expressions) and
read only from agents v8 and later; v7 and v6 bring nothing new (no alert, "unknown" in the UI).

- Fast report: `fs[].inodes` (`{ total, used }`, `null` if the filesystem does not count inodes).
- Slow report, after `versions`:
  - `restart`: systemd units with a process that uses a replaced library (containers excluded, 50
    at most), and the number of such processes, sessions included;
  - `posture`: SSH (`permitRootLogin`, `passwordAuth`) and firewall (`type`, and `active`, which
    means a chain hooked on input filters traffic; Docker's rules do not count);
  - `listening`: listening ports (protocol, address, port, process or `null`; 128 at most). A
    missing list means unknown, and the port memory is not seeded;
  - `time.ntpSynced`: in the slow report, because calling `timedatectl` every minute would flood
    the journal. In an LXC container, this reflects the host kernel's clock.

The report is parsed as a whole (it spans several lines). Every rule below has the agent, then the
host, as parents.

**Posture and ports are admin only.** Without a session, `/api/agents` serves neither `posture`
nor `listening`, not even a summary, and the host drawer says the data is for admins only (like
the ports in the network module). The exception is the detail of the `posture_regression` and
`port_new` alerts, which is readable in `/api/alerts`, the bell and Telegram (regressions and new
ports only).

### `restart_required`

Info, like `reboot_required`: units that need a restart, 5 at most in the detail. The digest has a
"🔁 Services to restart" line (outside the list of alerts), and the host drawer shows the list. On
a host where needrestart restarts services by itself, only what it left behind remains.

### `posture_regression`

Warning, same severity in prod and dev, one key per host. Raised when one of the **baseline**
criteria drifts **after a v8 report has already seen it compliant**:

- `PermitRootLogin` is `no`, `prohibit-password` or `forced-commands-only`;
- `PasswordAuthentication` is `no`;
- a firewall is active inside the host.

The "already seen compliant" memory is stored in the database (`host_posture`), per host and per
criterion. A drift present from the first v8 report is shown (as a badge) without an alert, so a
deployment does not cause a flood of alerts. The same method applies everywhere: an LXC container
without its own firewall shows the drift, just like a VM.

**Accepting the drift** (admin, with a reason, audited): it shows as "accepted" (reason on hover)
and the alert resolves. The acceptance lapses as soon as the criterion is compliant again, so a
later regression alerts again. "Remove the acceptance" (with a reason) lifts it.

### `port_new:<host>:<proto>/<port>`

Info: a port listening on a non-local address that has never been seen on the host since its first
v8 report. Ports present in that first report are known from the start, so there is no flood.

- Ports on `127.0.0.0/8`, `::1` or `::ffff:127.x.y.z` are shown and never alert.
- **Known** (admin, with a reason, audited) resolves the alert.
- A port that stops listening resolves on its own as soon as a fresh v8 slow report (less than 3
  hours old) no longer shows it. Without fresh data (agent unreachable, stale report, agent older
  than v8, ports not reported), the alert stays as it is.
- The resolution of an info alert goes to the digest, never into an immediate message.
- All ports still open are tracked, plus at most 32 closed ports per host.
- A port that comes back without having been marked Known alerts again. A port closed and
  reopened within 7 days stays known; after that, it is new again (nothing is ignored).
- The memory is stored in the database (`host_ports`). With an admin session, ports are shown in
  the host drawer and, read-only, on the linked device's page in the network module.

A host with `"alerts": { "ports": false }` (for example a development workstation whose ports come
and go) gets no `port_new` signal at all, neither raised nor closed. The port memory, its display
and Known do not change, nor do `posture_regression` and the host's other alerts. A `port_new`
already raised when the option is set has no signal any more: the engine forgets it silently 10
minutes later, like any alert without a signal. The incident is closed and shows in the next
digest's "24 h: incidents resolved" line.

### `disk_free:<host>:/`

Warning in prod and dev, with no critical level. Raised when free space on the root filesystem
falls strictly below `hosts[].alerts.diskFreeMinGB`, measured from the `avail` field of the fast
report (in bytes, always read by the agent). It clears when free space goes back up to the
threshold + 1 GB (hysteresis), and the state is kept in between.

- Separate key from `guest_disk`: both can be raised.
- Root filesystem only: a threshold shared by all mounts would fire on a small `/boot/efi`.
- Detail: "11.9 GB free (threshold: 12 GB)", with free space rounded down.
- In the digest, it is listed with the current alerts.

Example: a development workstation whose builds must stop below 12 GB free.

### `guest_inodes:<host>:<mount point>`

Inode usage, as a separate key from `guest_disk`, with the same thresholds (`alerts.disk`), the
same hysteresis and the same severity. Unknown inodes or a total of zero (btrfs, tmpfs): no alert.

### `time_unsynced`

Warning after 30 minutes: the clock is not synchronized by NTP. It is read from the slow report, so
it reacts within 1 to 2 hours. Unknown state: no alert.

The host drawer shows "synchronized", "not synchronized" or "unknown" for the clock, and the inodes
under the filesystems.

## Agent v9

Version 9 adds one field to the fast report, caps every string and list it reads from a command,
validates the patterns of `/etc/dash-report.units`, and reads `securityOnly` from
`/etc/dash-report.conf` (see [Automatic security updates](#automatic-security-updates)). The
dashboard accepts v8 and v9 reports side by side while a fleet is upgraded; a v8 report simply has
no `oom` field.

- `oom` (fast report): processes killed by [earlyoom](https://github.com/rfjakob/earlyoom) over the
  last hour, read from the journal of `earlyoom.service`: `windowSec` (3600), `kills` (the number of
  distinct processes named by `sending SIGTERM to process` and `sending SIGKILL to process` lines: a
  TERM then a KILL of the same process count once),
  `lastAt` (Unix time of the last one) and `lastProcess` (its name, reduced to `[A-Za-z0-9._-]`
  with other characters replaced by `?`, 32 at most). A host without earlyoom (unit unknown to
  systemd), without `journalctl`, or whose journal cannot be read reports `null`, never an error.
- Watched units: a line of `/etc/dash-report.units` is used only if it is made of letters, digits
  and `@ . _ : * -` (100 characters at most, the rule of `install.sh`); other lines are ignored.
  64 patterns and 100 watched units at most, 50 failed units at most.
- Bounds: each string built from a command is capped at 256 bytes, and mount points lose control
  characters, `"` and `\` (like any other string); Docker strings are capped by
  their template (names 128 characters, image 256, labels 128, 20 tags and 20 digests per image);
  file systems 64, images 300, versions 50.
- The kernel reason of `reboot_required` is sent in English (`kernel <installed> installed,
  <running> running`) and shown in the language of the instance.

### `oom_kill`

Warning (prod and dev): earlyoom killed at least one process during the last hour. The detail gives
the number of processes killed and the name of the last one. The alert resolves by itself an hour
after the last kill. `null` (no earlyoom) or an agent older than v9: no alert.

## Nothing sensitive

The report is filtered again on the dashboard side against an allow-list, and `npm test` checks that
no `Env`, `Mounts` or `Cmd` gets through.

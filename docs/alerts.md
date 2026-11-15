# Alerts and notifications

Vigie turns the state of its probes and sources into alerts. It shows them on the **Alerts**
page (`/alerts`) and sends them to Telegram, and to ntfy if you configure it. A daily digest
collects what was held back overnight. An interactive Telegram bot lets you read the state,
acknowledge alerts and set silences.

## Contents

- [How alerts are evaluated](#how-alerts-are-evaluated)
- [Rules](#rules)
- [Noise control](#noise-control)
- [Delivery policy](#delivery-policy)
- [Notification channels](#notification-channels)
- [Configuration](#configuration)
- [ntfy](#ntfy)
- [Telegram setup](#telegram-setup)
- [The Telegram bot](#the-telegram-bot)
- [Previewing rules before a deployment](#previewing-rules-before-a-deployment)

## How alerts are evaluated

The engine evaluates its rules every 15 seconds. It reads the state of the probes and of the
sources, which are collected in the background:

| Source | Refresh |
| --- | --- |
| Proxmox clusters and nodes | 60 s |
| CI runners | 60 s |
| Gitea | 2 min |
| Backups | 10 min |
| SMART data | 30 min |

Each alert has a key of the form `rule:entity`. It goes from *pending* to *firing* once its
condition has held long enough, and back to *ok* when the condition clears. The state is stored
in the database, so a restart or a redeployment never sends the same notification again.

## Rules

Core rules:

| Rule | Condition | Severity |
| --- | --- | --- |
| `service_down` | A probe (other than `tls`) fails 3 times in a row. It recovers after 2 successes. | prod: critical, dev: warning |
| `cert_expiry` | Certificate expires in less than 21 days (warning) or 7 days (critical). | — |
| `pve_unreachable` | The Proxmox API has been failing for 2 minutes. | network error: depends on the environment; API error (401…): warning |
| `guest_stopped` | A guest declared in `hosts[]` has not been `running` for 90 s. | depends on the environment |
| `storage_usage` | Storage at 80 % or more (warning), 90 % or more (critical). | — |
| `backup_late` / `backup_failed` | Last backup older than 26 h / last backup task failed. | warning / depends on the environment |
| `ci_failed` | The last run on the default branch failed. | warning |
| `runner_offline` | A runner has been offline for 10 minutes. | warning |
| `source_error` | Gitea, the runners or the backups have been unreadable for 10 minutes. Gitea and the runners count only when they are configured. | warning |
| `not_backed_up` | A declared guest is covered by no active backup job (excluded, or its job is disabled). Turned off per guest with `hosts[].alerts.backups: false`, as is `backup_late`. | warning |
| `node_mem` | A node's RAM, cache excluded, at 90 % or more (warning), 95 % or more (critical), for 5 minutes. | depends on the environment |
| `node_swap` | A node's swap at 50 % or more for 10 minutes. | warning |
| `smart_failed` | A disk's SMART status is something other than PASSED/OK. | depends on the environment |
| `disk_wear` | An SSD has 10 % or less of its life left. | warning |
| `disk_temp` | A node disk at 75 °C or more (warning), 80 °C or more (critical). Resolves below 73 °C. Unknown temperature: no alert. | warning; at 80 °C or more: prod critical, dev warning |
| `vpn_down` | A service's VPN tunnel (`vpn`) is not `running`, or its widget is in error, for 2 minutes. | warning |
| `vpn_leak` | The tunnel's public IP belongs to your home ISP, or its country is not in `countries`. | prod: critical, dev: warning |
| `vpn_noinfo` | The tunnel is up but reports neither country nor organization for its public IP, for 15 minutes. See [VPN](#vpn). | warning (prod and dev) |
| `guest_undeclared` | A Proxmox guest is missing from `hosts[]` and from `proxmox[].ignoreGuests`. See [Proxmox](proxmox.md#undeclared-guests). | info |
| `oom_kill` | earlyoom killed at least one process during the last hour (agent v9). See [the agent](agent.md#oom_kill). | warning (prod and dev) |
| `channel_error` | A notification channel (Telegram, ntfy) has been failing for 10 minutes. See [Notification channels](#notification-channels). | warning |
| `plugin_error:<id>` | A plugin is in error (its hook and last message are on the **Integrations** page, `/integrations`). | warning |

"Depends on the environment" means critical for a prod host or service and warning for a dev
one. Dev is always capped at warning.

The agent, the version tracker and the network module add their own rules (for example
`systemd_failed`, `disk_free`, `port_new`, `oom_kill`, `security_updates`, `net_new`). They are described
with those features: [agent](agent.md), [updates](updates.md), [network](network.md).

### Dependencies

If a Proxmox cluster is unreachable *at the network level*, or a guest is stopped, the alerts
of the services that depend on it are masked: they stay visible in the UI but are not notified.
The parent alert's message lists the affected services. If the problem is still there when the
mask lifts, the alert is notified at that moment.

## Noise control

- **Startup grace period**: no alert fires during the first 120 seconds after a start.
- **Persistent state**: a redeployment never sends a notification again.
- **Grouping**: messages are grouped over 15 seconds.
- **Flapping**: 4 state changes within 30 minutes mark an alert as unstable. It sends one
  notification, then stays quiet until it has been stable for 30 minutes.
- **Reminders**: every 6 hours for a critical alert, every 24 hours for a warning.
- **Recoveries** are sent silently.

## Delivery policy

- **Critical**: sent at once, with sound, at any hour. Reminders are sent without sound.
- **Warning**: sent at once, without sound. During quiet hours (23:00–07:30 by default) it is
  held for the **digest** (08:00 by default). For a dev host or service, a warning is sent only
  during business hours (Monday to Friday, 08:00–19:00 by default), otherwise it goes to the
  digest. A reminder that falls outside these hours is skipped.
- **Info**: goes to the digest, with no reminders.
- **Recoveries** follow the path of the opening message: silent and immediate if the opening
  was sent at once, in the digest otherwise.

Messages never contain an IP address. IPs are masked even inside error messages.

## Notification channels

Telegram is the main channel. **ntfy** is a second channel, provided by a plugin: it is active
only when the `plugins.ntfy` block is present. Without it, nothing is sent to ntfy.

- Both channels follow the same policy: quiet hours, digest, grouping, reminders.
- Each channel has its own queue and its own retries. If one channel is down, it blocks neither
  the other channel nor the queue.
- A channel receives only what was created after it was set up.
- A `Retry-After` from a channel is capped at 15 minutes.
- The state of each channel is in `notifier.channels` of `GET /api/alerts`: configured, pending
  messages, last delivery, last error.
- If a channel keeps failing, the `channel_error` alert fires. It is sent on all channels, and
  the failed channel receives it when it comes back. With Telegram alone, that is how you learn
  that it was down.
- The bot (commands, **🔕 1 h** and **✅ Ack** buttons) is specific to Telegram. ntfy receives
  plain text.

## Configuration

Everything under `alerts` in `config.json` is optional:

```json
"alerts": { "dashboardUrl": "https://vigie.example.net", "quietHours": { "start": "23:00", "end": "07:30" },
            "digestAt": "08:00", "businessHours": { "start": "08:00", "end": "19:00", "days": [1,2,3,4,5] } },
"maintenance": [ { "match": { "host": "nas" }, "start": "04:30", "end": "05:00", "reason": "housekeeping" } ]
```

- `dashboardUrl` is used for links in the messages. Its host name is also accepted in the
  `Host` header (see [Security](security.md#allowed-host-names)).
- Times are `HH:MM`, in `alerts.timezone`. `days` uses 1 for Monday to 7 for Sunday.
- `maintenance[]` is a recurring window during which the matching alerts are masked (visible,
  not notified). `match` takes `host`, `service` and `rule`; it needs at least one, and all
  those present must match. `reason` is optional and shown in the UI.

Defaults (from the schema in `server/lib/config.js`):

| Key | Default | Meaning |
| --- | --- | --- |
| `timezone` | `Europe/Paris` | Time zone for quiet hours, business hours and the digest. |
| `dashboardUrl` | — | Base URL for links in messages. |
| `quietHours` | `23:00`–`07:30` | Warnings held for the digest. |
| `businessHours` | `08:00`–`19:00`, days 1–5 | When dev warnings are sent. |
| `digestAt` | `08:00` | Time of the daily digest. |
| `startupGraceSec` | `120` | Grace period after a start. |
| `failAfter` / `recoverAfter` | `3` / `2` | Probe failures before `service_down`, successes before recovery. |
| `repeat` | `{ "critical": "6h", "warning": "24h" }` | Reminder intervals. |
| `backupMaxAgeHours` | `26` | `backup_late` threshold. |
| `storage` | `{ "warnPct": 80, "critPct": 90 }` | `storage_usage` thresholds. |
| `disk` | `{ "warnPct": 85, "critPct": 95 }` | Filesystem thresholds for hosts with the agent. |
| `aptMaxAgeDays` | `7` | Age of the last apt update before it is stale. |
| `autoUpdateMaxAgeHours` | `48` | Automatic security updates: maximum age of the last run. |
| `securityPendingHours` | `48` | Automatic security updates: age from which a pending fix counts as stuck. |
| `criticalUnits` | `[]` | systemd units whose failure is critical (see below). |
| `nodeMem` | `{ "warnPct": 90, "critPct": 95 }` | `node_mem` thresholds. |
| `nodeSwap` | `{ "warnPct": 50 }` | `node_swap` threshold. |
| `diskWearMinPct` | `10` | `disk_wear` threshold (SSD life left). |
| `diskTemp` | `{ "warn": 75, "crit": 80 }` | `disk_temp` thresholds. |

`autoUpdateMaxAgeHours` and `securityPendingHours` are in hours and must be strictly positive.

### Essential systemd units

`criticalUnits` lists the systemd units whose failure is critical, on every host. Give the exact
name, or the name followed by `.service`. Any other failed unit (logrotate, timers, tools) is a
warning. The list is empty by default: each instance declares its own, for example:

```json
"alerts": { "criticalUnits": ["unbound", "traefik", "docker", "ssh", "nftables"] }
```

### Disk temperature

`"alerts": { "diskTemp": { "warn": 75, "crit": 80 } }`, in °C, with `warn` lower than `crit`.
The same thresholds apply to all disks of all nodes. The alert has a 2 °C hysteresis: it
resolves below `warn` − 2.

### VPN

A service can declare the VPN tunnel it runs through. The only type is `gluetun`. Vigie reads
the fields of **the service's own widget** and makes no extra request:

```json
"vpn": { "type": "gluetun", "homeIsp": "Example Telecom", "countries": ["Netherlands", "Sweden"] }
```

- `homeIsp` (required, the main protection): if the organization of the public IP
  (`/v1/publicip/ip`, field `organization`) contains this text, case ignored, it is a leak.
- `countries` (optional): any other exit country is a leak.
- The widget must have the text fields `/v1/vpn/status` (`status`) and `/v1/publicip/ip`
  (`organization`, plus `country` when you set `countries`).
- A widget in error (key refused, API changed) raises `vpn_down` with the error as detail, so
  monitoring never goes silent.
- An unreachable control server stays a `service_down`. It is the parent of the VPN rules,
  together with the container and the host.
- The control server probe sends no key and expects a 401 (`expect.status`). One 401 per minute
  in the Gluetun log, coming from Vigie's address, is normal.

`vpn_noinfo` (warning, same severity in prod and dev, after 15 minutes): the tunnel is
`running` and the widget is fresh and error-free, but the public IP has neither a country nor
an organization. This happens when Gluetun's public IP lookup has expired: Gluetun does not
retry on its own. Without this information `vpn_leak` would be blind without saying so. It
uses the same widget fields and makes no extra request. If only one of the two fields is empty,
there is no alert (`vpn_leak` can still judge). Its parents are those of `vpn_leak`, plus
`vpn_down`: a stopped tunnel is reported by `vpn_down`.

### Per service or host

On a service or a host: `"alerts": { "mute": true }` or `"alerts": { "severity": "warning" }`.
Dev stays capped at warning.

## ntfy

The ntfy plugin publishes JSON to the root of the server: plain text, a title (the first line),
a priority based on the severity (1 to 5) and tags. The access token is optional. Put it in
`NTFY_TOKEN` in the environment file, never in `config.json`. It is sent as
`Authorization: Bearer`.

```json
"plugins": { "ntfy": { "url": "https://ntfy.example.net", "topic": "vigie",
  "priorities": { "critical": 5, "warning": 4, "info": 3, "other": 3 },
  "minSeverity": "info", "untyped": true } }
```

- `url`: the ntfy server, `http://` or `https://`.
- `topic`: letters, digits, `-` and `_`, 64 characters at most.
- `priorities`: priority per severity. `other` is the priority of messages without a severity.
  The values above are the defaults.
- `minSeverity` (default `info`): below this severity, nothing is sent to ntfy.
- `untyped` (default `true`): whether messages without a severity (digest, acknowledgements,
  test messages) are sent.

Plugins and their configuration are described in [plugins.md](plugins.md).

## Telegram setup

Environment variables (in the environment file, never in `config.json`):

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token of the bot (from BotFather). |
| `TELEGRAM_CHAT_ID` | Chat that receives the alerts and the only chat the bot obeys. |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram account IDs allowed to use the bot commands. |
| `HEALTHCHECKS_PING_URL` | Dead man's switch: Vigie pings this URL every minute while the alert engine runs, and a service such as healthchecks.io warns you when the pings stop. |
| `ALERTS_DRY_RUN=1` | Logs the notifications instead of sending them (also disables the bot). |
| `BOT_DISABLED=1` | Disables the bot (for a test instance). |

Without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, alerts are visible in the dashboard only.

To find the IDs and test the setup, load the environment file, then run the helper scripts from
the `server/` directory:

```bash
cd /opt/vigie/server && set -a && . /etc/vigie/vigie.env && set +a
node scripts/telegram-chatid.js   # write to the bot first: prints chat.id and from.id
CONFIG_PATH=/etc/vigie/config.json node scripts/notify-test.js   # sends a test message
```

`chat.id` goes in `TELEGRAM_CHAT_ID`, `from.id` in `TELEGRAM_ALLOWED_USER_IDS`. The token is
never printed. Adjust the paths to your installation (see [Deployment](deployment.md)).

## The Telegram bot

The bot uses long polling (`getUpdates`): nothing is exposed to the Internet.

### Commands

| Command | Action |
| --- | --- |
| `/status` | Global status, one line per area. |
| `/down` | Ongoing alerts, with their number. |
| `/ack <number\|key> <reason>` | Acknowledge an alert (stops reminders), e.g. `/ack #12 disk replaced`. |
| `/unack <number\|key>` | Remove an acknowledgement. |
| `/mute <target> <duration> <reason>` | Set a silence, e.g. `/mute web-1 2h migration`. |
| `/unmute <number>` | Lift a silence. |
| `/silences` | Active silences. |
| `/digest` | The digest, now. |
| `/refresh` | Run all collections again (agent, probes, Proxmox, versions), once per minute at most. |
| `/network` | LAN devices: new ones, MACs to confirm. |
| `/device <text>` | Find a device by name, MAC, vendor or exact IP. |
| `/known <id> <reason>` | Confirm a new device or a device to review. |
| `/help` | Help. |

- The `/mute` target is an alert number (`#12`), a host, a service, a rule or an alert key.
  The duration is a number followed by `m`, `min`, `h` or `d` (`30m`, `2h`, `3d`), 30 days at
  most.
- A reason is 3 characters or more.
- The older French names `/reseau`, `/appareil` and `/connu` are still accepted, with the same
  arguments and the same answer.
- `/network`, `/device` and `/known` need the network module.

### Buttons

Alert messages carry two buttons: **✅ Ack** and **🔕 1 h** (silence for one hour). Network
notifications carry **✅ Known**, **✅ Same device** and **✂️ Detach**. Each button asks for the
reason as a reply to its message. The prompt expires after 10 minutes. The state is checked
again when you answer, so a replayed or outdated button does nothing.

### Who the bot obeys

- Only the chat `TELEGRAM_CHAT_ID` **and** the accounts in `TELEGRAM_ALLOWED_USER_IDS`. Any
  other message is ignored without an answer and written to the audit log.
- The bot runs only when the token, the chat and the allowed accounts are set, and is off in
  dry-run mode or with `BOT_DISABLED=1`.
- For development, use a **separate bot** (another token). Two processes reading the same bot
  get in each other's way (HTTP 409).

What the bot can change, and how actions are logged, is described in
[Security](security.md#write-actions).

## Previewing rules before a deployment

`alerts-preview.mjs` simulates the rules on the real state of a running instance and sends
nothing:

```bash
cd server && node scripts/alerts-preview.mjs --api http://192.0.2.10:8088 [--config ../config.json] [--all]
```

- `--api`: address of the instance (default `http://127.0.0.1:8088`). It is never read from
  the environment.
- `--config`: the config to apply (default: `config.json` at the root of the repository).
- `--all`: details for every rule, not only the listed ones.

The script reads the API with GET requests only and without a session, so the target instance
needs `security.anonymousRead`. It reads `/api/agents`, `/api/cluster`, `/api/services`
(probes and widgets), `/api/backups` and `/api/proxmox` (node disks). It applies the rules of
the repository (the same code as the engine) with the given config. For each rule it lists the
alerts that would fire: severity, detail, and the parents that would mask them. There is no
database, no engine and no notifier, so nothing can be sent.

Always listed: `systemd_failed`, `guest_disk`, `vpn_down`, `vpn_leak`, `vpn_noinfo`,
`guest_undeclared`, `autoupdate_off`, `autoupdate_failed`, `restart_required`, `guest_inodes`,
`time_unsynced`, `disk_temp` and `container_down`. Other rules (for example `smart_failed` and
`disk_wear`) are counted under "other rules"; `--all` shows them.

Run it before declaring a new `services[].container`: `container_down` is simulated from the
containers in `/api/agents`.

Not simulated:

- runners, Gitea, node memory and swap, the network module and versions (their sources are not
  read);
- `security_updates` in automatic update mode, and the "no run recorded" case of
  `autoupdate_failed`: that history lives in the instance's database;
- `posture_regression` and `port_new`: the API read without a session serves neither the
  posture nor the listening ports, and their memory lives in the instance's database.

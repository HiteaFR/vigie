# Security model

Vigie is mostly read-only. It reads Proxmox, the agents, the probes and the other sources; it
never changes a machine. The only writes concern **its own state**: acknowledgements, silences,
update decisions, accepted posture deviations, known ports and devices. They require an admin
session.

This page describes who can read, who can write, and what protects each step. The keys are
described in detail in [configuration.md](configuration.md): see
[Listening and security](configuration.md#listening-and-security),
[Host names and proxies](configuration.md#host-names-and-proxies) and
[Framing and security headers](configuration.md#framing-and-security-headers).

## Contents

- [Safe defaults](#safe-defaults)
- [Reading the API](#reading-the-api)
- [Admin session](#admin-session)
- [Logging in](#logging-in)
- [Write actions](#write-actions)
- [Allowed host names](#allowed-host-names)
- [Trusted proxies](#trusted-proxies)
- [Response headers](#response-headers)
- [Errors](#errors)
- [Audit log](#audit-log)
- [Telegram bot](#telegram-bot)

## Safe defaults

Without any security setting, a new installation:

- listens on `127.0.0.1` only;
- requires a session to read the API;
- refuses an admin login over plain HTTP, except from the loopback;
- accepts the admin login and writes from the loopback only.

| Setting | Default | Environment variable | Effect |
| --- | --- | --- | --- |
| `listenHost` | `127.0.0.1` | `LISTEN_HOST` | Listen address. `"::"` listens on all interfaces, dual stack (IPv6 and IPv4). |
| `security.anonymousRead` | `false` | — | `true`: the API can be read without a session. |
| `security.httpLogin` | `false` | — | `true`: admin login accepted over HTTP from the network. |
| `security.adminCidrs` | `["127.0.0.1/32"]` (`::1` included) | `ADMIN_ALLOWED_CIDRS` (comma-separated) | Networks allowed to log in and write. IPv4 addresses or `a.b.c.d/nn`. |
| `allowedHosts` | `[]` | — | Extra names accepted in the `Host` header (see [below](#allowed-host-names)). |
| `trustedProxies` | `[]` | — | Proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` are read (see [below](#trusted-proxies)). |
| `frameAncestors` | `[]` | — | Origins allowed to show Vigie in a frame. Empty: no frame at all. |

Priority: a **non-empty** environment variable, then the config, then the default. An empty
variable (`X=`) is ignored. This is why an instance should set these options in `config.json`
rather than in `Environment=` lines of its systemd unit: an empty value in the environment file
would override the unit's `Environment=`, but it never overrides the config.
`anonymousRead` and `httpLogin` exist only in the config. The `HOST` variable, which some
environments export, has no effect.

At startup, one log line gives the effective values and their source, with no secret:

```
security: listenHost=127.0.0.1 (default) ; anonymousRead=false (default) ; httpLogin=false (default) ; adminCidrs=127.0.0.1/32 (default)
```

Example for a LAN and Tailscale: `"adminCidrs": ["192.0.2.0/24", "100.64.0.0/10", "127.0.0.1/32"]`.

Example behind an HTTPS reverse proxy on another machine:

```json
"listenHost": "::",
"allowedHosts": ["vigie.example.net"],
"trustedProxies": ["192.0.2.153"],
"security": { "anonymousRead": false, "httpLogin": false, "adminCidrs": ["192.0.2.0/24", "127.0.0.1/32"] }
```

## Reading the API

By default, reading the API requires an admin session: the client must come from an allowed
network (`security.adminCidrs`) **and** have a valid session. Without anonymous read and without
a session, the client (wall mode included) shows the login screen.

With `security.anonymousRead: true`, the API can be read without a session.

Always public, whatever the setting:

- `GET /api/healthz`
- `GET /api/session`
- `GET /api/config` (title, subtitle, footer, locale)
- `POST /api/login` and `POST /api/logout`
- the static files of the client

The path is compared exactly: a variant that Express would also route (different case, trailing
slash) requires a session.

Always reserved to a session, even with anonymous read:

- `GET /api/audit`;
- the SSH and firewall posture and the listening ports of hosts in `GET /api/agents`, and the
  ports in the network module;
- the bot and refresh state in `GET /api/session`.

## Admin session

There is a single identity, "admin", protected by one password.

- The password is stored only as a scrypt hash, in `ADMIN_PASSWORD_HASH` (environment file).
  It is at least 12 characters long.
- The session cookie is `HttpOnly`, `SameSite=Strict` and valid for 12 hours. It is `Secure`
  when the session was opened over HTTPS. Only a hash of the session ID is stored in the
  database.
- Without `ADMIN_PASSWORD_HASH`, the action buttons are hidden and every write answers 503. The
  Telegram bot works on its own.
- An invalid `ADMIN_PASSWORD_HASH` disables the login (503); the rest of Vigie starts.

To set or change the password, in an interactive terminal (`ssh -t` from a remote machine):

```bash
cd /opt/vigie/server && node scripts/admin-password.js --write /etc/vigie/vigie.env
systemctl restart vigie
```

Without `--write`, the script prints the `ADMIN_PASSWORD_HASH=…` line. With `--write`, it
replaces that line in the file, or appends it, and writes the file with mode 0600. The password
is never written or shown. Open sessions stay valid after a restart. The `init` wizard sets the
password with the same code.

## Logging in

A login goes through these checks, in order:

1. **Origin**: the `Origin` (or `Referer`) header must be the same host as the request, and
   the body must be JSON. Otherwise: 403. This blocks a login forced from another site.
2. **Password hash**: without a valid `ADMIN_PASSWORD_HASH`, the login answers 503.
3. **Network**: the client address must be in `security.adminCidrs`. Otherwise: 403.
4. **HTTPS**: without `security.httpLogin`, a login over plain HTTP is refused (403) unless it
   comes from the loopback, before the password is even checked. HTTPS means TLS on the socket,
   or a trusted proxy with `X-Forwarded-Proto: https`. The loopback exception is based on the
   socket address only, never on `X-Forwarded-For`, and a trusted proxy on the same machine does
   not count as loopback.
5. **Lock** (429 when it applies, see below).
6. **Password** (401 if wrong).

Only the login is guarded by `httpLogin`: a cookie obtained over HTTPS is `Secure` and is never
sent over HTTP. Without `httpLogin`, no session can therefore be used over HTTP outside the
loopback.

### Login lock

- **Per address**: 5 failed attempts from one address within 15 minutes block that address,
  known addresses included.
- **Global**: 20 failed attempts within 15 minutes from **unknown** addresses block all unknown
  addresses. A **known** address is not affected and does not count towards this limit.
- A known address is one with a successful login in the last 30 days, read from the audit log.
  A trusted proxy is never a known address.
- Each attempt is counted before the password is checked: simultaneous attempts never get more
  than 5 password checks per address.

The client address is the socket address or, behind a trusted proxy, the address that proxy
reports. Known limit: if a NAT makes many clients arrive under one address (for example a
Tailscale subnet router with SNAT), the 5 attempts per address apply to all of them together,
and one successful login makes that address known for all of them.

## Write actions

Every write checks, in order:

1. the client network (`security.adminCidrs` or `ADMIN_ALLOWED_CIDRS`; default: loopback only),
   403 otherwise;
2. the `Origin` (or `Referer`) header: same host as the request, and a name accepted by
   `allowedHosts`, 403 otherwise;
3. a JSON body (`Content-Type: application/json`), 415 otherwise. This rules out cross-site
   form posts;
4. a valid session, 401 otherwise.

Request bodies are limited to 8 KB, and to 32 KB for the two bulk routes (413 beyond).

Writes change only Vigie's own state; no machine is touched. Each one requires a **reason** of 3
to 200 characters, except:

- no reason (none is asked) to remove an acknowledgement, lift a silence or remove an update
  decision;
- optional for **Probe all** in the network module; it is logged when given.

| Action | UI (admin) | Telegram |
| --- | --- | --- |
| Acknowledge an alert (stops reminders; the recovery is still notified) | Alerts → **Acknowledge** | **✅ Ack** button, `/ack #12 reason` |
| Acknowledge several alerts at once, one reason, one notification | Alerts → checkboxes → **Acknowledge…** | — |
| Silence an alert, a host, a service or a rule; 1 hour to 30 days, or with no end (reminded in the digest) | Alerts → **Silence…**, **New** | **🔕 1 h** button, `/mute web-1 2h reason` |
| Lift a silence | Alerts → **Lift** | `/unmute 3` |
| Ignore a version, postpone, pin the major version, ignore a component | Updates → detail of a row | — |
| Run all collections again (agent, probes, Proxmox, versions), once per minute | header, ⟳ icon | `/refresh` |
| Accept a posture deviation, remove the acceptance | host drawer → Posture | — |
| Mark a new listening port as known | host drawer → Listening ports | — |
| Mark several new listening ports as known at once | Alerts → checkboxes (only `port_new`) → **Mark as known…** | — |

The bot commands are listed in [alerts.md](alerts.md#the-telegram-bot).

### Posture and port routes

Admin only, reason required, audited:

- `POST /api/agents/posture/accept` and `POST /api/agents/posture/unaccept`, body
  `{ host, criterion, reason }`, where `criterion` is `ssh_root`, `ssh_password` or `firewall`;
- `POST /api/agents/ports/known`, body `{ host, proto, port, reason }`.

### Bulk routes

Admin only, **one** reason for the whole batch, JSON body up to 32 KB.

`POST /api/alerts/ack/bulk`, body `{ keys: [...], reason, until? }`. `until` is an optional
end in milliseconds, as for a single acknowledgement.

- **The whole batch is refused (400, nothing is acknowledged)** if `keys` is not a list, is
  empty or has more than 200 items (counted as received, duplicates included), if a key is not a
  non-empty string of at most 300 characters, if the reason is not 3 to 200 characters long, or
  if the end is invalid (in the past, or more than 90 days ahead).
- Otherwise each key is handled on its own. A duplicate key is ignored (handled and returned
  once).
- Errors per key: `unknown alert`, `alert not firing` (pending), `already acknowledged` (an
  acknowledgement is in progress; a single acknowledgement replaces it instead).

`POST /api/agents/ports/known/bulk`, body `{ items: [{ host, proto, port }], reason }`.

- The batch is refused (400) if `items` is not a list, is empty or has more than 200 items, or
  if the reason is invalid.
- Otherwise each item is handled on its own. An item that is not an object fails alone
  (`invalid item`); the others go through. A duplicate (same host, protocol and port) is ignored.
  `port` can be a number or a numeric string.
- Errors per item: `unknown host`, `invalid protocol`, `invalid port`, `unknown or closed port`,
  `port already known`.

Both answer `{ results, ok, failed }`: for each item, `ok: true` or the error. There is no
all-or-nothing. One audit line is written per successful item, none for a failure. The bulk
acknowledgement sends **a single** notification ("✅ 12 alerts acknowledged from the dashboard:
reason", with five titles at most; none if nothing was acknowledged). The bulk "known" action
re-evaluates the alerts only once, at the end.

## Allowed host names

The `Host` header is checked before anything else, against DNS rebinding. Accepted names:
`localhost`, `127.0.0.1`, `[::1]`, the host name of `alerts.dashboardUrl`, and the entries of
`allowedHosts` (host names or IPv4 addresses, without port).

Any other request gets **421** "host not allowed", with no data from the instance: the name
received (cut to 100 characters) and what to do. A browser (`Accept: text/html`, outside `/api`)
gets an HTML page; anything else gets JSON (`{ error, host, hint }`).

To allow a new name (DNS alias, Tailscale name), add it to `allowedHosts` and restart.
`X-Forwarded-Host` is never read: the proxy must pass the original `Host` header.

The `Origin` of a write must also carry an allowed name.

## Trusted proxies

`trustedProxies` lists the reverse proxies Vigie trusts: exact IPv4 or IPv6 addresses, or IPv4
and IPv6 CIDR ranges. A proxy in a container changes address within its subnet: give the
network of the proxy's Docker bridge, for example `"172.18.0.0/16"`, as narrow as possible.

- Prefix of at least `/8` in IPv4 and `/32` in IPv6. Names and ports are refused.
- An IPv6 range that covers the IPv4-mapped addresses (`::ffff:0:0/96`, for example `::/32`)
  is refused: it would trust every IPv4 address. A mapped entry (`::ffff:a.b.c.d/n`) counts as
  its IPv4 form (`a.b.c.d/(n-96)`, IPv4 rules).
- Empty by default.

Only for requests coming from these addresses, Vigie reads:

- `X-Forwarded-For`, from right to left, skipping trusted proxies: the first other address is
  the real client. It is used for the allowed networks, the login lock and the audit log. A
  value forged on the left is never read.
- `X-Forwarded-Proto`: the whole value must be `https` (case ignored) for the request to count
  as HTTPS. It makes the session cookie `Secure` and allows the login without `httpLogin`.

A request from a trusted proxy without a readable client address is refused (403). It is never
treated as coming from the proxy. A trusted proxy is never a "known" address for the login lock.
Direct access (for example `http://192.0.2.10:8088`) is unchanged, with a cookie without
`Secure`. Express's `trust proxy` setting is not used.

## Response headers

Every response carries a strict Content Security Policy (the dashboard's scripts and the hash
of the theme script in `client/index.html`; never `'unsafe-inline'` or `'unsafe-eval'` for
scripts), `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`, and no
`X-Powered-By`.

Framing is refused by default (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
`frameAncestors` lists the origins (`http(s)://host[:port]`, without path, query or fragment)
allowed to show Vigie in a frame, for example a kiosk that displays `/wall`.

If you change the inline script of `client/index.html`, its hash changes: the test
`security-headers.test.js` fails and gives the new value of `THEME_SCRIPT_HASH`
(`server/lib/security-headers.js`).

## Errors

Errors are always JSON `{ error }`, without stack trace or path:

| Status | Meaning |
| --- | --- |
| 400 | Invalid request |
| 401 | Session required, or wrong password |
| 403 | Network, origin or HTTP login refused |
| 413 | Body too large |
| 415 | Unsupported content type (JSON expected) |
| 421 | Host not allowed |
| 429 | Too many login attempts |
| 500 | Internal error (logged) |
| 503 | Login not configured, or invalid password hash |

## Audit log

Logins, refusals and actions are written to the `audit` table and kept for 400 days. An admin
session can read them with `GET /api/audit`.

Refusals without a session are aggregated: the first one is written, and the next ones with the
same source, actor, action and reason within 10 minutes give one line "N more refusals in
10 min". Successes and refusals with a valid session are written one by one.

## Telegram bot

The bot uses long polling (`getUpdates`): nothing is exposed. It obeys only the chat
`TELEGRAM_CHAT_ID` **and** the accounts in `TELEGRAM_ALLOWED_USER_IDS`. Any other message is
ignored without an answer and logged in the audit log. `BOT_DISABLED=1` turns it off (test
instance), and so does the dry-run mode (`ALERTS_DRY_RUN=1`). Its actions are audited like those
of the UI. Setup and commands: [alerts.md](alerts.md#the-telegram-bot).

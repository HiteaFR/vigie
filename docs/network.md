# Network

The network module keeps an inventory of the devices on your LAN, with their presence, a map, and a
service probe. **It stays inert without a `network` block** in `config.json`.

Sources:

- Pi-hole;
- an ARP sweep of the subnet: the `net-scan` unit runs `arp-scan` every 120 s on the dashboard's
  host, outside the dashboard process;
- Proxmox;
- the [dash-report agents](agent.md);
- passive mDNS.

There is no continuous port scanning. Only the service probe opens ports, on the hosts declared in
your infrastructure, on Sundays at 04:00 or when an admin asks for it.

## Configuration

`config.json` → `network`. Schema defaults are in parentheses.

- `subnets` (required): `[{ "cidr": "192.0.2.0/24", "name": "LAN" }]`. `gateway` is optional and
  must be inside the CIDR; it overrides the anchor of the ARP sweep (by default, the host's default
  route).
- `sources`:
  - `pihole`: `url`, `secretEnv`, `intervalSec` (60). Reads the ARP table and the DHCP leases.
  - `neigh`: `iface` (`eth0`). Reads the neighbor table of the dashboard's host.
  - `pve` (`true`): MAC addresses of Proxmox guests.
  - `arp`: `file`, of the form `/run/net-scan/<name>.json`, written by the ARP sweep
    (`agent/net-scan/`; interface and network are set in `/etc/net-scan.conf`), and
    `intervalSec` (120). Gives online / offline presence.

  Reports from the `dash-report` agent complete these sources.
- `ingestDays` (30): a MAC that Pi-hole has not seen for longer gets no device entry.
- `activeMin` (15): how recent a sighting must be to count as "active".
- `maxNewPerCycle` (20): beyond this, it is a flood, and device creation is suspended for 1 hour.
- `presence`: `fixedMin` (5), `normalMin` (10), `sleepyMin` (45), `minMissedScans` (3).
- `alerts.newSeverity` (`warning`).
- `ipIdentity` (`[]`): ranges where the IP address is the identity, for macvlan containers (whose
  MAC changes at each re-creation).
- `hostSuffixes` (`[]`): domain suffixes removed from discovered names, on top of `.lan`, `.local`,
  `.home` and `.localdomain`. For example `["isp.example.net"]` when your ISP's router appends its
  domain to DHCP names (`printer.isp.example.net` is shown as `printer`).
- `probe`: the service probe.
  - `enabled` (`false`) only controls the weekly run.
  - `exclude` (`[]`): IPv4 addresses or host ids that are never probed, by the weekly run or on
    demand.
  - The probe checks TCP ports, then HTTP. It runs on Sundays at 04:00 (in `alerts.timezone`,
    `Europe/Paris` by default) and when an admin asks for it. A port counts as closed after the
    second refusal in a row. Ports still open on a device but no longer covered by the definitions
    are checked again with TCP only, without an HTTP request.
  - `defsDirs` (absent: the shipped file only): folders of additional definitions, see
    [Additional service definitions](#additional-service-definitions).
- `mdns`: `enabled` (`false`) and `iface` (default: `sources.neigh.iface`). Passive mDNS listening.
  It never renames a device.

For running in a container (host network mode, the ARP companion, and the limits of bridge mode),
see [Network under Docker](docker.md#network-under-docker) and
[Host or bridge mode](docker.md#host-or-bridge-mode).

### Additional service definitions

The service probe recognizes a service by its ports and, when needed, by an HTTP response. Its
definitions come from the shipped file (`server/lib/network/service-defs.json`), then, in this
order, from the `*.json` files in each folder of `network.probe.defsDirs`, then from plugins (see
[Writing a plugin](plugins.md#extensions)).

Limits on `defsDirs`: absolute paths, 8 folders at most and 32 files per folder at most, read in
sorted name order. Each file must be a regular file of 1 MiB at most: no link, FIFO or device.

Each file has the same format as the shipped file:

```json
{
  "attribution": "My definitions",
  "defs": [
    {
      "id": "my-tool",
      "name": "My tool",
      "category": "dev",
      "match": { "allOf": [{ "port": 7070 }, { "http": { "port": 7070, "path": "/health", "contains": "my-tool" } }] }
    }
  ]
}
```

- `id`: lowercase letters, digits and hyphens, 32 characters at most, unique across all
  definitions (shipped ones included). `name`: 64 characters at most; `category`: 32.
  `attribution` is required.
- `match` is one pattern among:
  - `{ "port": n }`;
  - `{ "http": { port, path, contains?, status?, empty? } }`, with at least one of the last three
    (`contains` in lowercase);
  - `{ "header": { port, path, name, contains } }`;
  - `{ "macVendor": "…" }`;
  - `{ "anyOf": [...] }`, `{ "allOf": [...] }`, `{ "not": pattern }`.

  Depth 4 and 32 nodes at most. No `http` or `header` evidence on a TLS port (443, 8443, 9443,
  8006, 5001).
- 64 definitions per file, 256 in total.
- Confidence: a port alone gives "low", and each additional distinct piece of evidence raises it
  one level. When confidence is equal, the order above decides (shipped definitions first).
- A file that is invalid, that reuses an existing `id`, or that would exceed the total is rejected
  as a whole. The server log gives its path, and `extraDefs` in the probe status
  (`sources.probe` in `/api/network`) gives its file name only. The other files and the shipped
  file are still used.

## API

Reads are protected like the rest of the API: a session is required, unless
`security.anonymousRead` is on (see [Security](security.md)). Reasons and authors are shown only
with an admin session.

- `GET /api/network`
- `GET /api/network/history?days=7|30|90`
- `GET /api/network/topology`
- `GET /api/network/topology.mmd` (Mermaid export)
- `GET /api/network/devices/:id`

Writes are `POST` requests under `/api/network/`, with an admin session, an `Origin` header and a
JSON body. They are all written to the audit log:

- `devices/edit`, `devices/ack`, `devices/delete`, `devices/merge`;
- `links`, `links/remove`;
- `macs/confirm`, `macs/detach`;
- `mac-rules`, `mac-rules/remove`;
- `suggestions/dismiss`;
- `devices/probe`: 202; 429 within 10 minutes of the previous one; 409 for an excluded target;
- `probe/all` ("Probe all"): 202; 409 while a run is in progress; 429 within 1 hour.

A reason is required to acknowledge a device (Known), merge, detach, confirm, edit MAC rules, dismiss a suggestion,
delete, and change the links of the map, and also to untick the offline alert of a device whose
alert is ongoing. It is optional for "Probe all".

## Alerts

Network alerts use `env` prod: the LAN is neither prod nor dev, so it is treated as prod. See
[Alerts](alerts.md).

| Alert | Raised when | Severity |
| --- | --- | --- |
| `net_new` | A new device appears. | `alerts.newSeverity` |
| `net_mac_added` | A MAC address is attached to an existing device. | info; warning when attached by name |
| `net_new_flood` | A flood of new devices; one incident per episode. | warning |
| `net_down` | A tracked device is offline according to the ARP sweep. | the device's severity, warning by default |
| `net_ip_changed` | The expected IP differs from the IP seen, for 10 minutes. | warning |
| `net_agent_conflict` | A container identity conflict. | warning |
| `source_error:network/<source>` | A source has been silent for 10 minutes. | warning |

## Nothing is ignored

There is no "Ignore" or "Archive". A device is **deleted** instead (with a reason, 1 to 200 devices
at a time, all or nothing; if the server refuses, the device page gives the reason). Its tombstone
is kept for 400 days. If the device comes back, it shows up as **new**, with a `net_new` alert.

Retention: events, attributes and sessions 400 days; hourly presence and closed ports 90 days; raw
readings 7 days.

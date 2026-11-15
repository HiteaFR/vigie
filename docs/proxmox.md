# Proxmox hypervisors

Vigie reads one or more Proxmox VE clusters through their API, with a read-only token: guests,
nodes, disks, backups and failed tasks. It only sends GET requests to Proxmox.

## Contents

- [Configuration](#configuration)
- [Pinned CA](#pinned-ca)
- [Undeclared guests](#undeclared-guests)
- [Backups](#backups)
- [Infra view](#infra-view)
- [Proxmox API token](#proxmox-api-token)
- [Other API tokens](#other-api-tokens)

## Configuration

`config.json` → `proxmox[]`, one block per cluster. They are shown in this order.

```json
{ "id": "main", "label": "Main cluster (192.0.2.10)", "host": "https://192.0.2.10:8006",
  "env": "PVE_MAIN", "ca": "pki/pve-main.pem", "backups": { "mode": "storage", "node": "pve1", "storage": "backups" } }
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Cluster ID, referenced by `hosts[].pve`. |
| `label` | yes | Name shown in the UI. |
| `host` | yes | API URL. |
| `env` | yes | **Prefix** of the environment variables that hold the token (see below). |
| `ca` | for an `https://` host | Pinned CA of the cluster, `pki/<name>.pem` (see [Pinned CA](#pinned-ca)). |
| `backups` | no | How backups are read (see [Backups](#backups)). |
| `ignoreGuests` | no | Guests that are deliberately not in `hosts[]` (see [Undeclared guests](#undeclared-guests)). Default `[]`. |

`env` is a prefix made of upper-case letters, digits and `_` (checked by the schema). The
secrets come from two variables in the environment file:

```
PVE_MAIN_TOKEN_ID=vigie@pve!vigie
PVE_MAIN_TOKEN_SECRET=<secret>
```

`<env>_HOST`, if set, overrides `host`.

An unreachable cluster shows its error without hiding the others.

## Pinned CA

`ca` is **required** for an `https://` host. It is the cluster's root CA
(`/etc/pve/pve-root-ca.pem` on a node, valid for 10 years). Copy it as is into the CA directory
(`PKI_DIR`, otherwise `server/pki/`). It is a public certificate: never copy a private key. Refer
to it as `"ca": "pki/<name>.pem"`; this resolves to `<PKI_DIR>/<name>.pem`.

- Only this CA is accepted, and the name or IP in `host` must appear in the certificate the
  node serves (Node's default check).
- `check-config` uses the same CA directory as the server. It refuses a CA that is missing,
  unreadable, not a CA, or expired. A missing or unreadable `PKI_DIR` gives "CA missing" or "CA
  unreadable".
- At startup, the same problem does not stop the service: the cluster goes into error with
  "certificate not verified: CA missing (pki/…)" (alert `pve_unreachable`). There is no
  permissive fallback.
- The log gives the subject and expiry date of each CA, with a warning 90 days before it
  expires.
- If the node's certificate changes (`pvecm updatecerts --force`, reinstallation, ACME), the TLS
  handshake fails and the token is not sent: `Proxmox: certificate not verified (<code>) — pinned
  CA pki/…`, where `<code>` is the TLS error code.

**Renewal**: read the CA again on the node, replace the file in the CA directory, and restart
Vigie. Never switch to an unverified connection.

The `init` wizard can also pin the CA: from a PEM file, or from the CA the server presents,
accepted only after you compare its SHA-256 fingerprint. On a node:

```bash
openssl x509 -in /etc/pve/pve-root-ca.pem -noout -fingerprint -sha256
```

## Undeclared guests

A guest (VM or container, templates excluded) that exists in Proxmox but is missing from the
cluster's `hosts[]` raises `guest_undeclared:<cluster>:<vmid>`. Its severity is info, in prod as
in dev, and its parent is `pve_unreachable`.

For guests you deliberately leave out, add `"ignoreGuests": [vmid, …]` to the cluster block
(empty by default). Declaring the guest later resolves the alert. A guest deleted from Proxmox
is forgotten without a message.

## Backups

Two modes:

- `storage`: reads the content of the backup storage (`storage` is required). Proxmox requires
  `VM.Backup` and `Datastore.AllocateSpace` to list backups, even for reading.
- `tasks`: reads the logs of the last `jobs` vzdump tasks (10 by default), looking for
  `Finished Backup of VM n` and `ERROR: Backup of VM n failed`. `Sys.Audit` is enough: this mode
  works with a **strictly** read-only `PVEAuditor` token.

`node` is the node whose storage or tasks are read.

In both modes, the vzdump logs give the **guests × 7 days matrix** and the outcome of the last
run. `/cluster/backup` gives the schedule (next run), the exclusions and the guests covered by
no job. In `storage` mode, the storage content also reveals **orphaned backups** (VMID gone,
templates excluded): the job's retention never purges them.

## Infra view

The **Infra** page (`/infra`, API `/api/proxmox`) shows, per node:

- PVE version, kernel, load, RAM without cache, swap, root filesystem;
- physical disks with SMART data (temperature, power-on hours, reallocated sectors, media
  errors) and SSD wear (`wearout` = life left);
- failed tasks of the last 7 days (`since=`, so old history is not loaded);
- PVE notification targets.

The detail of a guest (`?h=`) shows its Proxmox graphs over 24 hours or 7 days
(`/api/rrd/<cluster>/guest/<vmid>`). All of this needs only `Sys.Audit` and `VM.Audit`: no extra
right on the token.

## Proxmox API token

Recommended setup, identical on every cluster: a user such as `vigie@pve` with a token `vigie`,
privilege separation on (`privsep=1`), and the rights set **on the user and on the token**:

- `PVEAuditor` on `/`;
- a custom role (for example `VigieBackup`) with `VM.Audit`, `VM.GuestAgent.Audit`,
  `VM.Backup`, `Datastore.Audit` and `Datastore.AllocateSpace`, on `/vms` and on the backup
  storage (`/storage/<name>`).

Why these rights:

- Proxmox shows a backup only with `VM.Backup` and `Datastore.AllocateSpace`. Without them, the
  storage list comes back empty, and deleted guests stay invisible.
- `VM.GuestAgent.Audit` must be in the role because the ACL set on `/vms` replaces the one
  inherited from `/`. This right gives the IP addresses of the VMs.
- With this role, the clusters read their backups in `storage` mode. The trade-off: the token
  could start and delete backups, but Vigie only sends GET requests to Proxmox.

For a strictly read-only token, give `PVEAuditor` on `/` only and use the `tasks` backup mode.
You lose the storage view (orphaned backups).

Create the user, its token (with privilege separation) and the role in the Proxmox interface
(Datacenter → Permissions), or with `pveum` on one node of the cluster.

**Updates**: Proxmox's `apt/update` endpoint requires `Sys.Modify`. The token stays read-only,
and the latest available version comes from the public apt index instead.

## Other API tokens

- **Gitea** (plugin, optional): a token with the scopes `read:repository`, `read:user` and
  `read:admin` (the last one for the list of runners), in `GITEA_TOKEN`.
- **GitHub** (optional): `GITHUB_TOKEN`, a fine-grained personal access token with "Public
  repositories (read-only)" access and no permission at all. It raises the GitHub API limit
  used by the version tracker from 60 to 5,000 requests per hour.

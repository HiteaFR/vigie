# net-scan

ARP scan of the local network for Vigie's network module: a systemd timer runs `arp-scan` every
120 s and writes `/run/net-scan/arp.json`, which the dashboard reads without any privilege. What
the dashboard does with it: [Network](../../docs/network.md).

> **Warning: only scan a network you are responsible for.** An ARP scan sends a request to every
> address on the network: on a corporate, hosting provider or shared neighbourhood network, it may
> be forbidden by the rules or the contract, and flagged as an intrusion. Ask the network owner for
> permission. The network module also works without net-scan (passive sources), with less precise
> presence.

| File | Role |
| --- | --- |
| `net-scan` | POSIX sh, no arguments: `arp-scan` on the interface and network read from `/etc/net-scan.conf`, JSON output; `NET_SCAN_DEMO=file` replays a recorded output and `NET_SCAN_CONF=file` replaces the config (test bench only) |
| `net-scan.service` | oneshot, fixed system user `net-scan`, `CAP_NET_RAW` only, atomic write to `/run/net-scan` |
| `net-scan.timer` | `OnBootSec=60s`, `OnUnitActiveSec=120s` |
| `install.sh` | cleans up a `DynamicUser` installation, installs `arp-scan`, creates the `net-scan` account, runs the pre-install test, installs `net-scan.conf`, the script and the units, checks the first scan, then enables the timer (rolls back otherwise) |
| `test.sh` | test bench for the script in demo mode, offline and without privileges; run by hand or by `npm test`, **never** installed on the machine |

The Vigie service gets **no** capability: only `net-scan.service` has `CAP_NET_RAW`.

## Configuration: `/etc/net-scan.conf`

```
IFACE=eth0
CIDR=192.168.10.0/24
```

root:root 0644, written by `install.sh` from `IFACE=` and `CIDR=`. It is the **only** input of the
script: the dashboard passes nothing to it. The file is read with `grep`, never executed. Strict
validation: `IFACE` `^[A-Za-z0-9_.-]{1,15}$`; `CIDR` a **private** IPv4 range (10/8, 172.16/12,
192.168/16), prefix from 16 to 30; any other non-empty, non-comment line makes it invalid. Missing
or invalid: `{"ok":false,"error":"config …"}`, no scan, and the dashboard reports the source as
failing.

## Installation

1. Vigie installed, with the `network.sources.arp` block in its config: without the file, it has no
   effect.
2. From this repository: `IFACE=eth0 CIDR=192.168.10.0/24 ./install.sh ssh root@<Vigie machine>`
   (or `… pct exec <id> --` for a Proxmox container). `DASH_USER`: the account that reads the file
   (default `vigie`, the one in `deploy/vigie.service.example`). The workstation needs `base64` and
   `sha256sum` from **GNU coreutils** (`base64 -w0`): elsewhere, the values would arrive empty and
   the machine would reject them. `NET_SCAN_INSTALL_CHECK=1` (on the workstation): check without
   installing anything. Each file is written through a temporary file, checked (sha256), then
   renamed. The script, in order:
   1. rejects an invalid `IFACE` or `CIDR` **before** any access to the machine;
   2. stops a previous installation and **cleans up `DynamicUser` leftovers**: the `/run/net-scan`
      link (only if it is a link) and `/run/private/net-scan` (only if it exists), nothing else
      under `/run/private`;
   3. installs `arp-scan` and prints `getcap /usr/sbin/arp-scan`, which must be empty;
   4. creates the `net-scan` system account
      (`useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin
      --user-group net-scan`); if it already exists, checks that it is a system account, with
      `nologin` and a locked password, and that no other unit runs as `User=net-scan`;
   5. runs the **pre-install test** (below) with the options **extracted** from `net-scan.service`: if it
      fails, nothing is installed;
   6. installs `/etc/net-scan.conf` (the old one is kept for rollback), the script and the units,
      then runs **one** scan, **with the timer not enabled**;
   7. checks the result **with exactly the dashboard's checks**: `/run/net-scan` is a real
      directory, not writable by group or others; `arp.json` is a regular file of at most 512 KB,
      not writable by group or others; both have the same owner, different from the reader
      account; the reader account can read them;
   8. enables the timer **only** if these checks pass. Otherwise, **rollback**: timer disabled,
      service stopped, `/run/net-scan` removed, previous `net-scan.conf` restored (or removed),
      exit with an error; the dashboard's database is never touched.
3. **Test**: `cat /run/net-scan/arp.json`: `"ok":true` and the gateway in `hosts`;
   `stat -c '%F %U %a' /run/net-scan` prints `directory net-scan 755`.

**Pre-install test by hand** (for diagnosis, or if you prefer to run it before `install.sh`), as root on the
machine, **after** the account has been created; same options as `net-scan.service`:

```sh
systemd-run --wait -p User=net-scan -p Group=net-scan -p NoNewPrivileges=yes \
  -p AmbientCapabilities=CAP_NET_RAW -p CapabilityBoundingSet=CAP_NET_RAW \
  -p RestrictAddressFamilies='AF_PACKET AF_UNIX AF_NETLINK AF_INET' \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p RestrictSUIDSGID=yes -p LockPersonality=yes -p SystemCallArchitectures=native \
  -p SystemCallFilter=@system-service -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
  -p ProtectKernelLogs=yes -p ProtectControlGroups=yes -p RestrictNamespaces=yes \
  -p MemoryDenyWriteExecute=yes -p UMask=0022 -p RemoveIPC=yes -p TimeoutStartSec=60 \
  -p RuntimeDirectory=net-scan-test -p RuntimeDirectoryMode=0755 \
  -p RuntimeDirectoryPreserve=yes /usr/bin/true
stat -c '%F %U %a' /run/net-scan-test     # expected: directory net-scan 755
rm -rf /run/net-scan-test
```

Expected: exit code 0, `Finished with result: success`, and `directory net-scan 755` (a real
directory, not a link: the point the old pre-install test missed). If a baseline option is refused: see the
fallback below. If only an "extra" option is refused: run again without it to confirm, remove it
from `net-scan.service` (which `install.sh` reads again) and record it in the table below.

**Manual cleanup of a previous `DynamicUser` installation** (`install.sh` also does it):

```sh
systemctl disable --now net-scan.timer; systemctl stop net-scan.service
[ -L /run/net-scan ] && rm -f /run/net-scan
[ -e /run/private/net-scan ] && rm -rf /run/private/net-scan
systemctl daemon-reload
```

`install.sh` then replaces the unit.

**If a scan fails later**: read `systemctl status net-scan.service` and `journalctl -u net-scan`.
If an "extra" option is refused by the LXC container, remove it from `net-scan.service`, then run
`install.sh` again; **record each removal here**:

| Option removed | Date | Error message |
| --- | --- | --- |
| *(none)* | | |

## Fallback (if the pre-install test fails)

In `net-scan.service`, replace `User=net-scan` and `Group=net-scan` with `User=root`; keep
everything else. The **baseline** is **never** removed: `CapabilityBoundingSet=CAP_NET_RAW`,
`NoNewPrivileges=yes`, `RestrictAddressFamilies=AF_PACKET AF_UNIX AF_NETLINK AF_INET`,
`ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`. Root with no capability other than
`CAP_NET_RAW` is still far narrower than the full root of `dash-report-local`, and the dashboard
accepts root as the owner of the directory and the file. "Extra" options can be removed one by one,
as above. **If a baseline option is refused, stop** and go back to whoever audits the installation
rather than shipping a bare root service.

## Security

- The interface and the network come from `/etc/net-scan.conf` (root, 0644, validated, never
  executed); the dashboard cannot choose the target.
- `arp-scan` output is filtered by `awk`: only `IPv4<TAB>MAC<TAB>MAC<TAB>integer` lines get
  through; no free text is copied. The error message is truncated to 80 characters, with no quote,
  `\` or control character.
- Neither `--quiet` nor `--ignoredups`: `${hdrmac}` (source Ethernet MAC) and `${dup}` (duplicate
  replies) are the only signs of spoofing, reported by the dashboard (`arp_conflict`). A perfect MAC
  clone remains undetectable through ARP.
- `/run/net-scan` (`RuntimeDirectoryPreserve=yes`) is a real directory owned by the fixed
  `net-scan` account (no home, `nologin`, locked password, used by no other unit), stable from one
  run to the next. The dashboard checks the file's origin anyway (owner, permissions, symbolic
  link) before reading it.
- Why not `DynamicUser`: with `RuntimeDirectory`, systemd makes `/run/net-scan` a **link** to
  `/run/private/net-scan`, under `/run/private` (0700 root): unreadable by the dashboard, and the
  file belongs to a released UID (65534) between two runs.
- Network impact, for a /24: 254 broadcast ARP requests, at most 3 times for silent addresses,
  ≈ 50 KB every 2 min.

## Verification

`sh test.sh` (demo mode; configuration; static checks of the unit and of `install.sh`; it never
runs `install.sh` except with a fake access command, nor `useradd`, `runuser` or `systemd-run`),
`sh -n net-scan install.sh test.sh`, and `shellcheck -s sh -S warning net-scan install.sh test.sh`
where it is installed.

## Uninstallation

```sh
systemctl disable --now net-scan.timer
systemctl stop net-scan.service
rm /etc/systemd/system/net-scan.service /etc/systemd/system/net-scan.timer /usr/local/sbin/net-scan /etc/net-scan.conf
systemctl daemon-reload
rm -rf /run/net-scan
find / -xdev -user net-scan          # must be empty (no other file owned by the account)
userdel net-scan
apt-get remove arp-scan
```

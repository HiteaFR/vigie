# Vigie agents

Two small POSIX sh programs, installed on the monitored machines. Vigie reads what they produce and
never drives them:

| Agent | Role | Where |
| --- | --- | --- |
| [`dash-report/`](dash-report/README.md) | JSON report on a host (system, disks, systemd, containers, network, packages, posture), read over SSH with a forced-command key, or written by a local timer on the Vigie machine | every monitored host |
| [`net-scan/`](net-scan/README.md) | ARP scan of the local network for the network module, written to `/run/net-scan/arp.json` | the Vigie machine |

Their test benches (`test.sh`, fake binaries, no network and no privileges) run in `npm test`
(`server/test/agent-bench.test.js`).

What the dashboard does with these reports: [the dash-report agent](../docs/agent.md),
[Network](../docs/network.md), [Docker](../docs/docker.md).

## Single source and identity with the deployed version

This folder is the **source** of the agents. An installation that keeps its own copy (during a
transition) checks that it has not diverged by comparing the **sha256 of the body** of `dash-report`:

- **body** = the file from the **first line that does not start with `#`** onwards. The header
  (the `#!` line and the first comment block) is excluded: it can differ from one copy to another
  without changing anything at run time;
- the command, the same on both sides:

  ```sh
  awk 'b || !/^#/ { b = 1; print }' dash-report | sha256sum
  ```

- value for `REPORT_VERSION=9`: `14789bc734784797d37881399cef53bfd42f34faa32755451029c8f63424a2e7`,
  pinned in `server/test/agent-bench.test.js`. Any change to the body changes this value: it
  requires a new report version (v10) and an update of the copies. (v8 was
  `b402ba7becd883d5f995dd7620100b45cb521b91a0308e4f656a51790a809e97`.)

`net-scan` has no identity test: the version here reads the interface and the network from
`/etc/net-scan.conf`, where an older pinned version had them hard-coded.

## Audits

| Item | Finding | Follow-up |
| --- | --- | --- |
| **Forced command** (`dash-report-ssh`, authorized key) | The key is installed with `restrict,from="<FROM>",command="/usr/local/libexec/dash-report-ssh"`: no terminal, no forwarding, no other command. The wrapper only lets `fast` and `slow` through (empty → `fast`) and calls `sudo -n` on two exact commands (`sudoers`, checked by `visudo`). `dash-report` sets its own `PATH` and reads nothing but the mode. | sound |
| Unit names from `/etc/dash-report.units` | Each pattern is passed to `systemctl list-units … -- "<pattern>"`: after `--`, it is never taken as an option (proven by the bench: `--version` is a unit name); output is JSON-escaped. The file is owned by root (0644). v9: a pattern is used only if it matches `^[A-Za-z0-9@._:*-]{1,100}$` (glob included, the rule of `install.sh`); other lines are ignored (proven by the bench: a name with `"` and `\`, a name with a space, a 101-character name); 64 patterns and 100 watched units at most. | done (v9) |
| **Automatic updates marker** | v8 read a text marker specific to one fleet in a fixed apt file. v9: `securityOnly` comes from two optional settings of `/etc/dash-report.conf`, `SECURITY_ONLY_FILE` (absolute path of the apt configuration file that limits updates to security fixes) and `SECURITY_ONLY_MARK` (fixed text it must contain; empty: the file only has to exist), written by `install.sh` from the variables of the same names (validated on the workstation, sent in base64, revalidated on the host). The report reads the file with `sed`, never executes it, and validates both values again. No default: without the file, `securityOnly` is false. | done (v9) |
| Output size | The report caps its lists (32 interfaces, 512 neighbours, 64 Docker networks and 200 containers, 128 ports; v9: 50 failed units, 100 watched units, 64 file systems, 200 packages, 300 images, 50 versions) and, in v9, every string built from a command (256 bytes, control characters removed, mount points included; Docker strings by their template: names 128 characters, image 256, labels 128, 20 tags and 20 digests per image). Vigie also caps the read **before** reading: 512 KiB in `fast`, 8 MiB in `slow` (SSH `maxBuffer`, local file size; `server/lib/agents.js`). | done (v9) |
| earlyoom (v9) | `oom` in the fast report: number of distinct processes (PIDs) named by the `sending SIGTERM/SIGKILL to process` lines of the journal of `earlyoom.service` over the last hour (a TERM then a KILL count once), time and name of the last one (name reduced to `[A-Za-z0-9._-]`, other characters replaced by `?`, 32 at most). Read with `journalctl -u earlyoom.service --since @<time>` only; no earlyoom, no `journalctl` or an unreadable journal → `null`. | done (v9) |
| `docker inspect` template | Every emitted field is listed; no `Env`, no `Cmd`, no `Mounts`, no whole object, and `Labels` only for the two compose keys. Proven by the bench: static check of the templates, and a fake `docker` that rejects any template other than the reference (`test/format-*.txt`). | sound |
| **Root timer** (`dash-report-local`) | The local report runs as **root, without any hardening** (it reads docker, systemctl, apt, `/proc`). **Proposed** variant: `dash-report-local.hardened.service` (`ProtectSystem=strict`, `ReadWritePaths=/run/dash-report`, `ProtectHome=read-only`, `PrivateTmp`, `NoNewPrivileges`). Tried: `systemd-analyze verify` (syntax and directives) on the unit. **Not tried**: a real run (root, docker and apt required); `ProtectHome=read-only` rather than `yes`, so that `df` still sees a separate `/home`. | to be tried on a test machine before replacing the regular unit; this repository installs nothing |
| **`FROM`** | Mandatory, no default (`install.sh`). Each element (comma-separated) is an IPv4 address or an IPv4 CIDR with a prefix from 8 to 32, with no leading zero and no empty element; IPv6 is not supported. It is the address of the Vigie machine **as seen by the host** (after any NAT). | done |
| **Injection into the remote script** | Both `install.sh` scripts send a script to `sh -s` as root. Any value (`PUBKEY`, `FROM`, `UNITS`, `IFACE`, `CIDR`, `DASH_USER`) is rejected if it contains a line feed, a carriage return or a character outside printable ASCII, **before** validation; it is then validated (`PUBKEY`: exactly one `ssh-ed25519` key, with no leading options). The remote script is fixed text; values only reach it in base64, and are decoded there, then **revalidated** before any write. `UNITS` is split without pattern expansion (`set -f`). Proven by the benches: four hostile forms per variable, values tampered with in the captured script, exact final authorized key. The workstation needs `base64` and `sha256sum` from GNU coreutils (`base64 -w0`); elsewhere, the values would arrive empty and the host would reject them. | done |
| **Writing files and finishing the remote script** | Each file is decoded into a temporary file in the **same directory**, checked against its sha256 (sent by the workstation), then renamed: a missing or failing decoder leaves the existing file intact (net-scan decodes and checks its three files before installing any of them). Check mode (`*_INSTALL_CHECK=1`) is decided on the **workstation** (flag validated at the top of the script), never read from the host's environment. Success only if the remote script reaches its end marker (installation or check, depending on what was requested) with exit code 0: a swallowed or truncated script fails. Since the remote script is read by `sh -s`, every command that could read standard input (apt-get, systemctl, useradd, visudo, sshd, su…) is called with `</dev/null`, in both agents (static check in each bench). Proven by the benches: missing decoder, decoder failing after starting to write, wrong checksum; markers and exit codes. | done |
| Link with automatic updates | The installation calls **no** other script: no automatic updates, no other system setting. The daily refresh of apt lists (`10periodic-lists`) is only installed with `APT_LISTS=1`. | done |
| Side effects of the installation | `sudo` is installed **only** with `--yes` (otherwise the script stops and nothing is installed); prerequisites (sshd, sudo) are checked before anything is installed. System account `dashreport`, shell `/bin/sh`: sshd runs the forced command through the account's login shell, which `/usr/sbin/nologin` would refuse; no password and no other use. Files installed: `/usr/local/sbin/dash-report`, `/etc/dash-report.units`, `/usr/local/libexec/dash-report-ssh`, `/etc/sudoers.d/dashreport`, `~dashreport/.ssh/authorized_keys`; in local mode, the two units. | done (documented in `install.sh`) |
| net-scan | Dedicated `net-scan` account (nologin, locked), `CAP_NET_RAW` only, hardened unit, pre-install test before installing anything, rollback. Interface and network read from `/etc/net-scan.conf` with `grep` (never executed), validated (private IPv4, prefix from 16 to 30); the dashboard passes nothing to it. | done |

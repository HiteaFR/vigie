# dash-report

Vigie agent: a JSON report on a host, read over SSH with a forced-command key, or written every
60 s by a local timer on the machine that runs Vigie. Audits and identity: [`../README.md`](../README.md).
What the dashboard does with it: [the dash-report agent](../../docs/agent.md).

| File | Role |
| --- | --- |
| `dash-report` | the report (`fast`: 60 s, including processes killed by earlyoom; `slow`: 1 h, including versions of allow-listed packages), POSIX sh, no dependencies; `REPORT_VERSION=9` |
| `dash-report-ssh` | forced command: only `fast` and `slow` get through |
| `sudoers` | `dashreport` → root for these two commands only |
| `dash-report-local.{service,timer}` | Vigie machine: report written to `/run/dash-report` |
| `dash-report-local.hardened.service` | **proposed** hardened variant of the local unit (not installed by `install.sh`) |
| `units.example` | units monitored by default (`/etc/dash-report.units`) |
| `/etc/dash-report.conf` (on the host) | optional settings, written by `install.sh` from `SECURITY_ONLY_FILE` and `SECURITY_ONLY_MARK`, read by the report with `sed` (never executed) |
| `install.sh` | installs or updates; `FROM` is mandatory, `--yes` to install `sudo`, `APT_LISTS=1` for apt lists, `SECURITY_ONLY_FILE` and `SECURITY_ONLY_MARK` for `/etc/dash-report.conf` |
| `test.sh`, `test/` | local test bench (fake `ip`, `docker`, `systemctl`…), never installed on a host |

## Installation

On the monitored host (root access through the command given as arguments):

```sh
PUBKEY="$(cat <Vigie state directory>/ssh/id_ed25519.pub)" FROM=<Vigie IP as seen by the host> \
  ./install.sh ssh root@<host>
```

Add the `HOSTKEY ssh-ed25519 …` line (printed just before the end marker) to Vigie's `known_hosts`
(`<state directory>/ssh/known_hosts`, in the form `<host IP> ssh-ed25519 …`), then set
`"agent": "ssh"` on the host in the config. On the Vigie machine itself: `LOCAL=1 ./install.sh …`
and `"agent": "local"`.

The workstation that runs `install.sh` needs `base64` and `sha256sum` from **GNU coreutils**
(`base64 -w0`): elsewhere, the values would arrive empty and the host would reject them. The
installation only succeeds if the remote script reaches its end marker with exit code 0.
`DASH_REPORT_INSTALL_CHECK=1` (on the workstation) runs a check without installing anything: values
are revalidated on the host, the authorized key is printed, nothing is written.

## Verification

`AWKS="mawk gawk" sh test.sh`: local test bench, never run on a host; a missing awk implementation
is reported as skipped. `shellcheck -s sh -S warning dash-report dash-report-ssh install.sh test.sh`
where it is installed.

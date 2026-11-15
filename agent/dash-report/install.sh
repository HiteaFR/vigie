#!/bin/sh
# Installs (or updates) the dash-report agent on a host. The root access command to the host is
# given as arguments (ssh, or pct exec for a Proxmox container):
#
#   PUBKEY="$(cat id_ed25519.pub)" FROM=192.0.2.148 ./install.sh ssh root@192.0.2.20       # VM
#   PUBKEY="…" FROM=192.0.2.148 ./install.sh ssh root@pve pct exec 120 --                  # LXC
#   LOCAL=1 ./install.sh ssh root@pve pct exec 110 --          # machine that runs Vigie
#   ./install.sh --yes …                                        # allows installing sudo
#
# Variables:
#   PUBKEY     public key of Vigie (mandatory unless LOCAL=1): EXACTLY one ssh-ed25519 key,
#              without leading options, optional comment
#   FROM       addresses allowed for the key, comma-separated: each an IPv4 address or an IPv4
#              CIDR (prefix 8 to 32), without leading zero; IPv6 is not supported. It is the
#              address of the Vigie machine as seen by the host. MANDATORY (unless LOCAL=1), no
#              default
#   UNITS      watched units, space-separated (glob patterns allowed, never expanded here):
#              writes /etc/dash-report.units (otherwise the existing file is kept, or
#              units.example on the first run)
#   SECURITY_ONLY_FILE, SECURITY_ONLY_MARK  (v9, optional) write /etc/dash-report.conf, read by
#              the report for autoUpdate.securityOnly: absolute path of the apt configuration
#              file that limits automatic updates to security fixes, and a fixed text it must
#              contain (printable ASCII, 100 characters at most; empty: the file only has to
#              exist). Without them, an existing /etc/dash-report.conf is kept
#   LOCAL=1    Vigie machine: systemd timer that writes /run/dash-report/*.json, without a user
#              or SSH
#   APT_LISTS=1  also enables the daily refresh of apt lists (apt-daily.timer,
#              /etc/apt/apt.conf.d/10periodic-lists): the apt_stale alert then only reports a
#              failing refresh. Never set without this variable
# Options:
#   --yes      allows installing sudo if it is missing (refused otherwise, nothing is installed)
#
# Safety: any value that contains a line feed, a carriage return or another character outside
# printable ASCII is refused BEFORE validation; values only reach the remote script (root) in
# base64, and are decoded and REVALIDATED there; the remote script is fixed text, which copies
# nothing in clear. Each file is installed through a temporary file in the same folder, checked
# (sha256), then renamed: a missing or failing decoder leaves the existing file intact. Success
# only if the remote script reaches its end marker, with exit code 0.
#   DASH_REPORT_INSTALL_CHECK=1 (on the WORKSTATION): check without installing, the remote script
#   stops after the revalidation and prints the authorized key it would write
# Workstation: base64 from GNU coreutils (option -w0); elsewhere, the values would arrive empty and
# the host would reject them.
#
# Effects on the host (agent/README.md, audit): /usr/local/sbin/dash-report, /etc/dash-report.units,
# /etc/dash-report.conf (with SECURITY_ONLY_FILE); without LOCAL: system account dashreport (shell
# /bin/sh: the forced command goes through the login shell, which /usr/sbin/nologin would refuse),
# /usr/local/libexec/dash-report-ssh, /etc/sudoers.d/dashreport (checked by visudo), restricted
# authorized key (restrict, from=, command=); with LOCAL: units dash-report-local.{service,timer}.
# Nothing else: no automatic updates, no other apt setting without APT_LISTS=1.
#
# The "HOSTKEY …" line (just before the end marker) is the host key to pin in the known_hosts of
# Vigie (<state directory>/ssh/known_hosts).
set -eu
YES=0
if [ "${1:-}" = --yes ]; then YES=1; shift; fi
[ $# -gt 0 ] || { sed -n 2,52p "$0"; exit 1; }
cd "$(dirname "$0")"
FROM=${FROM:-}
LOCAL=${LOCAL:-0}
PUBKEY=${PUBKEY:-}
APT_LISTS=${APT_LISTS:-0}
UNITS=${UNITS:-}
SECURITY_ONLY_FILE=${SECURITY_ONLY_FILE:-}
SECURITY_ONLY_MARK=${SECURITY_ONLY_MARK:-}
CHECK=${DASH_REPORT_INSTALL_CHECK:-0}

# validations, shared by the workstation and the remote script (copied as is into the remote
# script, below): a single-line value of printable ASCII, then its exact form
CHECKS=$(cat <<'CHECKS'
nl='
'
# true if $1 only contains printable ASCII (no \n, no \r, no control character, no byte > 0x7e)
printable() { case $1 in *"$nl"*) return 1 ;; esac; [ -z "$(printf '%s' "$1" | LC_ALL=C tr -d ' -~')" ]; }
# an IPv4 address without leading zero, with an optional prefix from 8 to 32
ipv4_or_cidr() {
  printf '%s' "$1" | awk -F/ 'NR > 1 { exit 1 } NF < 1 || NF > 2 { exit 1 }
    { n = split($1, a, "."); if (n != 4) exit 1
      for (i = 1; i <= 4; i++) if (a[i] !~ /^(0|[1-9][0-9]?[0-9]?)$/ || a[i] + 0 > 255) exit 1
      if (NF == 2 && ($2 !~ /^[1-9][0-9]?$/ || $2 + 0 < 8 || $2 + 0 > 32)) exit 1 }'
}
check_from() { # FROM: non-empty list of IPv4 addresses or CIDRs, comma-separated, no empty element
  printable "$1" || return 1
  case $1 in '' | ,* | *, | *,,*) return 1 ;; esac
  rest=$1
  while :; do
    item=${rest%%,*}
    ipv4_or_cidr "$item" || return 1
    [ "$item" = "$rest" ] && return 0
    rest=${rest#*,}
  done
}
# exactly one ssh-ed25519 key, without leading options, optional comment
check_pubkey() {
  printable "$1" || return 1
  printf '%s' "$1" | grep -Eqx 'ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9@._-]+)?'
}
# a systemd unit pattern (glob allowed), 100 characters at most (same rule as the report)
check_unit() { printable "$1" && printf '%s' "$1" | grep -Eqx '[A-Za-z0-9@._:*-]{1,100}'; }
check_flag() { case $1 in 0 | 1) return 0 ;; *) return 1 ;; esac; }
# v9: SECURITY_ONLY_FILE, an absolute path without ".."; SECURITY_ONLY_MARK, printable ASCII,
# 100 characters at most (same rules as the report)
check_path() {
  printable "$1" || return 1
  case $1 in *..*) return 1 ;; esac
  printf '%s' "$1" | grep -Eqx '/[A-Za-z0-9._/-]{1,200}'
}
check_mark() { printable "$1" && [ "${#1}" -le 100 ]; }
CHECKS
)
eval "$CHECKS"
nl='
'

check_flag "$LOCAL" || { echo "LOCAL: 0 or 1" >&2; exit 1; }
check_flag "$APT_LISTS" || { echo "APT_LISTS: 0 or 1" >&2; exit 1; }
check_flag "$CHECK" || { echo "DASH_REPORT_INSTALL_CHECK: 0 or 1" >&2; exit 1; }
if [ "$LOCAL" != 1 ]; then
  [ -n "$PUBKEY" ] || { echo "PUBKEY missing" >&2; exit 1; }
  check_pubkey "$PUBKEY" || { echo "PUBKEY: exactly one ssh-ed25519 key on one line, without options or control characters" >&2; exit 1; }
  [ -n "$FROM" ] || { echo "FROM missing: IP (or CIDR) of the Vigie machine as seen by the host, no default" >&2; exit 1; }
  check_from "$FROM" || { echo "FROM: IPv4 addresses or IPv4 CIDRs (prefix 8 to 32, no leading zero), comma-separated" >&2; exit 1; }
fi
if [ -n "$SECURITY_ONLY_FILE" ]; then
  check_path "$SECURITY_ONLY_FILE" || { echo "SECURITY_ONLY_FILE: absolute path (letters, digits, . _ / -), without .." >&2; exit 1; }
  check_mark "$SECURITY_ONLY_MARK" || { echo "SECURITY_ONLY_MARK: one line of printable ASCII, 100 characters at most" >&2; exit 1; }
elif [ -n "$SECURITY_ONLY_MARK" ]; then
  echo "SECURITY_ONLY_MARK without SECURITY_ONLY_FILE" >&2; exit 1
fi
units=""
if [ -n "$UNITS" ]; then
  printable "$UNITS" || { echo "UNITS: a single line of printable ASCII" >&2; exit 1; }
  list=""
  # split on spaces WITHOUT pattern expansion (dash-report* stays dash-report*)
  set -f
  for u in $UNITS; do
    check_unit "$u" || { set +f; echo "UNITS: invalid unit pattern (letters, digits, @ . _ : * -, 100 at most)" >&2; exit 1; }
    list="$list$u$nl"
  done
  set +f
  units=$(printf '%s' "$list" | base64 -w0)
fi

b64() { base64 -w0 "$1"; }
enc() { printf '%s' "$1" | base64 -w0; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# remote script: fixed text (quoted heredoc), preceded by its values, all in base64. It is read by
# `sh -s` on standard input: any command that could read stdin is called with </dev/null,
# otherwise it would swallow the rest of the script (same rule as net-scan)
remote=$(cat <<'REMOTE'
set -eu
dec() { printf '%s' "$1" | base64 -d; }
# atomic install of a decoded file: temporary file in the same folder, checked (sha256 sent by
# the workstation), permissions, then rename; on failure, the existing file is not touched
put() { # $1 destination; $2 mode; $3 base64; $4 expected sha256
  t=$(mktemp "$(dirname "$1")/.$(basename "$1").XXXXXX") || return 1
  if printf '%s' "$3" | base64 -d >"$t" 2>/dev/null && [ "$(sha256sum <"$t" | cut -d' ' -f1)" = "$4" ]; then
    if chmod "$2" "$t" && { [ "$(id -u </dev/null)" != 0 ] || chown root:root "$t"; } && mv -f "$t" "$1"; then return 0; fi
  fi
  rm -f "$t"
  return 1
}
PUBKEY=$(dec "$PUBKEY_B64")
FROM=$(dec "$FROM_B64")
SEC_FILE=$(dec "$SEC_FILE_B64")
SEC_MARK=$(dec "$SEC_MARK_B64")
# revalidation on the host (values received in base64)
check_flag "$LOCAL" && check_flag "$APT_LISTS" && check_flag "$YES" && check_flag "$CHECK" || { echo "$(hostname): invalid flags; nothing is installed" >&2; exit 1; }
if [ "$LOCAL" != 1 ]; then
  check_pubkey "$PUBKEY" || { echo "$(hostname): invalid PUBKEY; nothing is installed" >&2; exit 1; }
  check_from "$FROM" || { echo "$(hostname): invalid FROM; nothing is installed" >&2; exit 1; }
fi
if [ -n "$SEC_FILE" ]; then
  check_path "$SEC_FILE" && check_mark "$SEC_MARK" || { echo "$(hostname): invalid SECURITY_ONLY_FILE or SECURITY_ONLY_MARK; nothing is installed" >&2; exit 1; }
elif [ -n "$SEC_MARK" ]; then
  echo "$(hostname): SECURITY_ONLY_MARK without SECURITY_ONLY_FILE; nothing is installed" >&2; exit 1
fi
if [ -n "$UNITS_B64" ]; then
  units=$(dec "$UNITS_B64")
  set -f
  for u in $units; do check_unit "$u" || { set +f; echo "$(hostname): invalid UNITS; nothing is installed" >&2; exit 1; }; done
  set +f
fi
akline="restrict,from=\"$FROM\",command=\"/usr/local/libexec/dash-report-ssh\" $PUBKEY"
# check without installing (decided on the WORKSTATION, validated flag): stop after the revalidation
if [ "$CHECK" = 1 ]; then
  printf 'authorized_keys: %s\n' "$akline"
  [ -z "$SEC_FILE" ] || printf 'dash-report.conf: SECURITY_ONLY_FILE=%s SECURITY_ONLY_MARK=%s\n' "$SEC_FILE" "$SEC_MARK"
  echo "dash-report: check complete (nothing installed)"
  exit 0
fi

# prerequisites checked BEFORE anything is installed (SSH agent only)
if [ "$LOCAL" != 1 ]; then
  command -v sshd >/dev/null || [ -x /usr/sbin/sshd ] || { echo "$(hostname): openssh-server missing, install it first; nothing is installed" >&2; exit 1; }
  if ! command -v sudo >/dev/null; then
    [ "$YES" = 1 ] || { echo "$(hostname): sudo missing; run again with --yes to install it (apt-get install sudo); nothing is installed" >&2; exit 1; }
    echo "$(hostname): installing sudo (--yes)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q sudo </dev/null >/dev/null
  fi
fi
install -d -m 755 /usr/local/sbin /usr/local/libexec
put /usr/local/sbin/dash-report 755 "$SCRIPT_B64" "$SCRIPT_SHA" || { echo "$(hostname): installing dash-report failed (decoding or checksum); the installed agent is intact" >&2; exit 1; }
if [ -n "$UNITS_B64" ]; then
  put /etc/dash-report.units 644 "$UNITS_B64" "$UNITS_SHA" || { echo "$(hostname): installing /etc/dash-report.units failed" >&2; exit 1; }
elif [ ! -e /etc/dash-report.units ]; then
  put /etc/dash-report.units 644 "$UNITS_EXAMPLE_B64" "$UNITS_EXAMPLE_SHA" || { echo "$(hostname): installing /etc/dash-report.units failed" >&2; exit 1; }
fi
# v9: settings of the report, written from the revalidated values (never executed by the report)
if [ -n "$SEC_FILE" ]; then
  conf=$(printf '# /etc/dash-report.conf: settings of dash-report (written by install.sh)\nSECURITY_ONLY_FILE=%s\nSECURITY_ONLY_MARK=%s\n' "$SEC_FILE" "$SEC_MARK")
  put /etc/dash-report.conf 644 "$(printf '%s\n' "$conf" | base64 -w0)" "$(printf '%s\n' "$conf" | sha256sum | cut -d' ' -f1)" || { echo "$(hostname): installing /etc/dash-report.conf failed" >&2; exit 1; }
fi

# APT_LISTS=1 only: apt lists refreshed every day by apt-daily.timer (nothing is written if this
# is already active)
if [ "$APT_LISTS" = 1 ] && ! apt-config dump APT::Periodic::Update-Package-Lists </dev/null 2>/dev/null | grep -Eq '"([1-9][0-9]*|always)";$'; then
  printf '%s\n' '// dash-report (APT_LISTS=1): apt lists refreshed every day by apt-daily.timer' 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/10periodic-lists
  echo "$(hostname): daily apt lists enabled (/etc/apt/apt.conf.d/10periodic-lists)"
fi

if [ "$LOCAL" = 1 ]; then
  put /etc/systemd/system/dash-report-local.service 644 "$LOCAL_SERVICE_B64" "$LOCAL_SERVICE_SHA" || { echo "$(hostname): installing dash-report-local.service failed" >&2; exit 1; }
  put /etc/systemd/system/dash-report-local.timer 644 "$LOCAL_TIMER_B64" "$LOCAL_TIMER_SHA" || { echo "$(hostname): installing dash-report-local.timer failed" >&2; exit 1; }
  systemctl daemon-reload </dev/null
  systemctl enable --now dash-report-local.timer </dev/null
  systemctl start dash-report-local.service </dev/null
  echo "$(hostname): $(head -c 80 /run/dash-report/fast.json)…"
  echo "dash-report: installation complete"
  exit 0
fi

# shell /bin/sh: sshd runs the forced command (command=) through the login shell of the account;
# /usr/sbin/nologin would refuse it. The account has no password and no other use
id dashreport </dev/null >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/dashreport --shell /bin/sh dashreport </dev/null
put /usr/local/libexec/dash-report-ssh 755 "$SSH_WRAPPER_B64" "$SSH_WRAPPER_SHA" || { echo "$(hostname): installing dash-report-ssh failed" >&2; exit 1; }

put /etc/sudoers.d/dashreport.new 440 "$SUDOERS_B64" "$SUDOERS_SHA" || { echo "$(hostname): installing the sudoers file failed" >&2; exit 1; }
visudo -cqf /etc/sudoers.d/dashreport.new </dev/null || { rm -f /etc/sudoers.d/dashreport.new; echo "$(hostname): sudoers file refused by visudo" >&2; exit 1; }
mv /etc/sudoers.d/dashreport.new /etc/sudoers.d/dashreport

install -d -m 700 -o dashreport -g dashreport /var/lib/dashreport/.ssh
printf '%s\n' "$akline" > /var/lib/dashreport/.ssh/authorized_keys
chown dashreport:dashreport /var/lib/dashreport/.ssh/authorized_keys
chmod 600 /var/lib/dashreport/.ssh/authorized_keys

# restrictive AllowUsers / AllowGroups: dashreport must be in them
allow=$(sshd -T </dev/null 2>/dev/null | grep -iE '^allow(users|groups) ' || true)
[ -z "$allow" ] || echo "$(hostname): warning, sshd filters users ($allow): add dashreport@$FROM"

# self-test: the wrapper, as dashreport, must return a JSON report
out=$(su -s /bin/sh dashreport -c 'SSH_ORIGINAL_COMMAND=fast /usr/local/libexec/dash-report-ssh' </dev/null 2>/dev/null | head -c 40)
case "$out" in '{"schema":1,"version"'*) echo "$(hostname): dash-report OK" ;; *) echo "$(hostname): self-test failed: $out" >&2; exit 1 ;; esac
echo "HOSTKEY $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
# NOTHING after this marker: the workstation requires it to be the second-to-last line of the
# output (the last one is the remote exit code)
echo "dash-report: installation complete"
REMOTE
)

# values: validated flags (0 or 1), everything else in base64 ([A-Za-z0-9+/=], no quote)
units_sha=""
[ -z "$units" ] || units_sha=$(printf '%s' "$list" | sha256sum | cut -d' ' -f1)
# output shown live (tee to stderr) and kept to check it; the exit code of `"$@" sh -s` is taken
# apart and written as the last line. Success only if the second-to-last line is the expected end
# marker and the remote code is 0 (a swallowed or truncated script often exits with 0)
log=$({
  rc=0
  {
    printf "LOCAL=%s\nAPT_LISTS=%s\nYES=%s\nCHECK=%s\n" "$LOCAL" "$APT_LISTS" "$YES" "$CHECK"
    printf "PUBKEY_B64='%s'\nFROM_B64='%s'\nUNITS_B64='%s'\nUNITS_SHA='%s'\n" "$(enc "$PUBKEY")" "$(enc "$FROM")" "$units" "$units_sha"
    printf "SEC_FILE_B64='%s'\nSEC_MARK_B64='%s'\n" "$(enc "$SECURITY_ONLY_FILE")" "$(enc "$SECURITY_ONLY_MARK")"
    for f in dash-report:SCRIPT units.example:UNITS_EXAMPLE dash-report-local.service:LOCAL_SERVICE dash-report-local.timer:LOCAL_TIMER dash-report-ssh:SSH_WRAPPER sudoers:SUDOERS; do
      printf "%s_B64='%s'\n%s_SHA='%s'\n" "${f#*:}" "$(b64 "${f%%:*}")" "${f#*:}" "$(sha "${f%%:*}")"
    done
    printf '%s\n' "$CHECKS"
    printf '%s\n' "$remote"
  } | "$@" sh -s 2>&1 || rc=$?
  echo "dash-report: remote exit code $rc"
} | tee /dev/stderr) || true
want="dash-report: installation complete"
[ "$CHECK" = 1 ] && want="dash-report: check complete (nothing installed)"
[ "$(printf '%s\n' "$log" | tail -n 2)" = "$want
dash-report: remote exit code 0" ] ||
  { echo "FAILED: incomplete installation: end marker missing, or non-zero remote exit code (see the output above)" >&2; exit 1; }

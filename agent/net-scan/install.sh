#!/bin/sh
# Installs (or updates) net-scan on the machine that runs Vigie. The root access command is
# passed as arguments, as for dash-report:
#
#   IFACE=eth0 CIDR=192.168.10.0/24 ./install.sh ssh root@192.0.2.148
#   IFACE=eth0 CIDR=192.168.10.0/24 ./install.sh ssh root@pve pct exec 110 --
#
# Variables:
#   IFACE      scan interface (^[A-Za-z0-9_.-]{1,15}$), REQUIRED
#   CIDR       scanned network, PRIVATE IPv4 (10/8, 172.16/12, 192.168/16), prefix from 16 to 30,
#              REQUIRED; both written to /etc/net-scan.conf (root:root 0644), the script's only input
#   DASH_USER  account that reads /run/net-scan/arp.json (Vigie's service; default: vigie)
#   NET_SCAN_INSTALL_CHECK=1  check without installing (on the WORKSTATION): values revalidated on
#              the machine, nothing is installed
# Workstation: base64 and sha256sum from GNU coreutils (base64 -w0); elsewhere, the values would
# arrive empty and the machine would reject them. Each file is installed through a temporary file
# in the same directory, verified (sha256) then renamed: a missing or failing decoder leaves the
# existing file intact. WARNING: only scan a network you are responsible for (README).
#
# In order: leftovers of a DynamicUser installation; arp-scan (apt); net-scan system account
# (verified if it exists); pre-install test with the options EXTRACTED from net-scan.service (failure: nothing
# is installed); install net-scan.conf, the script and the units; a first scan, timer NOT enabled;
# checks identical to the dashboard's (reading arp.json); the timer is enabled only if they pass,
# rolled back otherwise (previous net-scan.conf restored).
set -eu
[ $# -gt 0 ] || { sed -n 2,24p "$0"; exit 1; }
cd "$(dirname "$0")"
IFACE=${IFACE:-}
CIDR=${CIDR:-}
DASH_USER=${DASH_USER:-vigie}
# check without installing, decided here on the workstation (never read from the machine's
# environment): the remote script stops after revalidating the values
CHECK=${NET_SCAN_INSTALL_CHECK:-0}
case $CHECK in 0 | 1) ;; *) echo "NET_SCAN_INSTALL_CHECK: 0 or 1" >&2; exit 1 ;; esac
# validations, shared by the workstation and the remote script (copied verbatim into the remote
# script): a value on a single line of printable ASCII (no \n, no \r, no control character), then
# its exact form; same rules as net-scan
CHECKS=$(cat <<'CHECKS'
nl='
'
printable() { case $1 in *"$nl"*) return 1 ;; esac; [ -z "$(printf '%s' "$1" | LC_ALL=C tr -d ' -~')" ]; }
check_iface() { printable "$1" && printf '%s' "$1" | grep -Eqx '[A-Za-z0-9_.-]{1,15}'; }
# private IPv4 (10/8, 172.16/12, 192.168/16), no leading zero, prefix 16 to 30
check_cidr() {
  printable "$1" || return 1
  [ "$(printf '%s' "$1" | awk -F'[./]' 'NR > 1 { print 0; exit } NF == 5 {
    for (i = 1; i <= 4; i++) if ($i !~ /^(0|[1-9][0-9]?[0-9]?)$/ || $i + 0 > 255) { print 0; exit }
    if ($5 !~ /^[1-9][0-9]$/ || $5 + 0 < 16 || $5 + 0 > 30) { print 0; exit }
    a = $1 + 0; b = $2 + 0; print ((a == 10) || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)) ? 1 : 0; exit }
    { print 0 }')" = 1 ]
}
check_user() { printable "$1" && printf '%s' "$1" | grep -Eqx '[a-z_][a-z0-9_-]{0,31}'; }
CHECKS
)
eval "$CHECKS"
check_iface "$IFACE" || { echo "IFACE missing or invalid (^[A-Za-z0-9_.-]{1,15}$, one line)" >&2; exit 1; }
check_cidr "$CIDR" || { echo "CIDR missing or invalid (private IPv4 with no leading zero, prefix 16 to 30)" >&2; exit 1; }
check_user "$DASH_USER" || { echo "DASH_USER invalid" >&2; exit 1; }

# part run as root on the CT; the files arrive in base64 (variables at the top).
# It is read by `sh -s` on standard input: any command that may read stdin is called
# there with </dev/null, otherwise it would swallow the rest of the script. The last
# message ("installation complete") proves it ran to the end: the local part requires
# it in the output, and exits with an error without it
remote=$(cat <<'REMOTE'
set -eu
host=$(hostname)
fail() {
  echo "$host: FAILED: $1" >&2
  exit 1
}
# values received in base64 only, decoded then REVALIDATED here before any action
dec() { printf '%s' "$1" | base64 -d; }
# atomic install of a decoded file: temporary file in the same directory, verified (sha256 sent
# by the workstation), permissions, then rename; on failure, the existing file is not touched
put() { # $1 destination; $2 mode; $3 base64; $4 expected sha256
  t=$(mktemp "$(dirname "$1")/.$(basename "$1").XXXXXX") || return 1
  if printf '%s' "$3" | base64 -d >"$t" 2>/dev/null && [ "$(sha256sum <"$t" | cut -d' ' -f1)" = "$4" ]; then
    if chmod "$2" "$t" && { [ "$(id -u </dev/null)" != 0 ] || chown root:root "$t"; } && mv -f "$t" "$1"; then return 0; fi
  fi
  rm -f "$t"
  return 1
}
case $CHECK in 0 | 1) ;; *) fail "invalid check flag; nothing installed" ;; esac
NS_IFACE=$(dec "$NS_IFACE_B64")
NS_CIDR=$(dec "$NS_CIDR_B64")
NS_DASH_USER=$(dec "$NS_DASH_USER_B64")
check_iface "$NS_IFACE" || fail "IFACE invalid; nothing installed"
check_cidr "$NS_CIDR" || fail "CIDR invalid; nothing installed"
check_user "$NS_DASH_USER" || fail "DASH_USER invalid; nothing installed"
# check without installing (flag decided on the workstation): stop after revalidation, before any action
if [ "$CHECK" = 1 ]; then printf 'net-scan.conf: IFACE=%s CIDR=%s; reader %s\n' "$NS_IFACE" "$NS_CIDR" "$NS_DASH_USER"; echo "net-scan: check complete (nothing installed)"; exit 0; fi
# rollback after installing: timer disabled, service stopped, file and directory removed
# (link or directory); the dashboard's database is never touched
rollback() {
  systemctl disable --now net-scan.timer </dev/null 2>/dev/null || true
  systemctl stop net-scan.service </dev/null 2>/dev/null || true
  rm -f /run/net-scan/arp.json /run/net-scan/arp.json.tmp
  rm -rf /run/net-scan /run/private/net-scan
  # previous net-scan.conf restored (or removed if there was none)
  if [ -n "${conf_prev:-}" ] && [ -f "$conf_prev" ]; then mv -f "$conf_prev" /etc/net-scan.conf; elif [ "${conf_new:-0}" = 1 ]; then rm -f /etc/net-scan.conf; fi
  fail "$1; rolled back (timer disabled, /run/net-scan removed, previous net-scan.conf restored)"
}

# 0. leftovers of an older installation with DynamicUser: the /run/net-scan link (only if it
#    is a link) and /run/private/net-scan (only if it exists), nothing else
systemctl disable --now net-scan.timer </dev/null 2>/dev/null || true
systemctl stop net-scan.service </dev/null 2>/dev/null || true
if [ -L /run/net-scan ]; then rm -f /run/net-scan; fi
if [ -e /run/private/net-scan ]; then rm -rf /run/private/net-scan; fi

# 1. package; no file capability expected on arp-scan (only the unit grants CAP_NET_RAW)
DEBIAN_FRONTEND=noninteractive apt-get install -y -q arp-scan </dev/null >/dev/null
echo "$host: getcap arp-scan: $(getcap /usr/sbin/arp-scan </dev/null 2>/dev/null || true)"

# 2. fixed system account: created, or verified if it exists (system, nologin, locked password)
if id net-scan </dev/null >/dev/null 2>&1; then
  uid=$(id -u net-scan </dev/null)
  shell=$(getent passwd net-scan </dev/null | cut -d: -f7)
  max=$(awk '$1 == "SYS_UID_MAX" { print $2 }' /etc/login.defs 2>/dev/null)
  pw=$(passwd -S net-scan </dev/null | awk '{ print $2 }')
  [ "$uid" -le "${max:-999}" ] && [ "$shell" = /usr/sbin/nologin ] && [ "$pw" = L ] ||
    fail "existing net-scan account not compliant (uid $uid, shell $shell, password $pw); nothing installed"
else
  # an orphan net-scan group would make useradd --user-group fail: explicit stop, nothing installed
  getent group net-scan </dev/null >/dev/null && fail "net-scan group exists without a net-scan account: check it or remove it (groupdel net-scan); nothing installed"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group net-scan </dev/null
fi
others=$(grep -rlx 'User=net-scan' /etc/systemd/system /lib/systemd/system /usr/lib/systemd/system 2>/dev/null | grep -v '/net-scan\.service$' || true)
[ -z "$others" ] || fail "other unit with User=net-scan: $others; nothing installed"

# 3. pre-install test: [Service] options EXTRACTED from the unit (single source), except Type,
#    ExecStart and RuntimeDirectory*; /run/net-scan-test must be a real net-scan 755 directory
work=$(mktemp -d)
# the three files decoded and verified BEFORE installing anything (decoder missing or failing: nothing installed)
put "$work/net-scan" 755 "$SCRIPT_B64" "$SCRIPT_SHA" && put "$work/net-scan.service" 644 "$SERVICE_B64" "$SERVICE_SHA" &&
  put "$work/net-scan.timer" 644 "$TIMER_B64" "$TIMER_SHA" || { rm -rf "$work"; fail "file decoding failed (base64 or checksum); nothing installed"; }
sed -n '/^\[Service\]/,/^\[/p' "$work/net-scan.service" >"$work/service"
set --
while IFS= read -r line; do
  case "$line" in
    '' | '#'* | '['* | Type=* | ExecStart=* | RuntimeDirectory*) continue ;;
  esac
  set -- "$@" -p "$line"
done <"$work/service"
rm -rf /run/net-scan-test
if ! systemd-run --wait "$@" -p RuntimeDirectory=net-scan-test -p RuntimeDirectoryMode=0755 \
  -p RuntimeDirectoryPreserve=yes /usr/bin/true </dev/null; then
  rm -rf /run/net-scan-test "$work"
  fail "pre-install test refused (see the fallback in the README); nothing installed"
fi
got=$(stat -c '%F %U %a' /run/net-scan-test 2>/dev/null || echo absent)
rm -rf /run/net-scan-test
[ "$got" = "directory net-scan 755" ] || { rm -rf "$work"; fail "pre-install test: /run/net-scan-test = '$got', expected 'directory net-scan 755'; nothing installed"; }
echo "$host: pre-install test OK ($got)"

# 4. install net-scan.conf (the script's only input, root:root 0644), the script and the units;
#    timer not enabled yet. The old conf is kept for the rollback
conf_prev=""
conf_new=0
if [ -f /etc/net-scan.conf ]; then conf_prev=$(mktemp /etc/.net-scan.conf.prev.XXXXXX) && cp -p /etc/net-scan.conf "$conf_prev"; else conf_new=1; fi
printf 'IFACE=%s\nCIDR=%s\n' "$NS_IFACE" "$NS_CIDR" >/etc/.net-scan.conf.new
chown root:root /etc/.net-scan.conf.new
chmod 644 /etc/.net-scan.conf.new
mv -f /etc/.net-scan.conf.new /etc/net-scan.conf
install -d -m 755 /usr/local/sbin
put /usr/local/sbin/net-scan 755 "$SCRIPT_B64" "$SCRIPT_SHA" || { rm -rf "$work"; rollback "installing /usr/local/sbin/net-scan failed (the existing script is intact)"; }
put /etc/systemd/system/net-scan.service 644 "$SERVICE_B64" "$SERVICE_SHA" || { rm -rf "$work"; rollback "installing net-scan.service failed"; }
put /etc/systemd/system/net-scan.timer 644 "$TIMER_B64" "$TIMER_SHA" || { rm -rf "$work"; rollback "installing net-scan.timer failed"; }
rm -rf "$work"
systemctl daemon-reload </dev/null

# 5. a first scan, timer NOT enabled
systemctl start net-scan.service </dev/null || rollback "first scan failed"

# 6. checks IDENTICAL to readArp (no more, no less: otherwise the dashboard would set
#    presenceSince from a file that is then undone); then a read by the dashboard account
d=/run/net-scan
f=$d/arp.json
[ -d "$d" ] && [ ! -L "$d" ] || rollback "$d is not a real directory (link or type)"
[ $((0$(stat -c %a "$d") & 022)) -eq 0 ] || rollback "$d writable by group or others"
[ -f "$f" ] && [ ! -L "$f" ] || rollback "$f is not a regular file"
[ "$(stat -c %s "$f")" -le 524288 ] || rollback "$f too large"
[ $((0$(stat -c %a "$f") & 022)) -eq 0 ] || rollback "$f writable by group or others"
dash_uid=$(id -u "$NS_DASH_USER" </dev/null 2>/dev/null) || rollback "user $NS_DASH_USER missing (DASH_USER)"
[ "$(stat -c %u "$f")" = "$(stat -c %u "$d")" ] && [ "$(stat -c %u "$f")" != "$dash_uid" ] ||
  rollback "owner of $f ($(stat -c %U "$f")) differs from that of $d ($(stat -c %U "$d")), or equals $NS_DASH_USER"
runuser -u "$NS_DASH_USER" -- cat "$f" </dev/null >/dev/null || rollback "$f unreadable by $NS_DASH_USER"

# 7. timer enabled, only now; the old conf is no longer needed
systemctl enable --now net-scan.timer </dev/null
if [ -n "$conf_prev" ]; then rm -f "$conf_prev"; fi
stat -c '%F %U %a %n' "$d" "$f"
echo "$host: $(head -c 160 "$f")…"
# NOTHING after this marker: the caller requires it to be the second-to-last line of the output
# (the last one is the remote exit code); one more line makes the installation fail
echo "net-scan: installation complete"
REMOTE
)

# output shown live to the operator (tee to stderr) and kept to check it. Without pipefail
# in POSIX sh, the exit code of '"$@" sh -s' is captured separately and written as the last
# line. Success only if the second-to-last line is exactly the end marker and the remote
# code is 0: a swallowed or truncated remote script (sh -s then often exits 0) fails
log=$({
  rc=0
  {
    # all values in base64 ([A-Za-z0-9+/=], no single quote), then the validations
    printf "CHECK=%s\n" "$CHECK"
    for f in net-scan:SCRIPT net-scan.service:SERVICE net-scan.timer:TIMER; do
      printf "%s_B64='%s'\n%s_SHA='%s'\n" "${f#*:}" "$(base64 -w0 "${f%%:*}")" "${f#*:}" "$(sha256sum "${f%%:*}" | cut -d' ' -f1)"
    done
    printf "NS_IFACE_B64='%s'\nNS_CIDR_B64='%s'\nNS_DASH_USER_B64='%s'\n" \
      "$(printf '%s' "$IFACE" | base64 -w0)" "$(printf '%s' "$CIDR" | base64 -w0)" "$(printf '%s' "$DASH_USER" | base64 -w0)"
    printf '%s\n' "$CHECKS"
    printf '%s\n' "$remote"
  } | "$@" sh -s 2>&1 || rc=$?
  echo "net-scan: remote exit code $rc"
} | tee /dev/stderr) || true
want="net-scan: installation complete"
[ "$CHECK" = 1 ] && want="net-scan: check complete (nothing installed)"
end=$(printf '%s\n' "$log" | tail -n 2)
[ "$end" = "$want
net-scan: remote exit code 0" ] ||
  { echo "FAILED: incomplete installation: end marker missing, or non-zero remote exit code (see the output above)" >&2; exit 1; }

#!/bin/sh
# Test bench of dash-report: run by hand or by npm test (server/test/agent-bench.test.js), NEVER
# installed on a host (install.sh does not copy it):
#
#   AWKS="mawk gawk" sh test.sh
#
# Runs a COPY of dash-report (fast and slow modes) whose PATH= line is replaced by a work folder
# that only holds links to the needed tools and fake ip, docker, systemctl, journalctl, df,
# systemd-detect-virt, ss, sshd, nft and timedatectl (test/fake/, fixed outputs, RFC 5737 and RFC
# 7042): nothing from the system gets through (neither the real ip nor the real docker). The
# original is never modified; no network, no privilege. awk is a link to each implementation of
# AWKS (a missing one is "skipped" without failing the bench). Also runs the calling part of
# install.sh with a FAKE access command that keeps the remote script without running it.
set -eu
[ "$(id -u)" -ne 0 ] || { echo "test.sh refuses to run as root" >&2; exit 1; }
cd "$(dirname "$0")"
here=$(pwd)
command -v python3 >/dev/null || { echo "python3 required (JSON validation)" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
AWKS=${AWKS:-mawk gawk}
fails=0
n=0

result() { # $1: label; $2: 0 if the condition holds
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else
    echo "FAILED $1" >&2
    fails=$((fails + 1))
  fi
}

# tool folder of a case: $1 folder; $2 awk; $3 with ip (1/0); $4 with docker (1/0)
mkbin() {
  mkdir -p "$1"
  for c in tr sed cat date hostname uname timeout grep paste head ls sort tail find wc cut mktemp rm; do
    p=$(command -v "$c") && ln -s "$p" "$1/$c"
  done
  ln -s "$(command -v "$2")" "$1/awk"
  for f in systemctl journalctl df systemd-detect-virt ss sshd nft timedatectl; do ln -s "$here/test/fake/$f" "$1/$f"; done
  if [ "$3" = 1 ]; then ln -s "$here/test/fake/ip" "$1/ip"; fi
  if [ "$4" = 1 ]; then ln -s "$here/test/fake/docker" "$1/docker"; fi
}
# copy of dash-report with the PATH of the case; the substitution is checked
copy() { # $1: tool folder; $2: copy
  sed "s#^PATH=/usr/sbin:/usr/bin:/sbin:/bin\$#PATH=$1#" dash-report >"$2"
  grep -qx "PATH=$1" "$2" || { echo "FAILED to substitute PATH in the copy" >&2; exit 1; }
}
# copy whose watched-units file is replaced (unit name cases): $1 tools; $2 copy; $3 file
copy_units() {
  copy "$1" "$2"
  sed -i "s#^UNITS_FILE=/etc/dash-report.units\$#UNITS_FILE=$3#" "$2"
  grep -qx "UNITS_FILE=$3" "$2" || { echo "FAILED to substitute UNITS_FILE in the copy" >&2; exit 1; }
}
# one report: $1 awk; $2 ip; $3 docker; $4 FAKE_NETS; $5 output; $6 mode (fast by default)
run() {
  n=$((n + 1)); d="$work/$n-$1-$2-$3-$4-${6:-fast}"
  mkbin "$d/bin" "$1" "$2" "$3"
  copy "$d/bin" "$d/dash-report"
  FAKE_DIR="$here/test" FAKE_NETS="$4" sh "$d/dash-report" "${6:-fast}" >"$5"
}
check() { # $1: label; $2: JSON file; $3: python script (d = decoded JSON)
  if python3 -c "import json,sys; d=json.load(open(sys.argv[1])); $3" "$2" 2>"$work/err"; then
    echo "ok   $1"
  else
    echo "FAILED $1: $(head -c 300 "$work/err")" >&2
    fails=$((fails + 1))
  fi
}

for awk in $AWKS; do
  if ! command -v "$awk" >/dev/null 2>&1; then
    echo "skipped: $awk missing"
    continue
  fi
  out="$work/$awk.json"
  run "$awk" 1 1 nominal "$out"
  check "$awk: valid JSON, version 9" "$out" "assert d['schema'] == 1 and d['version'] == 9 and d['mode'] == 'fast'"
  check "$awk: inodes per file system, null without inodes (vfat)" "$out" \
    "assert [(f['mount'], f['inodes']) for f in d['fs']] == [('/', {'total': 65536, 'used': 1200}), ('/boot/efi', None)], d['fs']"
  check "$awk: interfaces without lo, veth*, docker0, br-*, without IPv4 or too long a name; limit 32" "$out" \
    "n = [i['name'] for i in d['net']['ifaces']]; assert n == ['ens18'] + ['e%d' % i for i in range(31)], n"
  check "$awk: 8 addresses at most per interface; MAC" "$out" \
    "i = d['net']['ifaces'][0]; assert i['ipv4'] == ['192.0.2.%d/24' % k for k in range(10, 18)] and i['mac'] == '00:00:5e:00:53:10', i"
  check "$awk: neighbours with lladdr and valid MAC only; limit 512" "$out" \
    "v = d['net']['neigh']; assert len(v) == 512 and all(x['dev'] == 'ens18' and x['state'] == 'REACHABLE' for x in v) and not any(x['ip'] in ('192.0.2.7', '192.0.2.8', '192.0.2.9') for x in v)"
  check "$awk: networks capped at 64, hostile name escaped (valid JSON, literal)" "$out" \
    "n = d['docker']['networks']; assert len(n) == 64 and n[0]['name'] == 'h\"o,]st\x00<img src=x onerror=alert(1)>' and n[1] == {'name': 'local', 'driver': 'macvlan'}"
  check "$awk: containers capped at 200, hostile name literal, container networks with a final null" "$out" \
    "c = d['docker']['containers']; assert len(c) == 200 and c[0]['name'].startswith('/h\"o,]st') and c[0]['networks'] == [{'network': 'local', 'ip': '192.0.2.193', 'mac': '0a:00:00:00:53:f1'}, {'network': 'bridge', 'ip': '172.17.0.2', 'mac': '02:42:ac:11:00:02'}, None] and 'watchtower' not in c[1]"
  slow="$work/$awk-slow.json"
  run "$awk" 1 0 nominal "$slow" slow
  check "$awk: slow, valid JSON, version 9, without apt or Docker" "$slow" \
    "assert d['version'] == 9 and d['mode'] == 'slow' and d['apt'] is None and d['images'] is None"
  check "$awk: SSH posture (without-password alias, password through keyboard-interactive + PAM)" "$slow" \
    "assert d['posture']['ssh'] == {'permitRootLogin': 'prohibit-password', 'passwordAuth': True}, d['posture']"
  check "$awk: active nftables firewall (input chain with drop)" "$slow" \
    "assert d['posture']['firewall'] == {'type': 'nftables', 'active': True}, d['posture']"
  check "$awk: clock" "$slow" "assert d['time'] == {'ntpSynced': True}"
  check "$awk: services to restart unknown without root (/proc/1/maps unreadable) → null" "$slow" \
    "assert d['restart'] is None, d['restart']"
  check "$awk: ports, scope and brackets removed, * → ::, duplicate merged, out of range left out" "$slow" \
    "l = d['listening'][:7]; assert l == [{'proto': 'tcp', 'addr': '0.0.0.0', 'port': 22, 'process': 'sshd'}, {'proto': 'udp', 'addr': '127.0.0.53', 'port': 53, 'process': 'systemd-resolve'}, {'proto': 'tcp', 'addr': '::', 'port': 80, 'process': None}, {'proto': 'tcp', 'addr': '::', 'port': 81, 'process': None}, {'proto': 'udp', 'addr': 'fe80::1', 'port': 546, 'process': 'systemd-network'}, {'proto': 'tcp', 'addr': '192.0.2.10', 'port': 1000, 'process': 'svc'}, {'proto': 'tcp', 'addr': '192.0.2.10', 'port': 1001, 'process': 'svc'}], l"
  check "$awk: ports capped at 128, neither 0 nor 70000" "$slow" \
    "l = d['listening']; assert len(l) == 128 and all(1 <= x['port'] <= 65535 for x in l), len(l)"
done

# cases without a varying awk (default implementation: the first one of AWKS present)
def=""
for awk in $AWKS; do if command -v "$awk" >/dev/null 2>&1; then def=$awk; break; fi; done
[ -n "$def" ] || { echo "FAILED no awk implementation of AWKS" >&2; exit 1; }
run "$def" 1 1 empty "$work/empty.json"
check "empty network list → [] (valid JSON)" "$work/empty.json" "assert d['docker']['networks'] == []"
run "$def" 1 1 failing "$work/failing.json"
check "docker network ls failing → networks null" "$work/failing.json" "assert d['docker']['networks'] is None and len(d['docker']['containers']) == 200"
run "$def" 0 1 nominal "$work/no-ip.json"
check "without ip → net null" "$work/no-ip.json" "assert d['net'] is None"
run "$def" 1 0 nominal "$work/no-docker.json"
check "without Docker → docker null" "$work/no-docker.json" "assert d['docker'] is None"

# missing information → null, never a default value (ss, sshd -T, nft failing)
export FAKE_SS=failing FAKE_SSHD=failing FAKE_NFT=failing
run "$def" 1 0 nominal "$work/missing.json" slow
unset FAKE_SS FAKE_SSHD FAKE_NFT
check "ss, sshd -T, nft failing → listening, ssh, firewall null" "$work/missing.json" \
  "assert d['listening'] is None and d['posture'] == {'ssh': None, 'firewall': None}, (d['listening'], d['posture'])"

# v9: processes killed by earlyoom (fast report). Without earlyoom (unit unknown): null; with it:
# count of the "sending SIGTERM/SIGKILL to process" lines, time and name of the last one; journal
# empty → 0; journal unreadable → null; the fake journalctl requires the exact options
run "$def" 1 0 nominal "$work/oom-absent.json"
check "earlyoom absent (unit unknown to systemd) → oom null" "$work/oom-absent.json" "assert d['oom'] is None"
FAKE_EARLYOOM=1 run "$def" 1 0 nominal "$work/oom.json"
check "earlyoom: 2 distinct processes killed in the window (TERM then KILL of the same PID count once), last one at its journal time, name of the last process" "$work/oom.json" \
  "assert d['oom'] == {'windowSec': 3600, 'kills': 2, 'lastAt': 1767225900, 'lastProcess': 'stress-ng-vm'}, d['oom']"
FAKE_EARLYOOM=1 FAKE_JOURNAL=empty run "$def" 1 0 nominal "$work/oom-empty.json"
check "earlyoom without any kill in the window → kills 0, lastAt and lastProcess null" "$work/oom-empty.json" \
  "assert d['oom'] == {'windowSec': 3600, 'kills': 0, 'lastAt': None, 'lastProcess': None}, d['oom']"
FAKE_EARLYOOM=1 FAKE_JOURNAL=failing run "$def" 1 0 nominal "$work/oom-failing.json"
check "earlyoom with an unreadable journal → oom null, report still valid" "$work/oom-failing.json" "assert d['oom'] is None and d['version'] == 9"
# hostile process name in the journal: replaced characters, 32 at most, valid JSON
printf '%s\n' '1767225999.5 host earlyoom[1]: sending SIGKILL to process 7 uid 0 "a\"b c<x>&$(id)yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy": badness 1' >"$work/journal-hostile.txt"
mkdir -p "$work/fake-hostile" && cp "$here/test/"format-*.txt "$work/fake-hostile/" && cp "$work/journal-hostile.txt" "$work/fake-hostile/journal-earlyoom.txt"
d="$work/oom-hostile"
mkbin "$d/bin" "$def" 0 0
copy "$d/bin" "$d/dash-report"
FAKE_DIR="$work/fake-hostile" FAKE_EARLYOOM=1 sh "$d/dash-report" fast >"$work/oom-hostile.json"
check "earlyoom: hostile process name → only [A-Za-z0-9._-] and ?, 32 at most" "$work/oom-hostile.json" \
  "p = d['oom']['lastProcess']; assert d['oom']['kills'] == 1 and p == 'a?', p"

# v9: mount point with control characters, " and \ → removed, valid JSON (like js())
FAKE_DF=hostile run "$def" 1 0 nominal "$work/fs-hostile.json"
check "mount point: control characters, quote and backslash removed (valid JSON)" "$work/fs-hostile.json" \
  "assert [(f['mount'], f['inodes']) for f in d['fs']][-1] == ('/mnt/abcdef', {'total': 100, 'used': 1}), d['fs']"

# v9: strings read from a command capped at JS_MAX (256) bytes (here the Docker version)
FAKE_DOCKER_VERSION=$(printf 'v%.0s' $(seq 1 300)) run "$def" 1 1 nominal "$work/long.json"
check "string from a command capped at 256 bytes (docker.version)" "$work/long.json" "assert d['docker']['version'] == 'v' * 256, len(d['docker']['version'])"

# v9: securityOnly from /etc/dash-report.conf (functions conf and security_only of the report, run
# alone): no default; file and mark; file only; values out of form refused
{ sed -n '/^conf() {/p' dash-report; sed -n '/^security_only() {/,/^}/p' dash-report; printf '%s\n' 'security_only && echo true || echo false'; } >"$work/so.sh"
printf '// managed: security only\n' >"$work/52security"
so() { printf '%s' "$1" >"$work/conf"; CONF_FILE=$work/conf sh "$work/so.sh"; }
r=0
[ "$(CONF_FILE=$work/absent sh "$work/so.sh")" = false ] || r=1
[ "$(so '')" = false ] || r=1
[ "$(so "SECURITY_ONLY_FILE=$work/52security
SECURITY_ONLY_MARK=managed: security only
")" = true ] || r=1
[ "$(so "SECURITY_ONLY_FILE=$work/52security
SECURITY_ONLY_MARK=other text
")" = false ] || r=1
[ "$(so "SECURITY_ONLY_FILE=$work/52security
")" = true ] || r=1
[ "$(so "SECURITY_ONLY_FILE=$work/absent
")" = false ] || r=1
[ "$(so "SECURITY_ONLY_FILE=$work/../$(basename "$work")/52security
")" = false ] || r=1
[ "$(so "SECURITY_ONLY_FILE=relative
")" = false ] || r=1
result "securityOnly: false without /etc/dash-report.conf or without SECURITY_ONLY_FILE; true when the file contains the mark (or exists, without a mark); false otherwise or out of form" "$r"
r=0; grep -q 'SECURITY_ONLY_FILE' dash-report && ! grep -qE '^[^#]*(52unattended|maj-auto)' dash-report && ! grep -qE '^[[:space:]]*\.[[:space:]]+"?\$CONF_FILE|source ' dash-report || r=1
result "securityOnly: no fleet-specific path or text in the report; the settings file is never executed" "$r"

# unit names of the watched file (forced-command audit): passed to systemctl after "--" (never
# taken as an option), escaped in the JSON, comments and empty lines ignored; v9: a pattern outside
# the allowed characters (letters, digits, @ . _ : * -, 100 at most) is ignored
long=$(printf 'x%.0s' $(seq 1 101))
printf '%s\n' 'docker.service' '--version' '# comment' '' 'a"b\c.service' 'a b.service' "$long" 'nginx*' >"$work/units"
d="$work/units-case"
mkbin "$d/bin" "$def" 0 0
copy_units "$d/bin" "$d/dash-report" "$work/units"
FAKE_DIR="$here/test" FAKE_SYSTEMCTL_LOG="$work/systemctl.log" sh "$d/dash-report" fast >"$work/units.json"
check "watched units: allowed patterns only (hostile, spaced and too long ones ignored), comments ignored" "$work/units.json" \
  "w = d['systemd']['watched']; assert [x['unit'] for x in w] == ['docker.service', '--version', 'nginx*'], w"
r=1; grep -qxF '[list-units][--all][--no-legend][--plain][--no-pager][--][--version]' "$work/systemctl.log" && r=0
result "watched units: each pattern passed after \"--\" (never an option of systemctl)" "$r"

# mawk and gawk: identical outputs, except ts, uptimeSec and the values read from /proc (load,
# mem, swap), which change from one report to the next
if [ -s "$work/mawk.json" ] && [ -s "$work/gawk.json" ]; then
  python3 -c "
import json,sys
a,b = (json.load(open(f)) for f in sys.argv[1:3])
for d in (a, b):
    for k in ('ts', 'uptimeSec', 'load', 'mem', 'swap'): d.pop(k, None)
sys.exit(0 if a == b else 1)" "$work/mawk.json" "$work/gawk.json" && r=0 || r=1
  result "mawk and gawk: identical outputs (except ts, uptimeSec, load, mem, swap)" "$r"
else
  echo "skipped: mawk / gawk comparison (one implementation missing)"
fi

# static checks of the templates: no forbidden field, no whole object, Labels limited to the two
# keys of the existing list
tmpl=$(grep -o "\-\-format '[^']*'" dash-report)
bad=$(printf '%s\n' "$tmpl" | grep -oE 'Env|Cmd|Mounts|Aliases|DNSNames|DriverOpts|EndpointID|NetworkID|Gateway|IPAMConfig|Options|\{\{ *json \. *\}\}|json \.Config\}\}|json \.NetworkSettings\}\}|json \.HostConfig\}\}' | sort -u | tr '\n' ' ' || true)
result "templates: no Env, Cmd, Mounts, Aliases, DNSNames, DriverOpts, nor whole object${bad:+ (found: $bad)}" "$( [ -z "$bad" ] && echo 0 || echo 1)"
labels=$(printf '%s\n' "$tmpl" | grep -oE 'index \.Config\.Labels "[^"]*"' | sort -u | tr '\n' '|' || true)
result "templates: Labels read for the two keys of the list only (v8: no more Watchtower)" "$( [ "$labels" = 'index .Config.Labels "com.docker.compose.project"|index .Config.Labels "com.docker.compose.service"|' ] && echo 0 || echo 1)"
other=$(printf '%s\n' "$tmpl" | grep -oE '\.Labels' | wc -l)
result "templates: no other access to Labels" "$( [ "$other" -eq 2 ] && echo 0 || echo 1)"
# generic install.sh: CALLING part only, fake access command that keeps the remote script or
# reports its call, without ever running it; then the captured remote script in check mode
# (DASH_REPORT_INSTALL_CHECK=1 on the workstation → CHECK=1 at the top: stop after the
# revalidation, before any write), and its install function run alone in the bench folder.
# Atomic install (put) of the captured remote script, run alone in the bench: missing decoder,
# decoder that writes a beginning then fails, wrong checksum → the existing file stays intact, no
# temporary file left; valid case → replaced, with its permissions. $1 remote script; $2 name of
# the installed file; $3 result function of the bench
put_cases() {
  pc=$work/put
  rm -rf "$pc"
  mkdir -p "$pc/bin-none" "$pc/bin-fake" "$pc/dest"
  for t in mktemp dirname basename sha256sum cut chmod id mv rm cat; do
    p=$(command -v "$t") || continue
    ln -s "$p" "$pc/bin-none/$t"
    ln -s "$p" "$pc/bin-fake/$t"
  done
  printf '#!/bin/sh\ncat >/dev/null\nprintf "#!/bin/sh\\n"\nexit 1\n' >"$pc/bin-fake/base64"
  chmod 755 "$pc/bin-fake/base64"
  { sed -n '/^put() {/,/^}/p' "$1"; printf '%s\n' 'put "$1" 755 "$2" "$3"'; } >"$pc/put.sh"
  new=$(printf 'new agent\n' | base64 -w0)
  sum=$(printf 'new agent\n' | sha256sum | cut -d' ' -f1)
  f=$pc/dest/$2
  for c in "missing decoder:$pc/bin-none:$sum" "decoder failing after starting to write:$pc/bin-fake:$sum" "wrong checksum:$PATH:0000"; do
    label=${c%%:*}; rest=${c#*:}; bin=${rest%:*}; want=${rest##*:}
    printf 'installed agent\n' >"$f"
    chmod 755 "$f"
    PATH=$bin /bin/sh "$pc/put.sh" "$f" "$new" "$want" >/dev/null 2>&1 && rc=0 || rc=$?
    $3 "install of $2: $label → failure, existing file intact, no temporary file" "$( [ "$rc" -ne 0 ] && [ "$(cat "$f")" = 'installed agent' ] && [ "$(ls -A "$pc/dest")" = "$2" ] && echo 0 || echo 1)"
  done
  /bin/sh "$pc/put.sh" "$f" "$new" "$sum" >/dev/null 2>&1 && rc=0 || rc=$?
  $3 "install of $2: valid case → replaced (0755), no temporary file" "$( [ "$rc" -eq 0 ] && [ "$(cat "$f")" = 'new agent' ] && [ "$(stat -c %a "$f")" = 755 ] && [ "$(ls -A "$pc/dest")" = "$2" ] && echo 0 || echo 1)"
}
key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBanc banc'
nl='
'
cr=$(printf '\r')
sq="'"
# refused before any access: $1 label; rest: VAR=value assignments (env)
refused() {
  label=$1; shift
  out=$(env "$@" sh install.sh sh -c 'cat >/dev/null; echo ACCESSED' 2>&1) && rc=0 || rc=$?
  case "$out" in *ACCESSED*) result "install.sh: $label refused before any access" 1 ;; *) result "install.sh: $label refused before any access" "$( [ "$rc" -ne 0 ] && echo 0 || echo 1)" ;; esac
}
for form in multiline quote substitution return; do
  case $form in
    multiline) pk="$key${nl}ssh-ed25519 AAAAautre"; fr="192.0.2.148${nl}0.0.0.0/0"; un="a.service${nl}b.service"; sf="/etc/a${nl}/etc/b" ;;
    quote) pk="$key$sq; id; $sq"; fr="192.0.2.148$sq;id;$sq"; un="a$sq;id;$sq"; sf="/etc/a$sq;id;$sq" ;;
    substitution) pk="$key\$(id)"; fr="192.0.2.148\$(id)"; un="a\$(id)"; sf="/etc/a\$(id)" ;;
    return) pk="$key$cr"; fr="192.0.2.148$cr"; un="a.service$cr"; sf="/etc/a$cr" ;;
  esac
  refused "PUBKEY ($form)" "PUBKEY=$pk" FROM=192.0.2.148
  refused "FROM ($form)" "PUBKEY=$key" "FROM=$fr"
  refused "UNITS ($form)" "PUBKEY=$key" FROM=192.0.2.148 "UNITS=$un"
  refused "SECURITY_ONLY_FILE ($form)" "PUBKEY=$key" FROM=192.0.2.148 "SECURITY_ONLY_FILE=$sf"
  # a mark is free printable text (quotes allowed): only line feeds and carriage returns are refused
  case $form in multiline | return) refused "SECURITY_ONLY_MARK ($form)" "PUBKEY=$key" FROM=192.0.2.148 SECURITY_ONLY_FILE=/etc/apt/apt.conf.d/52security "SECURITY_ONLY_MARK=x${pk#"$key"}" ;; esac
done
refused "PUBKEY with leading options" "PUBKEY=command=\"x\" $key" FROM=192.0.2.148
refused "PUBKEY with two keys on one line" "PUBKEY=$key $key" FROM=192.0.2.148
refused "PUBKEY of another type" "PUBKEY=ssh-rsa AAAAB3NzaC1yc2E banc" FROM=192.0.2.148
for f in 0.0.0.0/0 192.0.2.148,0.0.0.0/0 ',' 1 010.0.0.1 '192.0.2.148,' ',192.0.2.148' 192.0.2.1/7 192.0.2.1/08 192.0.2.256 2001:db8::1; do
  refused "FROM \"$f\"" "PUBKEY=$key" "FROM=$f"
done
for f in relative/path /etc/../shadow '/etc/a b' /; do
  refused "SECURITY_ONLY_FILE \"$f\"" "PUBKEY=$key" FROM=192.0.2.148 "SECURITY_ONLY_FILE=$f"
done
refused "SECURITY_ONLY_MARK over 100 characters" "PUBKEY=$key" FROM=192.0.2.148 SECURITY_ONLY_FILE=/etc/x "SECURITY_ONLY_MARK=$(printf 'm%.0s' $(seq 1 101))"
refused "SECURITY_ONLY_MARK without SECURITY_ONLY_FILE" "PUBKEY=$key" FROM=192.0.2.148 SECURITY_ONLY_MARK=x
refused "FROM missing" "PUBKEY=$key"
refused "LOCAL other than 0 or 1" "PUBKEY=$key" FROM=192.0.2.148 LOCAL=2
refused "APT_LISTS other than 0 or 1" "PUBKEY=$key" FROM=192.0.2.148 APT_LISTS=oui
out=$(env PUBKEY="$key" sh install.sh sh -c 'cat >/dev/null' 2>&1 || true)
result "install.sh: \"FROM missing\" message" "$(printf '%s' "$out" | grep -q 'FROM missing' && echo 0 || echo 1)"

# valid values: captured remote script, values in base64 only, revalidation and final key
PUBKEY="$key" FROM=192.0.2.148,192.0.2.0/24 UNITS='nginx.service dash-report*' sh install.sh sh -c "cat >'$work/remote.sh'" >/dev/null 2>&1 || true
result "install.sh: remote script produced, valid sh syntax" "$( [ -s "$work/remote.sh" ] && sh -n "$work/remote.sh" && echo 0 || echo 1)"
result "install.sh: no value in clear in the remote script (key, addresses)" "$(! grep -qF 'AAAAC3NzaC1lZDI1NTE5AAAAIBanc' "$work/remote.sh" && ! grep -qF '192.0.2.148' "$work/remote.sh" && echo 0 || echo 1)"
result "install.sh: validated flags in clear, LOCAL=0 APT_LISTS=0 YES=0" "$(grep -qx 'LOCAL=0' "$work/remote.sh" && grep -qx 'APT_LISTS=0' "$work/remote.sh" && grep -qx 'YES=0' "$work/remote.sh" && echo 0 || echo 1)"
result "install.sh: without SECURITY_ONLY_FILE, /etc/dash-report.conf is not written (empty values)" "$(grep -qx "SEC_FILE_B64=''" "$work/remote.sh" && grep -qx "SEC_MARK_B64=''" "$work/remote.sh" && echo 0 || echo 1)"
# check mode decided on the workstation only: CHECK=0 at the top, the variable never read on the host
result "install.sh: check mode decided on the workstation (CHECK=0 at the top; DASH_REPORT_INSTALL_CHECK absent from the remote script)" "$(grep -qx 'CHECK=0' "$work/remote.sh" && ! grep -q 'DASH_REPORT_INSTALL_CHECK' "$work/remote.sh" && echo 0 || echo 1)"
DASH_REPORT_INSTALL_CHECK=1 PUBKEY="$key" FROM=192.0.2.148,192.0.2.0/24 UNITS='nginx.service dash-report*' sh install.sh sh -c "cat >'$work/remote-check.sh'" >/dev/null 2>&1 || true
ak=$(sh "$work/remote-check.sh" 2>&1)
result "install.sh: final authorized key = a single restrict,from=,command= line and the key, then the check marker" "$( [ "$ak" = "authorized_keys: restrict,from=\"192.0.2.148,192.0.2.0/24\",command=\"/usr/local/libexec/dash-report-ssh\" $key
dash-report: check complete (nothing installed)" ] && grep -qx 'CHECK=1' "$work/remote-check.sh" && echo 0 || echo 1)"
# v9: settings of the report, revalidated on the host, printed by the check
DASH_REPORT_INSTALL_CHECK=1 PUBKEY="$key" FROM=192.0.2.148 SECURITY_ONLY_FILE=/etc/apt/apt.conf.d/52security SECURITY_ONLY_MARK='managed (security only)' sh install.sh sh -c "cat >'$work/remote-conf.sh'" >/dev/null 2>&1 || true
out=$(sh "$work/remote-conf.sh" 2>&1)
result "install.sh: SECURITY_ONLY_FILE and SECURITY_ONLY_MARK sent in base64, revalidated and printed by the check" "$(! grep -qF '52security' "$work/remote-conf.sh" && printf '%s\n' "$out" | grep -qxF 'dash-report.conf: SECURITY_ONLY_FILE=/etc/apt/apt.conf.d/52security SECURITY_ONLY_MARK=managed (security only)' && echo 0 || echo 1)"
result "install.sh: /etc/dash-report.conf written through put (temporary file, checksum, rename) only with SECURITY_ONLY_FILE" "$(grep -q '^if \[ -n "$SEC_FILE" \]; then$' "$work/remote.sh" && grep -q '^  put /etc/dash-report.conf 644 ' "$work/remote.sh" && echo 0 || echo 1)"
refused "DASH_REPORT_INSTALL_CHECK other than 0 or 1" "PUBKEY=$key" FROM=192.0.2.148 DASH_REPORT_INSTALL_CHECK=oui
# success only on the right end marker, on the second-to-last line, with a remote code 0
ended() { # $1 label; $2 expected code (0 or 1); $3 output of the access command; rest: env
  label=$1; want=$2; script=$3; shift 3
  env PUBKEY="$key" FROM=192.0.2.148 "$@" sh install.sh sh -c "cat >/dev/null; $script" >/dev/null 2>&1 && rc=0 || rc=1
  result "install.sh: $label → code $want" "$( [ "$rc" = "$want" ] && echo 0 || echo 1)"
}
ended "end marker, code 0" 0 'echo "dash-report: installation complete"'
ended "empty output, code 0 (swallowed script)" 1 'true'
ended "marker then exit 3" 1 'echo "dash-report: installation complete"; exit 3'
ended "line after the marker" 1 'echo "dash-report: installation complete"; echo after'
ended "check run on the host (variable left in its environment) without a requested check" 1 'echo "dash-report: check complete (nothing installed)"'
ended "check requested, check marker" 0 'echo "dash-report: check complete (nothing installed)"' DASH_REPORT_INSTALL_CHECK=1
ended "check requested, installation marker" 1 'echo "dash-report: installation complete"' DASH_REPORT_INSTALL_CHECK=1
# remote script read by `sh -s`: any command that could read stdin has </dev/null (same rule as
# net-scan; quoted strings and `command -v` removed before the search)
remote_cmds=$(sed -n "/^remote=\$(cat <<'REMOTE'/,/^REMOTE/p" install.sh | sed -e ':a' -e '/\\$/{N;s/\\\n//;ba' -e '}' | grep -vE '^[[:space:]]*#')
unredirected=$(printf '%s\n' "$remote_cmds" | while IFS= read -r l; do
  bare=$(printf '%s\n' "$l" | sed -e 's/"[^"]*"//g' -e "s/'[^']*'//g" -e 's/command -v [A-Za-z-]*//g')
  if printf '%s\n' "$bare" | grep -qE '(^|[^-[:alnum:]_/.])(apt-get|apt-config|dpkg|systemctl|systemd-run|useradd|usermod|passwd|runuser|getent|id|su|sshd|visudo|ssh-keygen|sudo)( |$)' && ! printf '%s\n' "$l" | grep -q '</dev/null'; then printf '%s\n' "$l"; fi
done)
result "install.sh: </dev/null on every command of the remote script that could read stdin${unredirected:+ (missing: $(printf '%s' "$unredirected" | head -n 1))}" "$( [ -z "$unredirected" ] && echo 0 || echo 1)"
# install: never a direct decoding into an installed file
result "install.sh: no direct decoding into an installed file (put: temporary file, checksum, mv)" "$(! grep -qE '(dec|base64 -d)[^|]*> ?/(usr|etc|var)' "$work/remote.sh" && [ "$(grep -c '^[[:space:]]*put /' "$work/remote.sh")" -ge 8 ] && echo 0 || echo 1)"
put_cases "$work/remote.sh" dash-report result
result "install.sh: the written key is exactly this line (printf of akline)" "$(grep -qF 'printf '"'"'%s\n'"'"' "$akline" > /var/lib/dashreport/.ssh/authorized_keys' install.sh && echo 0 || echo 1)"
result "install.sh: UNITS without pattern expansion (dash-report* kept)" "$( [ "$(sed -n "s/^UNITS_B64='\(.*\)'\$/\1/p" "$work/remote.sh" | base64 -d)" = "nginx.service${nl}dash-report*" ] && echo 0 || echo 1)"
# values tampered with in the remote script (without the validation of the workstation): refused by
# the revalidation on the host, no key produced
tamper() { # $1 label; $2 variable; $3 value (before base64)
  v=$(printf '%s' "$3" | base64 -w0)
  sed "s|^$2='.*'\$|$2='$v'|" "$work/remote-check.sh" >"$work/remote-t.sh"
  out=$(sh "$work/remote-t.sh" 2>&1) && rc=0 || rc=$?
  result "remote script: $1 tampered with → refused on the host, no key" "$( [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'authorized_keys:' && echo 0 || echo 1)"
}
tamper "PUBKEY on two lines" PUBKEY_B64 "$key${nl}ssh-ed25519 AAAAautre"
tamper "PUBKEY with options" PUBKEY_B64 "command=\"id\" $key"
tamper "FROM 0.0.0.0/0" FROM_B64 "0.0.0.0/0"
tamper "UNITS with ;" UNITS_B64 "a.service;id"
tamper "SECURITY_ONLY_FILE with .." SEC_FILE_B64 "/etc/../etc/shadow"
tamper "SECURITY_ONLY_MARK on two lines" SEC_MARK_B64 "a${nl}b"
sed 's/^CHECK=1$/CHECK=2/' "$work/remote-check.sh" >"$work/remote-t.sh"
out=$(sh "$work/remote-t.sh" 2>&1) && rc=0 || rc=$?
result "remote script: flag CHECK=2 tampered with → refused on the host, no key" "$( [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'authorized_keys:' && echo 0 || echo 1)"
PUBKEY="$key" FROM=192.0.2.148 APT_LISTS=1 sh install.sh sh -c "cat >'$work/remote-apt.sh'" >/dev/null 2>&1 || true
result "install.sh: APT_LISTS=1 passed on; apt lists only if APT_LISTS = 1 in the remote script" "$(grep -qx 'APT_LISTS=1' "$work/remote-apt.sh" && grep -q 'if \[ "$APT_LISTS" = 1 \] && ! apt-config' "$work/remote-apt.sh" && echo 0 || echo 1)"
PUBKEY="$key" FROM=192.0.2.148 sh install.sh --yes sh -c "cat >'$work/remote-yes.sh'" >/dev/null 2>&1 || true
result "install.sh --yes: YES=1; sudo installed only if YES = 1, prerequisites before anything is installed" "$(grep -qx 'YES=1' "$work/remote-yes.sh" && grep -q '\[ "$YES" = 1 \] || { echo .*sudo missing' "$work/remote-yes.sh" && [ "$(grep -n 'sudo missing' "$work/remote-yes.sh" | cut -d: -f1)" -lt "$(grep -n '^install -d -m 755 /usr/local/sbin' "$work/remote-yes.sh" | cut -d: -f1)" ] && echo 0 || echo 1)"
LOCAL=1 sh install.sh sh -c "cat >'$work/remote-local.sh'" >/dev/null 2>&1 || true
result "install.sh LOCAL=1: local timer, without account or key (FROM not needed)" "$(grep -qx 'LOCAL=1' "$work/remote-local.sh" && grep -q 'dash-report-local.timer' "$work/remote-local.sh" && echo 0 || echo 1)"
result "install.sh: neither automatic updates (unattended-upgrades) nor another script of the repository called" "$(! grep -qE '\.\./|unattended' install.sh "$work/remote.sh" && echo 0 || echo 1)"

# install.sh never installs this bench
if grep -q 'test\.sh\|test/' install.sh; then result "install.sh does not install the bench" 1; else result "install.sh does not install the bench" 0; fi

[ "$fails" -eq 0 ] || { echo "$fails test(s) failed" >&2; exit 1; }
echo "dash-report: all tests pass"

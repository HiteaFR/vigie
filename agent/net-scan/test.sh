#!/bin/sh
# net-scan test bench: demo mode only, no network, no privilege. Run by hand or by npm test
# (server/test/agent-bench.test.js), never installed on a machine by install.sh:
#
#   sh test.sh
#
# Checks: configuration read from a file (NET_SCAN_CONF), strict validation (IFACE, private IPv4
# CIDR with a prefix from 16 to 30, unexpected line, missing file) with an ok:false JSON; valid
# JSON; only IPv4<TAB>MAC<TAB>[MAC]<TAB>[integer] lines get through (header, summary and
# booby-trapped lines dropped); REAL arp-scan 1.10 FORMAT: ${hdrmac} and ${dup} are EMPTY for a
# normal reply (→ hdrmac null, dup 0); hdrmac ≠ mac and dup passed on as is (the dashboard turns
# them into an arp_conflict); error with \ and " → valid JSON. Documentation MACs (RFC 7042),
# documentation IPs (RFC 5737). Static checks of the unit and of install.sh, and the CALLER part
# of install.sh run with a fake access command (never the remote part, nor useradd, runuser or
# systemd-run), on COPIES; 4 mutations of a copy of install.sh must each make one of the 5 cases
# fail.
set -eu
# safeguard: never as root (the caller part of install.sh is run here)
[ "$(id -u)" -ne 0 ] || { echo "test.sh refuses to run as root" >&2; exit 1; }
cd "$(dirname "$0")"
command -v python3 >/dev/null || { echo "python3 required (JSON validation)" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tab=$(printf '\t')
fails=0
# bench configuration (the real script reads /etc/net-scan.conf)
printf 'IFACE=eth0\nCIDR=192.168.10.0/24\n' >"$work/conf"
export NET_SCAN_CONF="$work/conf"

check() { # $1: label; $2: python script read on stdin (d = decoded JSON)
  if python3 -c "import json,sys; d=json.load(sys.stdin); $2" <"$work/out.json"; then
    echo "ok   $1"
  else
    echo "FAILED $1" >&2
    fails=$((fails + 1))
  fi
}

# arp-scan output with header, summary, valid lines and booby-trapped lines
{
  echo "Interface: eth0, type: EN10MB, MAC: 00:00:5e:00:53:f0, IPv4: 192.0.2.148"
  echo "Starting arp-scan 1.10.0 with 256 hosts (https://github.com/royhills/arp-scan)"
  echo "192.0.2.254${tab}00:00:5E:00:53:01${tab}${tab}"
  echo "192.0.2.98${tab}00:00:5e:00:53:02${tab}${tab}"
  echo "192.0.2.50${tab}00:00:5e:00:53:03${tab}00:00:5e:00:53:99${tab}"
  echo "192.0.2.51${tab}00:00:5e:00:53:0b${tab}${tab}2"
  echo "192.0.2.52${tab}00:00:5e:00:53:0c${tab}00:00:5e:00:53:98${tab}1"
  echo "192.0.2.57${tab}00:00:5e:00:53:0d${tab}not-a-mac${tab}"
  echo "192.0.2.58${tab}00:00:5e:00:53:0e${tab}${tab}abc"
  echo "192.0.2.59${tab}00:00:5e:00:53:0f${tab}"
  echo "192.0.2.51${tab}00:00:5e:00:53:04\"${tab}00:00:5e:00:53:04${tab}0"
  echo "192.0.2.52${tab}00:00:5e:00:53:05${tab}00:00:5e:00:53:05${tab}0${tab}fifth"
  echo "192.0.2.53${tab}00:00:5e:00:53:06${tab}00:00:5e:00:53:06"
  echo "192.0.2.256${tab}00:00:5e:00:53:07${tab}00:00:5e:00:53:07${tab}0"
  printf '192.0.2.54\t00:00:5e:00:53:08\t00:00:5e:00:53:08\t\001\n'
  echo "192.0.2.55\\\"${tab}00:00:5e:00:53:09${tab}00:00:5e:00:53:09${tab}0"
  echo "\"},{\"ip\":\"192.0.2.66${tab}00:00:5e:00:53:0a${tab}00:00:5e:00:53:0a${tab}0"
  echo ""
  echo "3 packets received by filter, 0 packets dropped by kernel"
  echo "Ending arp-scan 1.10.0: 256 hosts scanned in 2.1 seconds (121.90 hosts/sec). 3 responded"
} >"$work/demo.txt"

NET_SCAN_DEMO="$work/demo.txt" sh ./net-scan >"$work/out.json"
check "demo: valid JSON, v 1, ok, interface and network read from the conf" "assert d['v'] == 1 and d['ok'] is True and d['iface'] == 'eth0' and d['cidr'] == '192.168.10.0/24'"
check "demo: ts and duration in milliseconds" "assert d['ts'] > 1_700_000_000_000 and 0 <= d['ms'] < 60_000"
check "demo: only the 5 valid lines get through (header, summary, traps dropped)" "assert [h['ip'] for h in d['hosts']] == ['192.0.2.254', '192.0.2.98', '192.0.2.50', '192.0.2.51', '192.0.2.52']"
check "demo: normal reply (empty fields) → hdrmac null, dup 0; MAC in lowercase" "assert d['hosts'][0] == {'ip': '192.0.2.254', 'mac': '00:00:5e:00:53:01', 'hdrmac': None, 'dup': 0}"
check "demo: hdrmac alone passed on" "assert d['hosts'][2] == {'ip': '192.0.2.50', 'mac': '00:00:5e:00:53:03', 'hdrmac': '00:00:5e:00:53:99', 'dup': 0}"
check "demo: dup alone passed on" "assert d['hosts'][3] == {'ip': '192.0.2.51', 'mac': '00:00:5e:00:53:0b', 'hdrmac': None, 'dup': 2}"
check "demo: hdrmac and dup together" "assert d['hosts'][4] == {'ip': '192.0.2.52', 'mac': '00:00:5e:00:53:0c', 'hdrmac': '00:00:5e:00:53:98', 'dup': 1}"

# empty output (no reply): empty list, valid JSON
: >"$work/empty.txt"
NET_SCAN_DEMO="$work/empty.txt" sh ./net-scan >"$work/out.json"
check "empty output: hosts = []" "assert d['ok'] is True and d['hosts'] == []"

# failure, booby-trapped path (\ and "): valid JSON, fixed message, neither the path nor stderr copied
NET_SCAN_DEMO="$work/absent\\\"\"file" sh ./net-scan >"$work/out.json"
check "error with \\ and \": valid JSON, ok false, fixed message without stderr" "assert d['ok'] is False and d['error'] == 'demo: cannot read file' and 'absent' not in json.dumps(d)"

# configuration missing or invalid: JSON ok:false, fixed reason, no scan and no read of the demo
conf_case() { # $1: label; $2: content (printf); $3: expected start of the error
  printf "$2" >"$work/conf-bad"
  NET_SCAN_CONF="$work/conf-bad" NET_SCAN_DEMO="$work/demo.txt" sh ./net-scan >"$work/out.json"
  check "conf: $1" "assert d['ok'] is False and d['error'].startswith('$3') and 'hosts' not in d, d"
}
conf_case "invalid IFACE (;)" 'IFACE=eth0;rm\nCIDR=192.168.10.0/24\n' 'config invalid: IFACE'
conf_case "IFACE too long" 'IFACE=abcdefghijklmnop\nCIDR=192.168.10.0/24\n' 'config invalid: IFACE'
conf_case "public CIDR" 'IFACE=eth0\nCIDR=8.8.8.0/24\n' 'config invalid: CIDR'
conf_case "CIDR too wide (/8)" 'IFACE=eth0\nCIDR=10.0.0.0/8\n' 'config invalid: CIDR'
conf_case "CIDR outside the private block (172.32/16)" 'IFACE=eth0\nCIDR=172.32.0.0/16\n' 'config invalid: CIDR'
conf_case "CIDR /31" 'IFACE=eth0\nCIDR=192.168.10.0/31\n' 'config invalid: CIDR'
conf_case "unexpected line (never executed)" 'IFACE=eth0\nCIDR=192.168.10.0/24\nPATH=/tmp\n' 'config invalid: unexpected line'
conf_case "value with a space" 'IFACE=eth0 x\nCIDR=192.168.10.0/24\n' 'config invalid: unexpected line'
conf_case "leading zero in the CIDR (010 read as octal elsewhere)" 'IFACE=eth0\nCIDR=010.0.0.0/16\n' 'config invalid: CIDR'
conf_case "leading zero in an octet (192.168.01.0)" 'IFACE=eth0\nCIDR=192.168.01.0/24\n' 'config invalid: CIDR'
conf_case "leading zero in the prefix (/024)" 'IFACE=eth0\nCIDR=192.168.10.0/024\n' 'config invalid: CIDR'
conf_case "duplicate IFACE" 'IFACE=eth0\nIFACE=eth1\nCIDR=192.168.10.0/24\n' 'config invalid: duplicate key'
conf_case "duplicate CIDR" 'IFACE=eth0\nCIDR=192.168.10.0/24\nCIDR=192.168.11.0/24\n' 'config invalid: duplicate key'
NET_SCAN_CONF="$work/missing" NET_SCAN_DEMO="$work/demo.txt" sh ./net-scan >"$work/out.json"
check "conf missing: ok false, 'config missing'" "assert d['ok'] is False and d['error'].startswith('config missing')"
printf '# bench conf\n\nIFACE=br0.10\nCIDR=172.20.5.0/24\n' >"$work/conf-ok"
NET_SCAN_CONF="$work/conf-ok" NET_SCAN_DEMO="$work/empty.txt" sh ./net-scan >"$work/out.json"
check "conf with a comment and an empty line, 172.20.5.0/24 on br0.10" "assert d['ok'] is True and d['iface'] == 'br0.10' and d['cidr'] == '172.20.5.0/24'"
static_src=$(grep -vE '^[[:space:]]*#' net-scan)
r=1; printf '%s\n' "$static_src" | grep -qE '(^|[[:space:];])(\.|source|eval)[[:space:]]+"?\$CONF' || r=0
if [ "$r" -eq 0 ]; then echo "ok   conf never executed (no \".\", no source, no eval)"; else echo "FAILED conf executed" >&2; fails=$((fails + 1)); fi

# static checks (R3c): nothing is run, neither install.sh nor any system command
static() { # $1: label; $2: 0 if the condition is true
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else
    echo "FAILED $1" >&2
    fails=$((fails + 1))
  fi
}
has() { grep -q -- "$1" "$2" && echo 0 || echo 1; }
hasnt() { grep -q -- "$1" "$2" && echo 1 || echo 0; }
static "unit: User=net-scan and Group=net-scan, no DynamicUser" "$( [ "$(has '^User=net-scan$' net-scan.service)$(has '^Group=net-scan$' net-scan.service)$(hasnt '^DynamicUser=' net-scan.service)" = 000 ] && echo 0 || echo 1)"
static "unit: RemoveIPC=yes and full baseline" "$(for o in 'RemoveIPC=yes' 'CapabilityBoundingSet=CAP_NET_RAW' 'NoNewPrivileges=yes' 'RestrictAddressFamilies=AF_PACKET AF_UNIX AF_NETLINK AF_INET' 'ProtectSystem=strict' 'ProtectHome=yes' 'PrivateTmp=yes'; do grep -qx -- "$o" net-scan.service || { echo 1; exit; }; done; echo 0)"
static "install.sh: locked system account (useradd --system … --user-group net-scan)" "$(has 'useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group net-scan' install.sh)"
static "install.sh: pre-install test options extracted from the unit, never copied" "$(grep -qF "sed -n '/^\[Service\]/,/^\[/p'" install.sh && ! grep -qE -- '-p (ProtectSystem|DynamicUser|CapabilityBoundingSet)' install.sh && echo 0 || echo 1)"
line() { grep -n -- "$1" install.sh | cut -d: -f1 | tr '\n' ' '; }
l_i0=$(line 'systemd-run --wait')
l_start=$(line '^systemctl start net-scan.service')
l_read=$(line 'runuser -u "$NS_DASH_USER"')
l_enable=$(line '^systemctl enable --now net-scan.timer')
order="pre-install test $l_i0· start $l_start· read $l_read· enable $l_enable"
static "install.sh: pre-install test, then start without timer, then read by the dashboard account, then enable once only ($order)" "$(set -- $l_i0 $l_start $l_read $l_enable; [ $# -eq 4 ] && [ "$l_i0" -lt "$l_start" ] && [ "$l_start" -lt "$l_read" ] && [ "$l_read" -lt "$l_enable" ] && echo 0 || echo 1)"
static "install.sh: DynamicUser cleanup limited to the link and /run/private/net-scan" "$( [ "$(has 'if \[ -L /run/net-scan \]; then rm -f /run/net-scan; fi' install.sh)$(has 'if \[ -e /run/private/net-scan \]; then rm -rf /run/private/net-scan; fi' install.sh)" = 00 ] && echo 0 || echo 1)"
# remote part read by `sh -s`: any command that could read stdin has </dev/null
# (continuation lines joined), and the last message proves the run was complete
remote_cmds=$(sed -n "/^remote=\$(cat <<'REMOTE'/,/^REMOTE/p" install.sh | sed -e ':a' -e '/\\$/{N;s/\\\n//;ba' -e '}' | grep -vE '^[[:space:]]*#')
unredirected=$(printf '%s\n' "$remote_cmds" | grep -E '(^|[^-[:alnum:]_])(apt-get|systemctl|systemd-run|useradd|usermod|passwd|runuser|getent|getcap|id) ' | grep -v '</dev/null' || true)
static "install.sh: </dev/null on every command that could read stdin${unredirected:+ (missing: $(printf '%s' "$unredirected" | head -n 1))}" "$( [ -z "$unredirected" ] && echo 0 || echo 1)"
static "install.sh: final message 'installation complete', last line of the remote part" "$( [ "$(printf '%s\n' "$remote_cmds" | grep -v '^REMOTE$' | tail -n 1)" = 'echo "net-scan: installation complete"' ] && echo 0 || echo 1)"
# CALLER part of install.sh, run with a FAKE access command: it consumes the input (the
# remote script) without ever running it (no sh on stdin) and prints a scripted output;
# install.sh's exit code must reflect the marker and the remote code
# run_caller $1: copy of install.sh to run; $2: scripted output → exit code
run_caller() {
  rc=0
  IFACE=eth0 CIDR=192.168.10.0/24 sh "$1" sh -c "cat >/dev/null; $2" fake >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
# the 5 cases (scripted output, expected code), one per line: label|output|code
CASES='truncated remote script|echo '"'"'net-scan: getcap arp-scan:'"'"'|1
marker alone|echo '"'"'net-scan: installation complete'"'"'|0
marker then exit 3|echo '"'"'net-scan: installation complete'"'"'; exit 3|1
one line after the marker|echo '"'"'net-scan: installation complete'"'"'; echo '"'"'line after'"'"'|1
exit 4 without marker|echo '"'"'partial'"'"'; exit 4|1'
# working copy of the files read by install.sh (base64 of the script and units): the bench
# never runs the original, and the mutations only touch copies
copies() { # $1: directory
  mkdir -p "$1" && cp install.sh net-scan net-scan.service net-scan.timer "$1/"
}
copies "$work/ref"
printf '%s\n' "$CASES" | while IFS='|' read -r label out want; do
  got=$(run_caller "$work/ref/install.sh" "$out")
  if [ "$got" -eq "$want" ]; then echo "ok   caller: $label → code $want"; else echo "FAILED caller: $label → code $want (got $got)" >&2; echo x >>"$work/caller_fails"; fi
done
[ ! -e "$work/caller_fails" ] || fails=$((fails + $(wc -l <"$work/caller_fails")))
# mutations of a COPY of install.sh: for each, at least one of the 5 cases must fail
mutate() { # $1: label; $2: exact text to replace; $3: replacement
  d="$work/mut$(date +%s%N)"
  copies "$d"
  if ! python3 -c 'import sys;p,a,b=sys.argv[1:4];s=open(p).read();n=s.count(a);open(p,"w").write(s.replace(a,b));sys.exit(0 if n==1 else 1)' "$d/install.sh" "$2" "$3"; then
    echo "FAILED mutation not applied: $1" >&2; fails=$((fails + 1)); return
  fi
  killed=$(printf '%s\n' "$CASES" | while IFS='|' read -r label out want; do [ "$(run_caller "$d/install.sh" "$out")" -eq "$want" ] || echo k; done | wc -l)
  static "mutation detected: $1 ($killed failing cases)" "$( [ "$killed" -gt 0 ] && echo 0 || echo 1)"
}
mutate "|| true added to the error exit" 'net-scan: remote exit code 0" ] ||' 'net-scan: remote exit code 0" ] || true ||'
mutate "exit 1 removed" '(see the output above)" >&2; exit 1; }' '(see the output above)" >&2; }'
mutate "remote code ignored (rc=0 forced)" '| "$@" sh -s 2>&1 || rc=$?' '| "$@" sh -s 2>&1 || rc=0'
mutate "line after the marker accepted (grep of the marker instead of tail -n 2)" 'end=$(printf '"'"'%s\n'"'"' "$log" | tail -n 2)' 'end=$(printf '"'"'%s\n'"'"' "$log" | grep -x -e '"'"'net-scan: installation complete'"'"' -e '"'"'net-scan: remote exit code 0'"'"' | tail -n 2)'
l_group=$(line 'getent group net-scan')
l_useradd=$(line '^  useradd --system')
l_pose=$(line '^install -d -m 755 /usr/local/sbin')
static "install.sh: orphan net-scan group → explicit stop before useradd and before installing anything" "$(set -- $l_group $l_useradd $l_pose; [ $# -eq 3 ] && [ "$l_group" -lt "$l_useradd" ] && [ "$l_useradd" -lt "$l_pose" ] && grep -q 'getent group net-scan .*&& fail "net-scan group exists without a net-scan account' install.sh && echo 0 || echo 1)"
# README: the manual pre-install test lists every option of the unit (diagnostics, same list)
keys=$(sed -n '/^\[Service\]/,/^\[/p' net-scan.service | grep -E '^[A-Za-z]+=' | grep -vE '^(Type|ExecStart|RuntimeDirectory[A-Za-z]*)=' | cut -d= -f1)
missing=$(for k in $keys; do grep -q -- "-p $k=" README.md || printf '%s ' "$k"; done)
static "README: manual pre-install test with every option of the unit${missing:+ (missing: $missing)}" "$( [ -z "$missing" ] && echo 0 || echo 1)"
# this bench only runs the caller part of install.sh, with the fake access command, and
# never useradd, runuser or systemd-run (outside comments, messages and search patterns)
code=$(grep -vE '^[[:space:]]*#|^[[:space:]]*(echo|static|check|mutate)[[:space:]]|grep|keys=|missing=|order=|l_[a-z0-9]*=|remote_cmds=|unredirected=|self[a-z_]*=' test.sh)
self=$(printf '%s\n' "$code" | grep -cE 'useradd|runuser|systemd-run' || true)
# install.sh is only run by run_caller (copy, fake command); elsewhere, only copied
self_install=$(printf '%s\n' "$code" | grep -E 'install\.sh' | grep -vF 'IFACE=eth0 CIDR=192.168.10.0/24 sh "$1" sh -c "cat >/dev/null; $2" fake' | grep -vE 'sh install\.sh sh -c .cat' | grep -vE '^[[:space:]]*(mkdir -p "\$1" && cp install\.sh|got=\$\(run_caller|killed=\$\(|if ! python3 -c)' | grep -c . || true)
static "test.sh never runs useradd, runuser or systemd-run, nor install.sh outside the fake command" "$( [ "$self" -eq 0 ] && [ "$self_install" -eq 0 ] && echo 0 || echo 1)"

# install.sh: IFACE and CIDR required and validated BEFORE any access (fake access command that
# reports being called); conf installed before the first scan, restored on rollback
inst_env() { # $1 IFACE; $2 CIDR → "ACCESSED" if the access command was called
  IFACE="$1" CIDR="$2" sh install.sh sh -c 'cat >/dev/null; echo ACCESSED; echo "net-scan: installation complete"' 2>&1 | tr '\n' ' '
}
for bad in 'eth0;x|192.168.10.0/24' '|192.168.10.0/24' 'eth0|' 'eth0|8.8.8.0/24' 'eth0|10.0.0.0/8'; do
  out=$(inst_env "${bad%%|*}" "${bad#*|}")
  static "install.sh: IFACE/CIDR refused before any access ('${bad%%|*}', '${bad#*|}')" "$(printf '%s' "$out" | grep -q ACCESSED && echo 1 || echo 0)"
done
# atomic install (put) from the captured remote script, run alone in the bench: missing decoder,
# decoder that writes a beginning then fails, wrong checksum → the existing file stays intact, no
# temporary file left; valid case → replaced, with its permissions. $1 remote script; $2 name of
# the installed file; $3 bench result function
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
  for c in "decoder missing:$pc/bin-none:$sum" "decoder failing after a partial write:$pc/bin-fake:$sum" "wrong checksum:$PATH:0000"; do
    label=${c%%:*}; rest=${c#*:}; bin=${rest%:*}; want=${rest##*:}
    printf 'existing agent\n' >"$f"
    chmod 755 "$f"
    PATH=$bin /bin/sh "$pc/put.sh" "$f" "$new" "$want" >/dev/null 2>&1 && rc=0 || rc=$?
    $3 "install of $2: $label → failure, existing file intact, no temporary file" "$( [ "$rc" -ne 0 ] && [ "$(cat "$f")" = 'existing agent' ] && [ "$(ls -A "$pc/dest")" = "$2" ] && echo 0 || echo 1)"
  done
  /bin/sh "$pc/put.sh" "$f" "$new" "$sum" >/dev/null 2>&1 && rc=0 || rc=$?
  $3 "install of $2: valid case → replaced (0755), no temporary file" "$( [ "$rc" -eq 0 ] && [ "$(cat "$f")" = 'new agent' ] && [ "$(stat -c %a "$f")" = 755 ] && [ "$(ls -A "$pc/dest")" = "$2" ] && echo 0 || echo 1)"
}
# B1 (qa review): each variable in four hostile forms, refused before any access
nl='
'
cr=$(printf '\r')
sq="'"
hostile() { # $1 label; rest: VAR=value assignments
  label=$1; shift
  out=$(env "$@" sh install.sh sh -c 'cat >/dev/null; echo ACCESSED; echo "net-scan: installation complete"' 2>&1 || true)
  static "install.sh: $label refused before any access" "$(printf '%s' "$out" | grep -q ACCESSED && echo 1 || echo 0)"
}
for form in multiline apostrophe substitution CR; do
  case $form in
    multiline) i="eth0${nl}x"; c="192.168.10.0/24${nl}10.0.0.0/8"; u="vigie${nl}root" ;;
    apostrophe) i="eth0$sq;id;$sq"; c="192.168.10.0/24$sq;id;$sq"; u="vigie$sq;id;$sq" ;;
    substitution) i="eth\$(id)"; c="192.168.10.0/24\$(id)"; u="vigie\$(id)" ;;
    CR) i="eth0$cr"; c="192.168.10.0/24$cr"; u="vigie$cr" ;;
  esac
  hostile "IFACE ($form)" "IFACE=$i" CIDR=192.168.10.0/24
  hostile "CIDR ($form)" IFACE=eth0 "CIDR=$c"
  hostile "DASH_USER ($form)" IFACE=eth0 CIDR=192.168.10.0/24 "DASH_USER=$u"
done
hostile "CIDR with a leading zero (010.0.0.0/16)" IFACE=eth0 CIDR=010.0.0.0/16
# valid values: remote script captured, values in base64 only, revalidation on the machine
IFACE=eth0 CIDR=192.168.10.0/24 sh install.sh sh -c "cat >'$work/remote.sh'; echo 'net-scan: installation complete'" >/dev/null 2>&1 || true
static "install.sh: values in base64 only in the remote script (neither eth0 nor 192.168.10)" "$(! grep -qE 'eth0|192\.168\.10' "$work/remote.sh" && grep -q "^NS_IFACE_B64='" "$work/remote.sh" && echo 0 || echo 1)"
# check mode decided on the workstation only: CHECK=0 at the top, the variable never read on the machine
static "install.sh: check mode decided on the workstation (CHECK=0 at the top; NET_SCAN_INSTALL_CHECK absent from the remote script)" "$(grep -qx 'CHECK=0' "$work/remote.sh" && ! grep -q 'NET_SCAN_INSTALL_CHECK' "$work/remote.sh" && echo 0 || echo 1)"
NET_SCAN_INSTALL_CHECK=1 IFACE=eth0 CIDR=192.168.10.0/24 sh install.sh sh -c "cat >'$work/remote-check.sh'; echo \"net-scan: check complete (nothing installed)\"" >/dev/null 2>&1 || true
chk=$(sh "$work/remote-check.sh" 2>&1)
static "install.sh: revalidation on the machine, conf and reader account (vigie by default), then the check marker" "$( [ "$chk" = "net-scan.conf: IFACE=eth0 CIDR=192.168.10.0/24; reader vigie
net-scan: check complete (nothing installed)" ] && grep -qx 'CHECK=1' "$work/remote-check.sh" && echo 0 || echo 1)"
hostile "NET_SCAN_INSTALL_CHECK other than 0 or 1" IFACE=eth0 CIDR=192.168.10.0/24 NET_SCAN_INSTALL_CHECK=yes
ended() { # $1 label; $2 expected code (0 or 1); $3 output of the access command; rest: env
  label=$1; want=$2; script=$3; shift 3
  env IFACE=eth0 CIDR=192.168.10.0/24 "$@" sh install.sh sh -c "cat >/dev/null; $script" >/dev/null 2>&1 && rc=0 || rc=1
  static "install.sh: $label → code $want" "$( [ "$rc" = "$want" ] && echo 0 || echo 1)"
}
ended "check run on the machine (variable left in its environment) without a check requested" 1 "echo \"net-scan: check complete (nothing installed)\""
ended "check requested, check marker" 0 "echo \"net-scan: check complete (nothing installed)\"" NET_SCAN_INSTALL_CHECK=1
ended "check requested, installation marker" 1 'echo "net-scan: installation complete"' NET_SCAN_INSTALL_CHECK=1
# install: files decoded and verified before installing anything, then installed by put (never a direct decode)
static "install.sh: no direct decode into an installed file (put: temporary file, checksum, mv), decoding verified before installing anything" "$(! grep -qE 'base64 -d[^|]*> ?/(usr|etc)' "$work/remote.sh" && [ "$(grep -c '^[[:space:]]*put /' "$work/remote.sh")" -eq 3 ] && [ "$(grep -n 'put \"\$work/net-scan\" 755' "$work/remote.sh" | cut -d: -f1)" -lt "$(grep -n '^conf_prev=\"\"' "$work/remote.sh" | cut -d: -f1)" ] && echo 0 || echo 1)"
put_cases "$work/remote.sh" net-scan static
tamper() { # $1 label; $2 variable; $3 value (before base64)
  v=$(printf '%s' "$3" | base64 -w0)
  sed "s|^$2='.*'\$|$2='$v'|" "$work/remote-check.sh" >"$work/remote-t.sh"
  out=$(sh "$work/remote-t.sh" 2>&1) && rc=0 || rc=$?
  static "remote script: $1 tampered → refused on the machine" "$( [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q 'net-scan.conf:' && echo 0 || echo 1)"
}
tamper "IFACE on two lines" NS_IFACE_B64 "eth0${nl}PATH=/tmp"
tamper "public CIDR" NS_CIDR_B64 "8.8.8.0/24"
tamper "DASH_USER with ;" NS_DASH_USER_B64 "vigie;id"
l_conf=$(line '^mv -f /etc/.net-scan.conf.new /etc/net-scan.conf')
static "install.sh: conf installed (0644, root) after the pre-install test and before the first scan" "$(set -- $l_i0 $l_conf $l_start; [ $# -eq 3 ] && [ "$l_i0" -lt "$l_conf" ] && [ "$l_conf" -lt "$l_start" ] && grep -q 'chmod 644 /etc/.net-scan.conf.new' install.sh && echo 0 || echo 1)"
static "install.sh: rollback restores the previous conf (or removes it)" "$(grep -q 'mv -f "$conf_prev" /etc/net-scan.conf; elif \[ "${conf_new:-0}" = 1 \]; then rm -f /etc/net-scan.conf; fi' install.sh && echo 0 || echo 1)"

# install.sh never installs this bench on the machine
if grep -q 'test\.sh' install.sh; then
  echo "FAILED install.sh mentions test.sh" >&2
  fails=$((fails + 1))
else
  echo "ok   install.sh does not install test.sh"
fi

[ "$fails" -eq 0 ] || { echo "$fails test(s) failed" >&2; exit 1; }
echo "net-scan: all tests passed"

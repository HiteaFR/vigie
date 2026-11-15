#!/bin/sh
# Loop of the ARP companion (docker/net-scan/Dockerfile): instead of the systemd timer of
# agent/net-scan (net-scan.timer, every 120 s), one scan every NET_SCAN_INTERVAL seconds (30 to
# 3600, default 120), written like net-scan.service: output to arp.json.tmp, then renamed (never a
# half-written file). net-scan reads /etc/net-scan.conf, mounted read-only; missing or invalid
# conf: it writes a JSON "ok":false, which Vigie shows.
# NET_SCAN_DIR (default /run/net-scan) and NET_SCAN_BIN: for the test bench only.
set -u
interval=${NET_SCAN_INTERVAL:-120}
dir=${NET_SCAN_DIR:-/run/net-scan}
bin=${NET_SCAN_BIN:-/usr/local/sbin/net-scan}
case $interval in '' | *[!0-9]* | 0*) echo "net-scan: NET_SCAN_INTERVAL must be an integer from 30 to 3600" >&2; exit 2 ;; esac
[ "$interval" -ge 30 ] && [ "$interval" -le 3600 ] || { echo "net-scan: NET_SCAN_INTERVAL must be an integer from 30 to 3600" >&2; exit 2; }
[ -d "$dir" ] && [ ! -L "$dir" ] || { echo "net-scan: $dir must be a real directory (volume)" >&2; exit 1; }
umask 022
trap 'exit 0' TERM INT
while :; do
  if "$bin" >"$dir/arp.json.tmp"; then
    mv -f "$dir/arp.json.tmp" "$dir/arp.json"
  else
    rc=$?
    rm -f "$dir/arp.json.tmp"
    echo "net-scan: failed (code $rc)" >&2
  fi
  [ "${NET_SCAN_ONCE:-0}" = 1 ] && exit 0
  sleep "$interval" &
  wait $!
done

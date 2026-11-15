#!/bin/sh
# Icons outside the repository, in a persistent folder (default: <state directory>/icons, for
# example /var/lib/vigie/icons, next to the database, outside the deployed tree that
# deploy/sync.sh overwrites). Meant for a deployment pipeline (it can be sent over ssh on standard
# input: the script is self-contained).
# No network: downloading (scripts/vendor-icons.mjs) is a manual step. See docs/icons.md.
#
#   deploy/icons-migrate.sh <old tree> <icons directory>
#
# Run BEFORE the synchronization that erases <old tree>/client/{dist,public}/icons. Copies, file
# by file, every icon of the old tree that is MISSING from the icons directory, never
# overwriting one: a partial directory (interrupted run) gets completed, a complete directory
# does not change (idempotent). Source: <old tree>/client/dist/icons, then client/public/icons.
# Only regular files matching the icon pattern are copied; no link is followed (source, target
# file or directory). Missing source → nothing, exit 0. A failed copy → non-zero exit: the
# deployment stops before the synchronization, the old tree and its icons stay.
# Then the directory and the files are given to the owner of the parent directory (read with
# stat, no hard-coded name), as 0755 and 0644. One "icons: …" summary line.
#
# pattern: ^([a-z0-9-]+)\.(svg|png)$ (ICON_FILE of server/lib/icons.js; equality checked by the tests)
set -eu
# character ranges in the byte sense, whatever the locale of the runner
LC_ALL=C
export LC_ALL

[ $# -eq 2 ] || { echo "usage: $0 <old tree> <icons directory>" >&2; exit 2; }
old=${1%/}
dest=${2%/}

icone() { # file name → true if it matches the pattern
  case "$1" in
    *.svg | *.png) ;;
    *) return 1 ;;
  esac
  slug=${1%.*}
  case "$slug" in
    '' | *[!a-z0-9-]*) return 1 ;;
  esac
  return 0
}

if [ -L "$dest" ]; then echo "icons: $dest is a link, refused" >&2; exit 1; fi
found=0
for src in "$old/client/dist/icons" "$old/client/public/icons"; do
  if [ -d "$src" ] && [ ! -L "$src" ]; then found=1; fi
done
if [ "$found" = 0 ]; then echo "icons: nothing to migrate (no icon in $old)"; exit 0; fi

mkdir -p "$dest"
copied=0
present=0
seen=" "
for src in "$old/client/dist/icons" "$old/client/public/icons"; do
  [ -d "$src" ] && [ ! -L "$src" ] || continue
  for f in "$src"/*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    b=${f##*/}
    icone "$b" || continue
    case "$seen" in *" $b "*) continue ;; esac # same name already handled (dist wins over public)
    seen="$seen$b "
    if [ -e "$dest/$b" ] || [ -L "$dest/$b" ]; then
      present=$((present + 1)) # already there: never overwritten
      continue
    fi
    cp -T "$f" "$dest/.$b.tmp"
    chmod 0644 "$dest/.$b.tmp"
    mv -T "$dest/.$b.tmp" "$dest/$b"
    copied=$((copied + 1))
  done
done

owner=$(stat -c '%u:%g' "$(dirname "$dest")")
chown -R -h "$owner" "$dest"
chmod 0755 "$dest"
find "$dest" -maxdepth 1 -type f -exec chmod 0644 {} +
echo "icons: $copied copied, $present already present ($dest)"

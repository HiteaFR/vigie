#!/bin/sh
# Synchronization step of a deployment (also replayed as is by server/test/deploy-assets.test.js).
#   deploy/sync.sh <source> <destination> [extra rsync options, e.g. --exclude …]
# <destination>: local path, or host:path (ssh).
# 1. The hashed assets of the new build are ADDED next to the old ones (never --delete): the
#    served build does not change yet (index.html is still the old one).
# 2. The rest is synchronized with --delete, EXCEPT client/dist/assets/ and client/dist/.vite/:
#    these excluded patterns, anchored at the root of the transfer, are neither transferred nor
#    erased on the receiving side (no --delete-excluded). index.html moves to the new build, whose
#    chunks are already there; a tab on the old build still finds its own.
# Cleaning up the old chunks (deploy/prune-assets.mjs) comes AFTER the healthcheck.
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <source> <destination> [rsync options]" >&2; exit 2; }
SRC=${1%/}
DEST=${2%/}
shift 2
[ -d "$SRC/client/dist/assets" ] || { echo "✗ $SRC/client/dist/assets missing: no build" >&2; exit 1; }
case "$DEST" in
  *:*) ssh "${DEST%%:*}" "mkdir -p '${DEST#*:}/client/dist/assets'" ;;
  *) mkdir -p "$DEST/client/dist/assets" ;;
esac
rsync -a "$SRC/client/dist/assets/" "$DEST/client/dist/assets/"
rsync -a --delete \
  --exclude .git \
  --exclude .env \
  --exclude /client/dist/assets/ \
  --exclude /client/dist/.vite/ \
  "$@" \
  "$SRC/" "$DEST/"

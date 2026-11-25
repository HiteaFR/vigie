#!/bin/sh
# Proof of the Vigie Docker image, to run on a TEST Docker machine, with the owner's consent,
# from a copy of the repository (the commit to prove):
#
#   sh scripts/docker-proof.sh            # or VIGIE_PROOF_PORT=18188 sh scripts/docker-proof.sh
#
# Variables (all optional):
#   VIGIE_PROOF_PORT      test port (default 18088), must be free
#   VIGIE_PROOF_IMAGE     image already built or pulled (for instance a release candidate pulled by
#                         digest): it is tagged with the unique name of the run instead of being
#                         built; it must carry the commit of this copy (REVISION)
#   VIGIE_PROOF_PLATFORM  linux/amd64 or linux/arm64: platform the containers run on (another
#                         architecture needs QEMU on the machine), checked inside the running
#                         container (uname -m)
#   VIGIE_PROOF_WAIT      seconds allowed for each healthy state (default 90; more under QEMU)
#   VIGIE_PROOF_VERSION   version that /api/healthz must report (x.y.z)
#
# Touches NO existing container, volume, network or image: compose project with a unique name
# (vigie-proof-<date>-<pid>), image with a unique tag, refusal if any of them already exists,
# free test port required; everything is created in a throw-away directory (mktemp) from
# "git archive" (no untracked file, so no .env nor config.json, enters the build context) and
# removed at the end, even on failure (down -v --rmi all of the test project ONLY, and only if
# the compose images are its unique tags). The base image (node:22…, pinned) and the build cache
# stay on the machine: the cache size is reported at the end, nothing is pruned.
#
# Steps (each one shown "ok" or "FAILED", stop at the first failure):
#   1. image build (REVISION = commit), or the given image tagged with the unique name;
#   2. start WITHOUT a config: "docker compose run --rm init" message in the log, "setup needed"
#      mode (/api/healthz: unconfigured true), no file created in /etc/vigie;
#   3. non-interactive init (random test password, through a variable, never as an argument);
#   4. start: Docker healthcheck "healthy", /api/healthz 200 with the right commit;
#   5. admin login over loopback (host mode), then admin session;
#   6. permissions: /var/lib/vigie and the database owned by uid 1000, vigie.env 0600, /etc/vigie
#      read only for the service;
#   7. restart: database kept, service healthy again;
#   8. stop and cleanup.
# The ARP companion is only built (--with-net-scan): running it would scan a network.
set -eu
# the operator's compose settings are neutralised: file (-f), project (-p) and profiles are always
# explicit below, never inherited
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
WITH_NET_SCAN=0
[ "${1:-}" = --with-net-scan ] && { WITH_NET_SCAN=1; shift; }
[ $# -eq 0 ] || { sed -n 2,37p "$0"; exit 2; }

SRC=$(cd "$(dirname "$0")/.." && pwd)
PORT=${VIGIE_PROOF_PORT:-18088}
case $PORT in '' | *[!0-9]*) echo "VIGIE_PROOF_PORT: number expected" >&2; exit 2 ;; esac
WAIT=${VIGIE_PROOF_WAIT:-90}
case $WAIT in '' | *[!0-9]*) echo "VIGIE_PROOF_WAIT: number of seconds expected" >&2; exit 2 ;; esac
[ "$WAIT" -ge 30 ] || { echo "VIGIE_PROOF_WAIT: 30 seconds at least (first healthcheck after 30 s)" >&2; exit 2; }
GIVEN=${VIGIE_PROOF_IMAGE:-}
PLATFORM=${VIGIE_PROOF_PLATFORM:-}
case $PLATFORM in '' | linux/amd64 | linux/arm64) ;; *) echo "VIGIE_PROOF_PLATFORM: linux/amd64 or linux/arm64 expected" >&2; exit 2 ;; esac
VERSION=${VIGIE_PROOF_VERSION:-}
case $VERSION in '') ;; *[!0-9.]* | .* | *. | *..*) echo "VIGIE_PROOF_VERSION: x.y.z expected" >&2; exit 2 ;; esac
PROJECT=vigie-proof-$(date +%Y%m%d%H%M%S)-$$
IMAGE=$PROJECT:local
NS_IMAGE=$PROJECT-net-scan:local
REV=$(git -C "$SRC" rev-parse HEAD)

ok() { printf 'ok   %s\n' "$*"; }
ko() { printf 'FAILED %s\n' "$*" >&2; exit 1; }

for t in docker git curl tar ss; do command -v "$t" >/dev/null || ko "missing tool: $t"; done
docker compose version >/dev/null 2>&1 || ko "docker compose (v2) missing"

# --- refuse if anything with the same name already exists -----------------------------------------
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ] || ko "containers of project $PROJECT already exist"
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ] || ko "volumes of project $PROJECT already exist"
[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")" ] || ko "networks of project $PROJECT already exist"
! docker image inspect "$IMAGE" >/dev/null 2>&1 || ko "image $IMAGE already exists"
! docker image inspect "$NS_IMAGE" >/dev/null 2>&1 || ko "image $NS_IMAGE already exists"
[ -z "$GIVEN" ] || docker image inspect "$GIVEN" >/dev/null 2>&1 || ko "image $GIVEN (VIGIE_PROOF_IMAGE) not found on this machine"
! ss -Hltn "sport = :$PORT" | grep -q . || ko "port $PORT already open on this machine (VIGIE_PROOF_PORT)"

# unique names exported BEFORE any extraction: the compose file is never read with its default names
export VIGIE_IMAGE="$IMAGE" VIGIE_NET_SCAN_IMAGE="$NS_IMAGE" VIGIE_REVISION="$REV" VIGIE_PORT="$PORT"
# containers (and a build) of the requested platform
[ -z "$PLATFORM" ] || export DOCKER_DEFAULT_PLATFORM="$PLATFORM"
WORK=$(mktemp -d)
cleanup() {
  rc=$?
  # down only if the compose images are EXACTLY the unique tags of this run
  if [ -f "$WORK/src/docker-compose.yml" ] && [ "${VIGIE_IMAGE:-}" = "$IMAGE" ] && [ "${VIGIE_NET_SCAN_IMAGE:-}" = "$NS_IMAGE" ]; then
    (cd "$WORK/src" && docker compose -f "$WORK/src/docker-compose.yml" -p "$PROJECT" --profile init --profile arp down -v --rmi all --remove-orphans >/dev/null 2>&1) || true
  fi
  rm -rf "$WORK"
  [ "$rc" -eq 0 ] && echo "cleanup done (project $PROJECT)" || echo "cleanup done (project $PROJECT) after a failure, code $rc" >&2
  # the build cache (npm layers of the client and server-deps stages) and the base image stay:
  # size reported, nothing is pruned
  cache=$(docker system df --format '{{.Type}}: {{.Size}} ({{.Reclaimable}} reclaimable)' 2>/dev/null | grep -i '^build cache' || true)
  printf 'build cache kept, not pruned: %s; free it by hand if needed (docker builder prune)\n' "${cache:-unknown size}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir "$WORK/src"
git -C "$SRC" archive HEAD | tar -x -C "$WORK/src"
cd "$WORK/src"
dc() { docker compose -f "$WORK/src/docker-compose.yml" -p "$PROJECT" "$@"; }
url=http://127.0.0.1:$PORT

# bounded wait for a Docker health state (VIGIE_PROOF_WAIT, 90 s by default: first check after 30 s)
wait_health() {
  i=0
  while [ $i -lt $((WAIT / 2)) ]; do
    st=$(docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q vigie)" 2>/dev/null || echo absent)
    [ "$st" = healthy ] && return 0
    i=$((i + 1))
    sleep 2
  done
  dc logs --no-color vigie | tail -n 30 >&2
  return 1
}

# 1. build, or the given image under the unique name (removed with the project at cleanup)
if [ -n "$GIVEN" ]; then
  docker tag "$GIVEN" "$IMAGE" || ko "1. tag of $GIVEN"
  ok "1. image given ($GIVEN), tagged $IMAGE"
else
  dc build vigie >/dev/null || ko "image build"
  ok "1. image built ($IMAGE, REVISION $REV)"
fi
if [ "$WITH_NET_SCAN" = 1 ]; then
  dc --profile arp build net-scan >/dev/null || ko "build of the ARP companion"
  ok "1b. ARP companion built ($NS_IMAGE), not started"
fi

# 2. without a config
dc up -d vigie >/dev/null || ko "start without a config"
wait_health || ko "2. service without a config not healthy"
dc logs --no-color vigie 2>&1 | grep -q 'docker compose run --rm init' || ko "2. message about docker compose run --rm init missing from the log"
curl -fsS "$url/api/healthz" | grep -q '"unconfigured":true' || ko "2. /api/healthz without unconfigured:true"
[ -z "$(dc exec -T vigie ls -A /etc/vigie | grep -v '^pki$' || true)" ] || ko "2. file created in /etc/vigie without init"
ok "2. without a config: init message, setup-needed mode, nothing written in /etc/vigie"
dc stop vigie >/dev/null

# 3. non-interactive init: test password through a variable (never as an argument)
pw=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)Aa1
VIGIE_INIT_ADMIN_PASSWORD=$pw dc run --rm -T -e VIGIE_INIT_ADMIN_PASSWORD init --non-interactive --skip-tests --title 'Vigie proof' >/dev/null || ko "3. non-interactive init"
ok "3. non-interactive init (config, vigie.env)"

# 4. configured start
dc up -d vigie >/dev/null || ko "4. start"
wait_health || ko "4. healthcheck Docker"
h=$(curl -fsS -o /dev/null -w '%{http_code}' "$url/api/healthz") || true
[ "$h" = 200 ] || ko "4. /api/healthz answered $h"
curl -fsS "$url/api/healthz" | grep -q "\"commit\":\"$REV\"" || ko "4. expected commit missing from /api/healthz"
! curl -fsS "$url/api/healthz" | grep -q '"unconfigured"' || ko "4. still in setup-needed mode"
[ -z "$VERSION" ] || curl -fsS "$url/api/healthz" | grep -q "\"version\":\"$VERSION\"" || ko "4. version $VERSION missing from /api/healthz"
ok "4. healthy, /api/healthz 200, commit $REV${VERSION:+, version $VERSION}"
if [ -n "$PLATFORM" ]; then
  # architecture seen INSIDE the running container (not only what the image claims)
  case $PLATFORM in linux/amd64) want=x86_64 ;; linux/arm64) want=aarch64 ;; esac
  got=$(dc exec -T vigie uname -m | tr -d '\r')
  [ "$got" = "$want" ] || ko "4. container runs on $got, $want expected ($PLATFORM)"
  ok "4. container on $PLATFORM ($got)"
fi

# 5. admin login over loopback (password on curl's standard input, never as an argument)
jar=$WORK/cookies
printf '{"password":"%s"}' "$pw" | curl -fsS -c "$jar" -o /dev/null -H 'Content-Type: application/json' -H "Origin: $url" --data-binary @- "$url/api/login" || ko "5. admin login"
curl -fsS -b "$jar" "$url/api/session" | grep -q '"admin":true' || ko "5. admin session"
ok "5. admin login over loopback, admin session"

# 6. permissions
dc exec -T vigie sh -c 'stat -c "%u %a %n" /var/lib/vigie /var/lib/vigie/dashboard.db /etc/vigie/vigie.env /etc/vigie/config.json' >"$WORK/stat" || ko "6. stat"
grep -q '^1000 [0-7]* /var/lib/vigie$' "$WORK/stat" && grep -q '^1000 [0-7]* /var/lib/vigie/dashboard.db$' "$WORK/stat" || ko "6. /var/lib/vigie or the database not owned by uid 1000: $(tr '\n' ';' <"$WORK/stat")"
grep -q '^1000 600 /etc/vigie/vigie.env$' "$WORK/stat" || ko "6. vigie.env not 0600 for uid 1000"
! dc exec -T vigie sh -c 'touch /etc/vigie/write-test' 2>/dev/null || ko "6. /etc/vigie writable by the service"
[ "$(dc exec -T vigie id -u | tr -d '\r')" = 1000 ] || ko "6. service not running as uid 1000"
ok "6. uid 1000, database and vigie.env, /etc/vigie read only"

# 7. restart
dc restart vigie >/dev/null || ko "7. restart"
wait_health || ko "7. healthcheck after restart"
dc exec -T vigie test -s /var/lib/vigie/dashboard.db || ko "7. database lost"
ok "7. restart: database kept, healthy"

# 8. stop (cleanup follows, trap)
dc down >/dev/null || ko "8. stop"
ok "8. stopped; proof complete"

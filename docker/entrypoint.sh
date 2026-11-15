#!/bin/sh
# Entry point of the Vigie image. Commands:
#   serve          (default) the server; no config → a message and the "setup needed" mode
#   init [options] setup wizard (server/scripts/init.js), the image paths given EXPLICITLY
#                  (--config, --env, --pki, --state): its safeguards refuse /etc and /var/lib
#                  otherwise; options given after them override them
#   check-config   validates the config (CONFIG_PATH)
#   icons [--force] downloads the icons of the config into the state directory (scripts/vendor-icons.mjs)
#   help
# NEVER creates a password or any other secret: without a config, the server starts in the
# "setup needed" mode and its log says to run init. Refuses to run as root.
# VIGIE_APP (default /app): root of the code, for the test bench only (server/test/docker.test.js).
set -eu
APP=${VIGIE_APP:-/app}
NODE_OPTS=--disable-warning=ExperimentalWarning

say() { printf 'vigie: %s\n' "$*" >&2; }
need() { # $1 variable name; $2 value
  [ -n "$2" ] || { say "$1 empty: a path is expected (variable of the image)"; exit 2; }
}

[ "$(id -u)" != 0 ] || { say "refusing to run as root (node user of the image, uid 1000)"; exit 1; }

cmd=${1:-serve}
[ $# -eq 0 ] || shift
cd "$APP/server"

case "$cmd" in
  serve)
    [ $# -eq 0 ] || { say "serve takes no argument"; exit 2; }
    # "setup needed" mode only if CONFIG_PATH is absent from the environment AND nothing is at
    # <root>/config.json: CONFIG_PATH (set by the image) is removed when it points to nothing at
    # all (no file, no link, even broken). An empty CONFIG_PATH stays a server error, as outside
    # a container
    if [ -n "${CONFIG_PATH:-}" ] && [ ! -e "$CONFIG_PATH" ] && [ ! -L "$CONFIG_PATH" ]; then
      if [ -e "$APP/config.json" ] || [ -L "$APP/config.json" ]; then
        say "$APP/config.json found in the image: refused (the config lives in /etc/vigie)"
        exit 1
      fi
      say "no config ($CONFIG_PATH): run \"docker compose run --rm init\" (wizard, or --non-interactive), then restart; starting in the \"setup needed\" mode (no password is created)"
      unset CONFIG_PATH
    fi
    exec node "$NODE_OPTS" index.js
    ;;
  init)
    need CONFIG_PATH "${CONFIG_PATH:-}"
    need ENV_FILE "${ENV_FILE:-}"
    need PKI_DIR "${PKI_DIR:-}"
    need STATE_DIRECTORY "${STATE_DIRECTORY:-}"
    rc=0
    node "$NODE_OPTS" scripts/init.js --config "$CONFIG_PATH" --env "$ENV_FILE" --pki "$PKI_DIR" --state "$STATE_DIRECTORY" "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then
      case " $* " in *' --help '* | *' -h '*) ;; *) say "in a container: start (or restart) the service with \"docker compose up -d\"" ;; esac
    fi
    exit "$rc"
    ;;
  check-config)
    need CONFIG_PATH "${CONFIG_PATH:-}"
    [ $# -eq 0 ] || { say "check-config takes no argument (CONFIG_PATH)"; exit 2; }
    exec node "$NODE_OPTS" scripts/check-config.js "$CONFIG_PATH"
    ;;
  icons)
    exec node "$NODE_OPTS" "$APP/scripts/vendor-icons.mjs" "$@"
    ;;
  help | --help | -h)
    sed -n '2,12p' "$0" >&2
    ;;
  *)
    say "unknown command (serve, init, check-config, icons, help)"
    exit 2
    ;;
esac

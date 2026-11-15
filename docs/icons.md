# Icons

Service and bookmark logos (`services[].icon`, `bookmarks[].items[].icon`) are **not shipped with
the project**. They are trademarks, owned by their respective owners. You **download them yourself,
at install time**, with `scripts/vendor-icons.mjs`. The script fetches them from two public
catalogs (the ones Homepage uses), in this order:

1. [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) (SVG first, then PNG);
2. [selfh.st/icons](https://github.com/selfhst/icons).

According to their `LICENSE` files (checked in November 2026), dashboard-icons is under Apache-2.0
and selfh.st/icons under CC BY 4.0, which requires attribution. These licenses cover the
repositories. They grant no right on the trademarks shown. The [`NOTICE`](../NOTICE) file
summarizes this.

Without an icon, a service shows a monogram.

## Where icons live

- The folder is `ICONS_DIR` if set, otherwise `<state directory>/icons`, next to the database:
  `$STATE_DIRECTORY` (`/var/lib/vigie/icons` under systemd), or `<repo root>/data/icons`
  when running locally.
- Never put them in `/opt/vigie`: a deployment overwrites it.
- The server serves them under `/icons/*`, with a strict CSP for SVG files and one day of cache.
  It reads the list of icons at startup. In development, Vite forwards `/icons` to the backend.
- A missing or empty folder is fine: every service shows its monogram.

## Downloading icons

Run the script by hand after you add a service or a bookmark with an `icon`. It downloads the
missing icons; `--force` downloads everything again. It reads the configuration from
`CONFIG_PATH` (default: `<repo root>/config.json`).

Safeguards:

- slugs must match `[a-z0-9-]`;
- an active SVG is refused (script, event handler, `javascript:`, `foreignObject`);
- 200 KB at most per icon, 10 s per request;
- 200 icons and 20 MiB at most per run, and 120 s in total; whatever is left is reported as not
  processed;
- with `--force`, an icon already there is kept when its new download fails, offline for example
  (reported as kept);
- leftover `.*.tmp` files from an interrupted run are deleted when the script starts.

An icon that cannot be found is not an error: the service keeps its monogram.

The server reads the list of icons **only at startup**, so restart the service after a download.
The server itself never makes an outgoing request for icons.

On a systemd install, as root:

```sh
cd /opt/vigie
CONFIG_PATH=/etc/vigie/config.json ICONS_DIR=/var/lib/vigie/icons timeout 120 node scripts/vendor-icons.mjs
chown -R --reference=/var/lib/vigie /var/lib/vigie/icons
systemctl restart vigie
```

Or run it as the owner of the state directory, and skip the `chown`:

```sh
runuser -u <owner> -- env CONFIG_PATH=/etc/vigie/config.json ICONS_DIR=/var/lib/vigie/icons timeout 120 node scripts/vendor-icons.mjs
```

## Attribution

`ICONS_DIR/sources.json` records, for each file, the catalog and the URL it came from. An icon
carried over from an older install has no recorded source; `--force` downloads it again, with its
source.

This file is not served: `/icons` only serves `<slug>.svg` and `<slug>.png`, as regular files (no
links).

## Deployment

The deployment pipeline calls `deploy/icons-migrate.sh <old tree> <icons folder>`. It works
**without network access**. Before the new tree is synced, every icon of the current tree that is
missing from the icons folder is copied there. Nothing is ever overwritten, so a partial folder
gets completed. The folder is then handed back to the owner of the state directory. The
deployment log shows a line `icons: N copied, M already present`.

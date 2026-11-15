// User-Agent of every outgoing request of the server: "vigie/<version>", version from
// server/package.json. HTTP probes, network module service probe, upstream version sources,
// Proxmox, Gitea, Pi-hole, weather, widgets, Telegram, heartbeat, init wizard tests,
// and every plugin call (lib/http.js, ctx.http).
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const VERSION = pkg.version
export const USER_AGENT = `vigie/${VERSION}`

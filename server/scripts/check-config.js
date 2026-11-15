// Validates the config given as argument (otherwise CONFIG_PATH, otherwise <root>/config.json,
// like the server) without starting the server.
// Run in CI before deployment: exit code 1 if the config is invalid; warnings are shown with
// "⚠" without blocking (exit 0).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { validatePluginConfig } from '../lib/plugins/host.js'
import { PLUGINS } from '../plugins/index.js'
import { registerExtensions } from '../lib/plugins/extensions.js'
import { RESERVED_PLUGIN_IDS } from '../lib/plugins/core.js'
import { inspectCa, SERVER_DIR } from '../lib/tls.js'
import { pkiDir } from '../lib/paths.js'
import { setLocale } from '../lib/i18n.js'

// operations tool, in English only (a message coming from the catalog too)
setLocale('en')
const here = path.dirname(fileURLToPath(import.meta.url))
// plugin extensions registered before reading, as at startup; a refused extension does not block
// the deployment (warning), but a config that uses it is refused
const extensions = registerExtensions(PLUGINS, { reservedIds: RESERVED_PLUGIN_IDS })
const file = path.resolve(process.argv[2] || process.env.CONFIG_PATH || path.join(here, '..', '..', 'config.json'))
const loaded = loadConfig(file)
const { config } = loaded
const warnings = [...(loaded.warnings ?? []), ...[...extensions.errors].map(([id, msg]) => `plugin ${id}: extensions refused: ${msg}`)]
const errors = loaded.errors ? [...loaded.errors] : []
// plugins.<id> blocks validated by each plugin's schema, as at startup
if (config) errors.push(...validatePluginConfig(config, PLUGINS))
// every pinned CA (proxmox[].ca, "pki/<name>.pem") is read and analyzed; missing, unreadable,
// not a CA or expired → error, deployment blocked. Looked up in the same CA directory as the
// server (PKI_DIR, otherwise server/pki of this repository; lib/paths.js)
if (config) {
  const dir = pkiDir(process.env, SERVER_DIR)
  // reference date injectable for tests (90 d warning); otherwise now
  const now = process.env.CHECK_CONFIG_NOW ? Number(process.env.CHECK_CONFIG_NOW) : Date.now()
  for (const p of config.proxmox) {
    if (!p.ca) continue
    const ca = inspectCa(p.ca, { dir, now })
    if (ca.error) errors.push(`proxmox ${p.id}: ${ca.error}`)
    else if (ca.daysLeft < 90) warnings.push(`proxmox ${p.id}: CA ${p.ca} expires in ${ca.daysLeft} d`)
  }
}
for (const w of warnings) console.warn(`⚠ ${w}`)

if (errors.length) {
  console.error(`✗ ${file} invalid:`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
const checks = config.services.reduce((n, s) => n + (s.checks ?? (s.url ? [1] : [])).length, 0)
console.log(`✓ ${file}: ${config.hosts.length} hosts, ${config.services.length} services, ${checks} probes, ${config.bookmarks.reduce((n, g) => n + g.items.length, 0)} bookmarks`)

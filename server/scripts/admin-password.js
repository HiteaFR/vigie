// Admin password: masked input, typed twice, then hashed with scrypt. The password itself is never
// written or printed. Input and rules are shared with the init assistant (lib/cli.js).
//
//   node scripts/admin-password.js                              # prints ADMIN_PASSWORD_HASH=…
//   node scripts/admin-password.js --write /etc/vigie/vigie.env # replaces that line in the file
//
// Then restart the service, for example systemctl restart vigie (open sessions stay valid).
import fs from 'node:fs'
import { createPrompter, askAdminPassword, Aborted } from '../lib/cli.js'

if (!process.stdin.isTTY) {
  console.error('interactive terminal required (ssh -t)')
  process.exit(1)
}
const i = process.argv.indexOf('--write')
const target = i > 0 ? process.argv[i + 1] : null

const p = createPrompter()
let hash
try {
  ;({ hash } = await askAdminPassword(p, { attempts: 1 }))
} catch (e) {
  console.error(e instanceof Aborted ? 'interrupted' : e.message)
  process.exit(e instanceof Aborted ? 130 : 1)
} finally {
  p.close()
}
const line = `ADMIN_PASSWORD_HASH=${hash}`

if (!target) {
  console.log(line)
} else {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
  const next = /^ADMIN_PASSWORD_HASH=.*$/m.test(cur)
    ? cur.replace(/^ADMIN_PASSWORD_HASH=.*$/m, () => line) // a function: no $ replacement pattern is interpreted
    : `${cur.replace(/\n?$/, '\n')}${line}\n`
  fs.writeFileSync(target, next, { mode: 0o600 })
  console.log(`${target} updated. Restart the service (systemctl restart <unit>)`)
}

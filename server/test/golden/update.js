// DELIBERATE update of the golden references (test/golden/*.json|txt). Never run by
// npm test. From server/: npm run golden:update; then reread git diff test/golden/ and justify
// each difference in the commit.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../tmpdir.js'
import { GOLDEN_DIR, outputs, englishOutputs } from './world.js'
import { routeTable, routesText } from './routes.js'
import { clientOutputs, CLIENT_INSTALLED } from './client.js'
import { clientViewsOutputs } from './client-views.js'

const out = await outputs({ storeDir: tmpDir('vigie-golden-maj-') })
Object.assign(out, await englishOutputs({ storeDir: tmpDir('vigie-golden-maj-en-') }))
out['routes.txt'] = routesText(await routeTable(tmpDir('vigie-golden-maj-routes-')))
if (CLIENT_INSTALLED) {
  out['client.txt'] = await clientOutputs()
  out['client-views.txt'] = await clientViewsOutputs('fr')
  out['client-views.en.txt'] = await clientViewsOutputs('en')
} else console.log('client not installed: client.txt and client-views*.txt not updated (npm ci in client/)')
for (const [name, text] of Object.entries(out)) {
  const file = path.join(GOLDEN_DIR, name)
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (before === text) continue
  fs.writeFileSync(file, text)
  console.log(`${before == null ? 'created' : 'updated'}: test/golden/${name}`)
}
console.log('references up to date; review: git diff test/golden/')

// TEST certificates and keys generated at startup (fixtures/tls/gen.sh, openssl) in a
// temporary folder of the process (tmpdir.js, deleted on exit): no private key in the
// repository. One generation per test process. openssl missing: explicit error, never a skip.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const GEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/tls/gen.sh')
let dir = null

// → folder: leaf-a.{key,pem}, leaf-a-nosan.{key,pem}, leaf-b.{key,pem}, pki/ca-{a,b,expired}.pem
export function tlsFixtures() {
  if (dir) return dir
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
  } catch {
    throw new Error('openssl introuvable : les tests TLS génèrent leurs certificats au lancement (installer openssl)')
  }
  const out = tmpDir('dash-tls-fixtures-')
  try {
    execFileSync('sh', [GEN, out], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    throw new Error(`génération des certificats de test en échec (fixtures/tls/gen.sh) : ${String(e.stderr || e.message).trim().slice(0, 300)}`)
  }
  dir = out
  return dir
}

// TEST CA folder (CA A of tlsFixtures under the given names), for the test configs that
// declare "pki/pve-prod.pem": the production CAs are no longer in the repository
let caDir = null
export function testPkiDir(names = ['pve-prod.pem']) {
  if (!caDir) caDir = tmpDir('dash-test-pki-')
  const src = path.join(tlsFixtures(), 'pki/ca-a.pem')
  for (const n of names) if (!fs.existsSync(path.join(caDir, n))) fs.copyFileSync(src, path.join(caDir, n))
  return caDir
}

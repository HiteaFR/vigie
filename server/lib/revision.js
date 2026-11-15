// Revision of the deployed code, to check after a deployment that production runs the
// intended version (/api/healthz: package.json version and commit). The commit is read from the
// REVISION file at the root of the code, written by the deployment pipeline into the source tree
// BEFORE synchronization (git rev-parse --short HEAD); never committed (.gitignore). Validated
// content: a hexadecimal sha of 7 to 40 characters, otherwise null (missing, empty, other content).
import fs from 'node:fs'

export const REVISION_RE = /^[0-9a-f]{7,40}$/
const MAX_BYTES = 128

export function readRevision(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    const v = fs.readFileSync(file, 'utf8').trim()
    return REVISION_RE.test(v) ? v : null
  } catch {
    return null
  }
}

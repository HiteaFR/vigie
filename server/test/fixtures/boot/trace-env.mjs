// Preloaded in the test server (--import). Traces each access to an environment file
// (name ".env" or the path given by TRACE_ENV_MATCH) WITHOUT ever reading the real .env of the
// repository: for it, existsSync answers false and readFileSync throws.
import fs from 'node:fs'
import path from 'node:path'

const extra = process.env.TRACE_ENV_MATCH || null
const repoEnv = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '.env')
const watched = p => typeof p === 'string' && (path.basename(p) === '.env' || (extra && path.resolve(p) === extra))
const { existsSync, readFileSync } = fs
fs.existsSync = function (p, ...a) {
  if (watched(p)) {
    process.stderr.write(`TRACE-ENV exists ${path.resolve(p)}\n`)
    if (path.resolve(p) === repoEnv) return false
  }
  return existsSync.call(this, p, ...a)
}
fs.readFileSync = function (p, ...a) {
  if (watched(p)) {
    process.stderr.write(`TRACE-ENV read ${path.resolve(p)}\n`)
    if (path.resolve(p) === repoEnv) throw Object.assign(new Error('lecture du .env du dépôt refusée par le test'), { code: 'EACCES' })
  }
  return readFileSync.call(this, p, ...a)
}

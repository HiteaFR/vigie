#!/usr/bin/env node
// Cleanup of old chunks at deployment. The files of client/dist/assets/ of the PREVIOUS build
// stay served for one cycle (a tab open on that build still loads its chunks); those of the
// build before it and older ones are deleted. Node without dependencies. Run by the deployment
// AFTER the healthcheck:
//   node deploy/prune-assets.mjs --dist <served client/dist> --manifest <build manifest | ->
//
// State, in <dist>/.vite/ (never transferred nor erased by deploy/sync.sh):
//   manifest.json          Vite manifest of the served build (build.manifest: true)
//   manifest.previous.json manifest of the previous build; on the first deployment, an entry
//                          "_avant-le-manifeste" (LEGACY) lists the files already present
// Rules: the files of a manifest are "assets/<name>", without subdirectory; kept =
// files(current) ∪ files(previous); redeploying the same build shifts nothing (idempotent);
// first deployment without state: nothing is deleted; only REGULAR files directly in assets/
// are deleted, never a symbolic link (not followed), a directory or anything outside assets/.
// Safeguards: unreadable manifest, path outside assets/, file of the current build missing or not
// regular → error, NO deletion, state unchanged.
//
// Accepted edge case: if deployment N+1 fails AFTER the synchronization (restart or
// healthcheck), the cleanup does not run; the state keeps N as current while the index.html on
// disk is N+1's. At deployment N+2, N+1 is not in the state: its chunks are deleted. Rare, and
// the failed job of N+1 makes it visible.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATE = '.vite/manifest.json'
export const PREVIOUS = '.vite/manifest.previous.json'
export const LEGACY = '_avant-le-manifeste'
const ASSET = /^assets\/[^/\\]+$/

// files of a Vite manifest: file, css[], assets[] of each entry
export function filesOf(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !Object.keys(manifest).length) throw new Error('manifest empty or invalid')
  const out = new Set()
  for (const [key, e] of Object.entries(manifest)) {
    if (!e || typeof e !== 'object') throw new Error(`manifest: invalid entry "${key}"`)
    for (const f of [e.file, ...(e.css ?? []), ...(e.assets ?? [])]) {
      if (f == null) continue
      if (typeof f !== 'string' || !ASSET.test(f) || f.includes('..') || f === 'assets/.' ) throw new Error(`manifest: path refused "${f}" (assets/<name> expected)`)
      out.add(f)
    }
  }
  return out
}

const readJson = (file, what) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${what} unreadable (${file}): ${e.message}`)
  }
}
const sameFiles = (a, b) => a.size === b.size && [...a].every(f => b.has(f))
// atomic write (temporary file, then rename)
function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// → { first, shifted, kept: [..], deleted: [..], skipped: [..] }; log(line); throws without deleting anything
export function prune({ dist, manifestText, log = () => {} }) {
  const assets = path.join(dist, 'assets')
  const st = fs.lstatSync(assets, { throwIfNoEntry: false })
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new Error(`${assets}: directory missing (or symbolic link)`)
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (e) {
    throw new Error(`build manifest unreadable: ${e.message}`)
  }
  const current = filesOf(manifest)
  for (const f of current) {
    const s = fs.lstatSync(path.join(dist, f), { throwIfNoEntry: false })
    if (!s || !s.isFile()) throw new Error(`file of the current build missing or not regular: ${f} (nothing is deleted)`)
  }
  fs.mkdirSync(path.join(dist, '.vite'), { recursive: true })
  const statePath = path.join(dist, STATE)
  const prevPath = path.join(dist, PREVIOUS)
  const names = fs.readdirSync(assets, { withFileTypes: true })
  let previous = null
  let first = false
  let shifted = false
  if (!fs.existsSync(statePath)) {
    // first deployment: the files already there become the "previous" build, nothing is deleted
    first = true
    const legacy = names.filter(d => d.isFile() && !current.has(`assets/${d.name}`)).map(d => `assets/${d.name}`).sort()
    previous = legacy.length ? { [LEGACY]: { assets: legacy } } : null
  } else {
    const was = readJson(statePath, 'state (served manifest)')
    const wasFiles = filesOf(was)
    if (sameFiles(wasFiles, current)) {
      previous = fs.existsSync(prevPath) ? readJson(prevPath, 'state (previous manifest)') : null
    } else {
      previous = was
      shifted = true
    }
  }
  const prevFiles = previous ? filesOf(previous) : new Set()
  const keep = new Set([...current, ...prevFiles])
  // state written BEFORE the cleanup: a restart after an interruption computes the same kept set
  if (previous) writeJson(prevPath, previous)
  else fs.rmSync(prevPath, { force: true })
  writeJson(statePath, manifest)
  // on the first deployment, every regular file present is in keep (current or "before the
  // manifest"): nothing is deleted
  const deleted = []
  const skipped = []
  for (const d of names) {
    const rel = `assets/${d.name}`
    if (keep.has(rel)) continue
    if (!d.isFile()) {
      skipped.push(rel) // directory, symbolic link (never followed), other: ignored
      continue
    }
    fs.unlinkSync(path.join(assets, d.name))
    deleted.push(rel)
  }
  const kept = names.map(d => `assets/${d.name}`).filter(f => keep.has(f)).sort()
  log(`assets: ${kept.length} kept (current build ${current.size}, previous ${prevFiles.size}${first ? ', first deployment: nothing deleted' : ''}${shifted ? '' : !first ? ', same build: state unchanged' : ''}), ${deleted.length} deleted`)
  for (const f of deleted.sort()) log(`  deleted: ${f}`)
  for (const f of skipped.sort()) log(`  skipped (not regular): ${f}`)
  return { first, shifted, kept, deleted: deleted.sort(), skipped: skipped.sort() }
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') out.dist = argv[++i]
    else if (argv[i] === '--manifest') out.manifest = argv[++i]
    else throw new Error(`unknown option: ${argv[i]}`)
  }
  if (!out.dist || !out.manifest) throw new Error('usage: prune-assets.mjs --dist <client/dist> --manifest <file | ->')
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2))
    const manifestText = a.manifest === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a.manifest, 'utf8')
    prune({ dist: path.resolve(a.dist), manifestText, log: l => console.log(l) })
  } catch (e) {
    console.error(`✗ assets cleanup: ${e.message}`)
    process.exit(1)
  }
}

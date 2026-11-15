// Reduced OUI database: downloads the IEEE MA-L registry (oui.csv) and writes
// lib/network/oui.tsv, one "aabbcc<TAB>name" line per prefix. Run by hand, outside CI; the
// produced file is reviewed at commit time.
//
// The downloaded content is UNTRUSTED data: it is only parsed (never executed nor evaluated),
// capped at 10 MB, and every line is validated; an invalid line is dropped and counted. Atomic
// write (temporary file, then rename).
//
//   node scripts/update-oui.js
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OUI_FILE } from '../lib/network/oui.js'

const URL_IEEE = 'https://standards-oui.ieee.org/oui/oui.csv'
const MAX_BYTES = 10 * 1024 * 1024
const MAX_LINE = 1000 // characters; a postal address fits easily
const MAX_ENTRIES = 60_000
const MAX_NAME = 40

// CSV fields of a line (doubled quotes ""); null if the quotes are unbalanced
function csvFields(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"' && cur === '') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (quoted) return null
  out.push(cur)
  return out
}

// registry text → { entries: Map(aabbcc → name), lines, rejected }; pure
// kept line: MA-L registry, prefix of exactly 6 hex digits, name without control characters
// (except tab, cleaned like a space: the registry has some at the end of names) nor angle
// brackets, non-empty, spaces collapsed, 40 characters at most; a line break inside a name cuts
// the line and unbalances its quotes: dropped
export function parseOuiCsv(text) {
  const entries = new Map()
  let lines = 0
  let rejected = 0
  for (const raw of String(text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line) continue
    lines++
    if (lines === 1 && /^Registry,/.test(line)) continue // header
    const f = line.length <= MAX_LINE ? csvFields(line) : null
    const name = f?.[2]
    if (!f || f.length < 3 || f[0] !== 'MA-L' || !/^[0-9A-Fa-f]{6}$/.test(f[1])
      || /[\u0000-\u0008\u000a-\u001f\u007f-\u009f<>]/.test(name)) {
      rejected++
      continue
    }
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim()
    if (!clean || entries.size >= MAX_ENTRIES) {
      rejected++
      continue
    }
    const prefix = f[1].toLowerCase()
    if (!entries.has(prefix)) entries.set(prefix, clean)
  }
  return { entries, lines, rejected }
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error(`registry over ${MAX_BYTES / 1024 / 1024} MB: refused`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const text = await download(URL_IEEE)
  const { entries, lines, rejected } = parseOuiCsv(text)
  if (entries.size < 10_000) throw new Error(`only ${entries.size} prefixes: suspicious registry, nothing is written`)
  const out = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, n]) => `${p}\t${n}\n`).join('')
  fs.writeFileSync(`${OUI_FILE}.tmp`, out)
  fs.renameSync(`${OUI_FILE}.tmp`, OUI_FILE)
  console.log(`✓ ${OUI_FILE}: ${entries.size} prefixes, ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB (${lines} lines read, ${rejected} dropped)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`✗ OUI update: ${e.message}`)
    process.exit(1)
  })
}

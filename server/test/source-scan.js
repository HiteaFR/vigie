// Reads the texts of a source file for the i18n guards (not a test): '…' and "…" strings,
// fixed parts of `…` templates (even multi-line), including those of the templates and
// strings placed inside a ${…}; comments and regex literals skipped. And the list of the
// server files: git ls-files, otherwise (copy without .git) a directory walk.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// after these tokens, "/" opens a regex literal; elsewhere it is a division
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'])

// → [{ line, at, text, kind }]; line: line (1…) where the text starts; at: position of its first
// character in the source; kind: 'str' or 'tpl'
export function literals(src) {
  const out = []
  const n = src.length
  let i = 0
  let line = 1
  let prev = ''
  let depth = 0
  const holes = [] // brace depth at the opening of each ${…} in progress
  // fixed part of a template, from i to ` (end) or ${ (hole); i is right after ` or }
  const templatePart = () => {
    const start = line
    const at = i
    let text = ''
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        if (src[i + 1] === '\n') line++
        text += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        i++
        out.push({ line: start, at, text, kind: 'tpl' })
        prev = 'str'
        return
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        out.push({ line: start, at, text, kind: 'tpl' })
        holes.push(depth)
        depth++
        prev = '{'
        return
      }
      if (c === '\n') line++
      text += c
      i++
    }
    out.push({ line: start, at, text, kind: 'tpl' })
  }
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      let k = i + 1
      let text = ''
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') { text += src.slice(k, k + 2); k += 2; continue }
        text += src[k++]
      }
      out.push({ line, at: i + 1, text, kind: 'str' })
      i = k + 1
      prev = 'str'
      continue
    }
    if (c === '`') { i++; templatePart(); continue }
    if (c === '{') { depth++; i++; prev = '{'; continue }
    if (c === '}') {
      depth--
      i++
      if (holes.length && holes.at(-1) === depth) { holes.pop(); templatePart() } else prev = '}'
      continue
    }
    if (c === '/' && REGEX_AFTER.has(prev)) {
      let k = i + 1
      let cls = false
      while (k < n && src[k] !== '\n') {
        const x = src[k]
        if (x === '\\') { k += 2; continue }
        if (x === '[') cls = true
        else if (x === ']') cls = false
        else if (x === '/' && !cls) break
        k++
      }
      i = k + 1
      while (i < n && /[a-z]/.test(src[i])) i++
      prev = 're'
      continue
    }
    if (/[\w$]/.test(c)) {
      let k = i
      while (k < n && /[\w$]/.test(src[k])) k++
      prev = src.slice(i, k)
      i = k
      continue
    }
    prev = c
    i++
  }
  return out
}

// .js and .mjs files of the server (paths relative to server/) under these roots; git ls-files,
// otherwise a directory walk (copy without .git, like the "server formats" test); walk: true
// forces the walk, git: git command (a missing path simulates a tool not found)
export function serverFiles(server, roots, { walk = false, git = 'git' } = {}) {
  const keep = f => /\.m?js$/.test(f)
  if (!walk) {
    try {
      return execFileSync(git, ['ls-files', ...roots], { cwd: server, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(keep)
    } catch {
      // no git repository: walk
    }
  }
  const out = []
  const visit = rel => {
    const st = fs.lstatSync(path.join(server, rel), { throwIfNoEntry: false })
    if (!st) return
    if (st.isFile()) { if (keep(rel)) out.push(rel); return }
    if (!st.isDirectory()) return
    for (const e of fs.readdirSync(path.join(server, rel))) if (!['node_modules', '.git', 'dist'].includes(e)) visit(`${rel}/${e}`)
  }
  for (const r of roots) visit(r)
  return out.sort()
}

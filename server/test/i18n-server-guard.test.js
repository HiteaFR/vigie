// No hardcoded French text left in the server code (lib, plugins, index.js, scripts), comments
// excluded: a text read by a person goes through a catalog (server or plugin), an operations
// text (log, config, check-config, init) is in English. Named exceptions: persisted or
// read-back CODES (former values, never retranslated) and the network migration already run in
// production. Development tools (alerts-preview, presence-analyse) are in English.
// Texts are read by source-scan.js (strings, multi-line templates, templates and strings
// inside a ${…}), French without accents is spotted through marker words, and the file list
// does not depend on git (copy without .git: directory walk).
// KNOWN LIMIT: a French text with neither accent nor marker word ("mot de passe incorrect") is not
// detected; the marker word list grows when such a text is found.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { literals, serverFiles } from './source-scan.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['lib', 'plugins', 'index.js', 'scripts']
const FRENCH = /[àâäéèêëîïôöùûüçœ«»]/i
// French without accents: marker words frequent in messages (none is a common English
// word; "route" is, its code uses are named below)
const WITNESS = new RegExp(`\\b(${[
  'inconnue?s?', 'introuvables?', 'absente?s?', 'echecs?', 'delais?', 'passerelles?', 'fichiers?', 'route', 'aucune?s?',
  'attendue?s?', 'manquante?s?', 'invalides?', 'erreurs?', 'injoignables?', 'requise?s?', 'sans', 'connexion', 'liste',
  'vide', 'trop', 'illisibles?', 'AAAA', 'heures?', 'appareils?', 'lien', 'deja', 'apres', 'avec', 'dans', 'pour', 'mais',
  'une', 'des', 'les', 'est', 'pas',
].join('|')})\\b`, 'i')
// whole files of persisted codes
const CODE_FILES = new Set(['lib/codes.js'])
// constants of persisted or read-back codes: only their value is skipped (from "=" to the end of
// the statement: semicolon or end of line outside parentheses), never the rest of the line
const CODE_CONST = /(?:^|\n)[ \t]*(?:export )?const (?:DROPPED|KNOWN_BY_BOOTSTRAP|SCRYPT_PROBE) = /g
// code values containing a marker word, per file (exact text of the literal)
const CODE_VALUES = {
  // language name in the init wizard, written in that language (endonym)
  'lib/setup.js': ['français (fr)'],
  // "route" source (gateway read from /proc/net/route), kernel module and file
  'lib/network/index.js': ['./sources/route.js', '/proc/net/route', 'route'],
}
// SQL schema: its comments (-- …) are not displayed texts
const SQL_COMMENTS = new Set(['lib/db.js'])

// [start, end[ of the values of code constants (positions in the source)
function codeConstSpans(src, lits) {
  const spans = []
  for (const m of src.matchAll(CODE_CONST)) {
    const start = m.index + m[0].length
    let depth = 0
    let i = start
    let next = 0
    while (i < src.length) {
      // a literal is skipped in one block (its parentheses and its ";" do not count)
      while (next < lits.length && lits[next].at < i) next++
      if (next < lits.length && lits[next].at === i + 1 && /['"`]/.test(src[i])) { i = lits[next].at + lits[next].text.length + 1; continue }
      const c = src[i]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
      else if (depth <= 0 && (c === ';' || c === '\n')) break
      i++
    }
    spans.push([start, i])
  }
  return spans
}

export function frenchLiterals(src, file = '') {
  const lines = src.split('\n')
  const allowed = CODE_VALUES[file] ?? []
  const out = new Set()
  const lits = literals(src)
  const spans = codeConstSpans(src, lits)
  for (const l of lits) {
    if (spans.some(([a, b]) => l.at >= a && l.at < b) || allowed.includes(l.text)) continue
    const text = SQL_COMMENTS.has(file) ? l.text.replace(/--[^\n]*/g, '') : l.text
    if (FRENCH.test(text) || WITNESS.test(text)) out.add(`${l.line}: ${lines[l.line - 1].trim().slice(0, 120)}`)
  }
  return [...out]
}

const scanned = files => files.filter(f => !CODE_FILES.has(f))
const findings = files => scanned(files).flatMap(f => frenchLiterals(fs.readFileSync(path.join(SERVER, f), 'utf8'), f).map(l => `${f}:${l}`))

test('guard: no hardcoded French text in the server, comments and named persisted codes excluded', () => {
  const files = serverFiles(SERVER, ROOTS)
  assert.ok(files.length > 80, `${files.length} files`)
  assert.deepEqual(findings(files), [])
  // each named exception is still used (otherwise remove it)
  for (const [f, values] of Object.entries(CODE_VALUES)) {
    const texts = literals(fs.readFileSync(path.join(SERVER, f), 'utf8')).map(l => l.text)
    assert.deepEqual(values.filter(v => !texts.includes(v)), [], `${f}: unused exception`)
  }
})

test('guard: it sees an added French text, and ignores comments and named codes', () => {
  assert.deepEqual(frenchLiterals("// commentaire en français : déjà\nconst a = 'ok'\n/* passerelle inconnue */\n"), [])
  assert.deepEqual(frenchLiterals("export const DROPPED = Object.freeze({ EXPIRED: 'expiré' })\n"), [])
  // only the value of the constant is skipped, not the rest of the line nor what follows
  assert.deepEqual(frenchLiterals("export const DROPPED = Object.freeze({ A: 'expiré', B: 'x;y' }); throw new Error('échec')\n"), ["1: export const DROPPED = Object.freeze({ A: 'expiré', B: 'x;y' }); throw new Error('échec')"])
  assert.deepEqual(frenchLiterals("const KNOWN_BY_BOOTSTRAP = 'amorçage'\nconst m = 'délai'\n"), ["2: const m = 'délai'"])
  assert.deepEqual(frenchLiterals("export const DROPPED = Object.freeze({\n  EXPIRED: 'expiré',\n  REJECTED: 'rejeté',\n})\nconst e = 'rejeté'\n"), ["5: const e = 'rejeté'"])
  assert.deepEqual(frenchLiterals("throw new Error('délai dépassé')\n"), ["1: throw new Error('délai dépassé')"])
  assert.deepEqual(frenchLiterals('const m = `réseau : ${x}`\n'), ['1: const m = `réseau : ${x}`'])
  // French inside a ${…} (string or nested template)
  assert.deepEqual(frenchLiterals("const m = `ip neigh: ${err ? 'délai' : 'x'}`\n"), ["1: const m = `ip neigh: ${err ? 'délai' : 'x'}`"])
  assert.deepEqual(frenchLiterals('const m = `a ${b ? `${c} réseau` : d} e`\n'), ['1: const m = `a ${b ? `${c} réseau` : d} e`'])
  assert.deepEqual(frenchLiterals('const m = `a ${{ k: 1 }.k} ${f({ x: "échec" })}`\n'), ['1: const m = `a ${{ k: 1 }.k} ${f({ x: "échec" })}`'])
  // multi-line template: reported at its first line
  assert.deepEqual(frenchLiterals('const ok = 1\nconst m = `first line\n  réseau ${x}\n`\n'), ['2: const m = `first line'])
  // French without accents (marker words); English passes
  assert.deepEqual(frenchLiterals("throw new Error('passerelle inconnue')\nthrow new Error('unknown gateway')\n"), ["1: throw new Error('passerelle inconnue')"])
  assert.deepEqual(frenchLiterals("res.json({ error: 'route inconnue' })\nconst s = `fichier ${f} introuvable`\n"), ["1: res.json({ error: 'route inconnue' })", '2: const s = `fichier ${f} introuvable`'])
  assert.deepEqual(frenchLiterals("const e = 'commande absente'\nconst g = \"date : AAAA-MM-JJ\"\n"), ["1: const e = 'commande absente'", '2: const g = "date : AAAA-MM-JJ"'])
  // regex literals and divisions: an apostrophe in a regex does not shift the reading
  assert.deepEqual(frenchLiterals("const r = /'/g\nconst s = 'ok'\nconst d = a / b / c\nconst t = 'délai'\n"), ["4: const t = 'délai'"])
  assert.deepEqual(frenchLiterals("if (/[\"'`]/.test(x)) y = 'ok'\nz = `réseau`\n"), ['2: z = `réseau`'])
  // "//" in a string is not a comment
  assert.deepEqual(frenchLiterals("const u = 'http://x' + 'échec'\n"), ["1: const u = 'http://x' + 'échec'"])
  // named exceptions: only in their file, and only the exact value
  assert.deepEqual(frenchLiterals("const k = 'français (fr)'\n", 'lib/setup.js'), [])
  assert.deepEqual(frenchLiterals("const k = 'français (fr)'\n", 'lib/other.js'), ["1: const k = 'français (fr)'"])
  assert.deepEqual(frenchLiterals("const k = 'français (en)'\n", 'lib/setup.js'), ["1: const k = 'français (en)'"])
  assert.deepEqual(frenchLiterals('db.exec(`\nCREATE TABLE t (\n  a TEXT -- défaut ici\n);\n`)\n', 'lib/db.js'), [])
  assert.deepEqual(frenchLiterals('db.exec(`\nCREATE TABLE t (a TEXT DEFAULT \'défaut\');\n`)\n', 'lib/db.js'), ['1: db.exec(`'])
})

// safe() disables the escaping of a tHtml parameter; it must mark ONLY catalog texts (tr) or a
// nested tHtml, and only in the bot (the only intended caller).
// A call with a space ("safe (x)"), a renamed import ("safe as ok"), an import of the whole
// module ("* as f", then f.safe) and a re-export are detected.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
const FORMAT = `\\s*from\\s*['"][^'"]*format\\.js['"]`
// names under which safe from lib/notify/format.js can be called in this source
export function safeNames(src) {
  const code = stripComments(src)
  const names = []
  for (const m of code.matchAll(new RegExp(`import\\s+(?:[\\w$]+\\s*,\\s*)?\\{([^}]*)\\}${FORMAT}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/)
      if (name === 'safe') names.push(alias ?? name)
    }
  }
  for (const m of code.matchAll(new RegExp(`import\\s+(?:[\\w$]+\\s*,\\s*)?\\*\\s*as\\s+([\\w$]+)${FORMAT}`, 'g'))) names.push(`${m[1]}.safe`)
  return names
}
// re-export of safe (named or via "export *"): another module would get it without importing it from here
export const reexportsSafe = src => new RegExp(`export\\s*(\\*|\\{[^}]*\\bsafe\\b[^}]*\\})${FORMAT}`).test(stripComments(src))
// end of the call whose opening parenthesis is at code[open]: position of the closing parenthesis
// (strings and templates skipped), or -1
function closing(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}
// WHOLE argument of each call of one of these names (no longer just its start)
export function safeCalls(src, names = ['safe']) {
  const code = stripComments(src)
  return names.flatMap(n => [...code.matchAll(new RegExp(`(?<![\\w$.])${n.replace(/[.$]/g, '\\$&')}\\s*\\(`, 'g'))].map(m => {
    const open = m.index + m[0].length - 1
    const end = closing(code, open)
    return (end < 0 ? code.slice(open + 1) : code.slice(open + 1, end)).trim()
  }))
}
// is the argument A SINGLE tr(…) or tHtml(…) call, nothing before or after (not "tr('k') + x")?
export function singleCatalogCall(arg) {
  const m = /^(tr|tHtml)\s*\(/.exec(arg)
  return !!m && closing(arg, m[0].length - 1) === arg.length - 1
}
test('guard: safe( only in lib/notify/bot.js, and only on tr(…) or tHtml(…)', () => {
  const files = serverFiles(SERVER, ROOTS)
  // safe from lib/notify/format.js imported (under any name) or re-exported anywhere other than in
  // the bot (a local function with the same name, like the one of the services probe, is not targeted)
  const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8')
  const outside = files.filter(f => f !== 'lib/notify/bot.js' && f !== 'lib/notify/format.js' && (safeNames(read(f)).length || reexportsSafe(read(f))))
  assert.deepEqual(outside, [], 'safe imported outside the bot')
  const names = safeNames(read('lib/notify/bot.js'))
  assert.ok(names.length >= 1)
  const bot = safeCalls(read('lib/notify/bot.js'), names)
  assert.ok(bot.length >= 6, `${bot.length} calls`)
  assert.deepEqual(bot.filter(a => !singleCatalogCall(a)), [], 'safe( on something other than a single tr( or tHtml( call')
  // format.js: only the definition
  assert.deepEqual(safeCalls(read('lib/notify/format.js')), [])
  // the guard sees a forbidden call, with or without a space
  assert.deepEqual(safeCalls('x = safe(reason) + safe(tr(\'k\')) + safe (other) + safe\n(more)'), ['reason', "tr('k')", 'other', 'more'])
  // the whole argument is ONE tr(…) or tHtml(…) call; parentheses inside a string included
  assert.deepEqual(safeCalls("safe(tr('k') + s.reason)").map(singleCatalogCall), [false])
  assert.deepEqual(safeCalls("safe(tr('k', { x: f(a) }))").map(singleCatalogCall), [true])
  assert.deepEqual(safeCalls("safe(tHtml('bot.until', { time: when(s.endsAt) }))").map(singleCatalogCall), [true])
  assert.deepEqual(safeCalls("safe(tr(`bot.net.${p.net}.prompt`).split(' ')[0])").map(singleCatalogCall), [false])
  assert.deepEqual(safeCalls("safe(tr('a)b'))").map(singleCatalogCall), [true])
  assert.deepEqual(safeCalls("safe(s.reason || tr('k'))").map(singleCatalogCall), [false])
  assert.deepEqual(safeCalls('const safeHandle = 1; unsafe(x); a.safe(y)'), [])
  // imports: direct, renamed, with a default, whole module; a local function is not targeted
  assert.deepEqual(safeNames("import { t, safe } from '../notify/format.js'"), ['safe'])
  assert.deepEqual(safeNames("import { t, safe as ok, tHtml } from './format.js'"), ['ok'])
  assert.deepEqual(safeNames("import fmt, {\n  safe as s,\n} from './format.js'"), ['s'])
  assert.deepEqual(safeNames("import * as f from './format.js'"), ['f.safe'])
  assert.deepEqual(safeNames('const safe = async (d, o) => {}'), [])
  assert.deepEqual(safeNames("import { safe } from './other.js'"), [])
  assert.deepEqual(safeCalls('ok (reason); f.safe(tr(\'k\'))', ['ok', 'f.safe']), ['reason', "tr('k')"])
  assert.ok(reexportsSafe("export { safe } from './format.js'") && reexportsSafe("export * from '../notify/format.js'") && !reexportsSafe("export { tHtml } from './format.js'"))
})

test('guard: without .git, the file list comes from the directory walk, and both guards pass on it', () => {
  // git not found (copy without a repository, or missing tool): same fallback as without .git
  const walked = serverFiles(SERVER, ROOTS, { git: path.join(SERVER, 'no-such-git') })
  const tracked = serverFiles(SERVER, ROOTS)
  assert.deepEqual(serverFiles(SERVER, ROOTS, { walk: true }), walked)
  assert.ok(walked.length > 80, `${walked.length} files`)
  // the walk sees at least all tracked files (it may also see an untracked file)
  assert.deepEqual(tracked.filter(f => !walked.includes(f)), [])
  assert.ok(walked.includes('index.js') && walked.includes('lib/notify/bot.js') && walked.some(f => f.startsWith('plugins/')) && walked.some(f => f.startsWith('scripts/')))
  assert.ok(!walked.some(f => f.includes('node_modules/')))
  assert.deepEqual(findings(walked), [])
  assert.deepEqual(walked.filter(f => f !== 'lib/notify/bot.js' && f !== 'lib/notify/format.js' && safeNames(fs.readFileSync(path.join(SERVER, f), 'utf8')).length), [])
})

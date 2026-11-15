// No hardcoded text left in the client (client/src), comments excluded: a text read by a
// person goes through the catalog (client/src/i18n/<locale>.json, or a plugin's:
// plugins/<id>/locales, under "<id>.<key>"). Checked on the syntax tree (the client's Babel
// parser): no accented literal; no hardcoded JSX text or visible attribute (title, aria-label,
// placeholder…), named technical terms excluded; each called key exists in fr and en;
// no t() when a module loads (the locale is known only after /api/config).
// Named exceptions: the { en, fr } labels of plugin meta.js files (intended form); FATAL_TEXT
// of boot.js, the bilingual last-resort message shown when no catalog could load. The example
// plugin goes through its catalog like the others (model of docs/plugins.md, "Client translations").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = path.join(ROOT, 'client')
let parse = null
try { parse = createRequire(path.join(CLIENT, 'package.json'))('@babel/parser').parse } catch { /* client not installed */ }

const FRENCH = /[àâäéèêëîïôöùûüçœ«»]/i
const VISIBLE = new Set(['title', 'aria-label', 'placeholder', 'label', 'hint', 'submitLabel', 'alt', 'prefix', 'success', 'sub'])
// technical terms, commands and paths shown as is in every language
const TECH = new Set(['MAC', 'IP', 'PR', 'CI #', 'SVG', 'Mermaid', 'tcp/', 'Ctrl K', 'admin', 'dev', 'failed', 'reboot', 'uptime', 'widget', '/mute',
  'CPU 24 h', 'RAM 24 h', 'cd server && npm run init', 'config.example.json', 'config.json', 'node server/scripts/admin-password.js'])
const META = /^plugins\/[^/]+\/meta\.js$/
// intended hardcoded constants, per file
const NAMED = { 'boot.js': new Set(['FATAL_TEXT']) }
const T_NAMES = new Set(['t', 'tr'])
// local functions that pass a key received as an argument to t(): key checked at their calls (index
// of the argument); t(variable) is allowed only in these files
// (i18n/index.js: tLabels, whose calls are checked below)
const WRAPPERS = { 'lib/kpi.js': { n: 1 }, 'i18n/index.js': {} }
const I18N_MODULE = /(^|\/)i18n\/index\.js$/
// technical words or proper nouns shown as is (units, acronyms, product name)
const TECH_WORDS = new Set(['CPU', 'vCPU', 'RAM', 'Swap', 'SMART', 'EOL', 'PVE', 'dev', 'Vigie', 'run'])
const TEXT = s => !TECH.has(s.trim()) && (s.match(/[a-zà-ÿ]{3,}/gi) ?? []).some(w => !TECH_WORDS.has(w))
// texts an expression displays as is: string, template, branches of a ternary, displayed side
// of a && or of a ||/?? ("{'…'}" and hardcoded ternaries)
function shown(e) {
  if (!e) return []
  if (e.type === 'StringLiteral') return [e.value]
  if (e.type === 'TemplateLiteral') return e.quasis.map(q => q.value.cooked ?? '')
  if (e.type === 'ConditionalExpression') return [...shown(e.consequent), ...shown(e.alternate)]
  if (e.type === 'LogicalExpression') return e.operator === '&&' ? shown(e.right) : [...shown(e.left), ...shown(e.right)]
  return []
}
// keys of a t() argument: literal, template prefix, branches of a ternary; otherwise dynamic
function keysOf(a, line) {
  if (a?.type === 'StringLiteral') return [{ key: a.value, line }]
  if (a?.type === 'TemplateLiteral') return [{ prefix: a.quasis[0].value.cooked, line }]
  if (a?.type === 'ConditionalExpression') return [...keysOf(a.consequent, line), ...keysOf(a.alternate, line)]
  if (a?.type === 'BinaryExpression' && a.operator === '+' && a.left.type === 'StringLiteral') return [{ prefix: a.left.value, line }]
  return [{ dynamic: true, line }]
}

function walk(node, fn, parents = []) {
  if (!node || typeof node.type !== 'string') return
  fn(node, parents)
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue
    if (Array.isArray(v)) v.forEach(c => walk(c, fn, [...parents, node]))
    else if (v && typeof v.type === 'string') walk(v, fn, [...parents, node])
  }
}

// → { texts: ['line: text'], keys: [{ key, prefix, line }], moduleT: [line] }
export function scanClient(src, file = 'x.jsx') {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx', 'importAttributes'] })
  const texts = []
  const keys = []
  const moduleT = []
  const tNames = new Set(T_NAMES)
  const spaces = new Set()
  walk(ast.program, (n, parents) => {
    const line = n.loc.start.line
    const inImport = parents.some(p => p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration' && p.source)
    const metaFr = META.test(file) && parents.at(-1)?.type === 'ObjectProperty' && (parents.at(-1).key.name ?? parents.at(-1).key.value) === 'fr'
    const named = parents.at(-1)?.type === 'VariableDeclarator' && NAMED[file]?.has(parents.at(-1).id?.name)
    if (n.type === 'StringLiteral' && !inImport && !metaFr && !named && FRENCH.test(n.value)) texts.push(`${line}: '${n.value}'`)
    if (n.type === 'TemplateElement' && FRENCH.test(n.value.cooked ?? '')) texts.push(`${line}: \`${n.value.cooked}\``)
    if (n.type === 'JSXText' && /[a-zà-ÿ]{2,}/i.test(n.value) && !TECH.has(n.value.trim())) texts.push(`${line}: ${n.value.trim()}`)
    if (n.type === 'JSXAttribute' && VISIBLE.has(n.name.name) && n.value?.type === 'StringLiteral' && TEXT(n.value.value)) {
      texts.push(`${line}: ${n.name.name}="${n.value.value}"`)
    }
    // visible attribute or JSX child given by an expression: "title={'Fermer'}", "{ok ? 'Oui' : 'Non'}"
    const container = n.type === 'JSXExpressionContainer' && (parents.at(-1)?.type === 'JSXElement' || parents.at(-1)?.type === 'JSXFragment' || (parents.at(-1)?.type === 'JSXAttribute' && VISIBLE.has(parents.at(-1).name.name)))
    if (container) for (const s of shown(n.expression)) if (TEXT(s)) texts.push(`${line}: {${s.trim()}}`)
    // names of t in this file: t, tr, aliases imported from the i18n module, namespace (I.t)
    if (n.type === 'ImportDeclaration' && I18N_MODULE.test(n.source.value)) {
      for (const s of n.specifiers) {
        if (s.type === 'ImportSpecifier' && ['t', 'tr'].includes(s.imported.name ?? s.imported.value)) tNames.add(s.local.name)
        if (s.type === 'ImportNamespaceSpecifier') spaces.add(s.local.name)
      }
    }
    if (n.type !== 'CallExpression') return
    const callee = n.callee.type === 'Identifier' ? n.callee.name
      : n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && spaces.has(n.callee.object.name) && !n.callee.computed ? `*.${n.callee.property.name}` : null
    if (callee == null) return
    const a = n.arguments[0]
    if (tNames.has(callee) || callee === '*.t') {
      if (!parents.some(p => /Function|ObjectMethod|ClassMethod/.test(p.type))) moduleT.push(line)
      keys.push(...keysOf(a, line))
    }
    const wrap = WRAPPERS[file]?.[callee]
    if (wrap != null) keys.push(...keysOf(n.arguments[wrap], line).map(k => ({ ...k, wrapper: callee })))
    if ((callee === 'tLabels' || callee === '*.tLabels') && a?.type === 'StringLiteral' && n.arguments[1]?.type === 'ArrayExpression') {
      for (const e of n.arguments[1].elements) if (e?.type === 'StringLiteral') keys.push({ key: `${a.value}.${e.value}`, line })
    }
  })
  return { texts, keys, moduleT }
}

const files = () => fs.readdirSync(path.join(CLIENT, 'src'), { recursive: true }).map(f => f.split(path.sep).join('/')).filter(f => /\.(jsx?|mjs)$/.test(f)).sort()
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'))
// catalog per locale: the client's, plus the plugins' under "<id>."
function catalogs() {
  const out = {}
  for (const l of ['fr', 'en']) {
    out[l] = new Set(Object.keys(json(path.join(CLIENT, 'src/i18n', `${l}.json`))))
    for (const id of fs.readdirSync(path.join(CLIENT, 'src/plugins'))) {
      const p = path.join(CLIENT, 'src/plugins', id, 'locales', `${l}.json`)
      if (fs.existsSync(p)) for (const k of Object.keys(json(p))) out[l].add(`${id}.${k}`)
    }
  }
  return out
}

test('client guard: no hardcoded text in client/src (accents, JSX text, visible attributes), named technical terms excluded', t => {
  if (!parse) return t.skip('client not installed (npm ci in client/)')
  const list = files()
  assert.ok(list.length > 60, `${list.length} files`)
  const found = list.flatMap(f => scanClient(fs.readFileSync(path.join(CLIENT, 'src', f), 'utf8'), f).texts.map(x => `${f}:${x}`))
  assert.deepEqual(found, [])
})

test('client guard: each called key (t, tr, alias, I.t, tLabels, template prefix, ternary branches) exists in fr and en; no key without a checkable prefix; no t() when a module loads', t => {
  if (!parse) return t.skip('client not installed (npm ci in client/)')
  const cat = catalogs()
  const missing = []
  const atLoad = []
  const unverifiable = []
  let n = 0
  for (const f of files()) {
    const { keys, moduleT } = scanClient(fs.readFileSync(path.join(CLIENT, 'src', f), 'utf8'), f)
    atLoad.push(...moduleT.map(l => `${f}:${l}`))
    for (const k of keys) {
      // a fully dynamic key (t(variable), template without prefix) is allowed only
      // in a named relay function (WRAPPERS), whose calls are checked
      if (k.dynamic || (k.prefix != null && k.prefix.length < 2)) {
        if (!WRAPPERS[f]) unverifiable.push(`${f}:${k.line}`)
        continue
      }
      n++
      for (const l of ['fr', 'en']) {
        const ok = k.key != null ? cat[l].has(k.key) : [...cat[l]].some(x => x.startsWith(k.prefix))
        if (!ok) missing.push(`${f}:${k.line} ${k.key ?? `${k.prefix}…`} (${l})`)
      }
    }
  }
  assert.ok(n > 900, `${n} called keys`)
  assert.deepEqual(missing, [])
  assert.deepEqual(unverifiable, [], 'key without a checkable prefix')
  assert.deepEqual(atLoad, [])
})

test('client guard: it sees an added text, a key called at load time, and ignores comments, technical terms and { fr } labels of meta.js files', t => {
  if (!parse) return t.skip('client not installed (npm ci in client/)')
  assert.deepEqual(scanClient("// déjà\nconst a = <p>{t('x.y')} <code>config.json</code></p>\n").texts, [])
  assert.deepEqual(scanClient("const a = <button>Voir</button>\nconst b = <i title=\"Fermer le volet\" />\nconst c = `réseau : ${x}`\n").texts,
    ['1: Voir', '2: title="Fermer le volet"', '3: `réseau : `'])
  assert.deepEqual(scanClient("export default { labels: { r: { en: 'Failing', fr: 'En échec' } } }\n", 'plugins/demo/meta.js').texts, [])
  assert.deepEqual(scanClient("export default { labels: { r: { en: 'Failing', fr: 'En échec' } } }\n", 'views/X.jsx').texts, ["1: 'En échec'"])
  const s = scanClient("const L = t('a.b')\nconst M = { get label() { return t('c.d') } }\nconst N = tLabels('e', ['f'])\nconst f = () => t(`g.${x}`)\n")
  assert.deepEqual(s.moduleT, [1])
  assert.deepEqual(s.keys.map(k => k.key ?? `${k.prefix}…`), ['a.b', 'c.d', 'e.f', 'g.…'])
  // "{'…'}" without accent in a visible attribute, hardcoded ternaries and ||, JSX child
  assert.deepEqual(scanClient("const a = <i title={'Fermer le volet'} aria-label={x || 'utilisation'} className={'flex gap'} />\n").texts, ['1: {Fermer le volet}', '1: {utilisation}'])
  assert.deepEqual(scanClient("const a = <p>{ok ? 'online' : 'offline'} {n && 'voir plus'} {ok ? 'CPU' : '—'}</p>\n").texts, ['1: {online}', '1: {offline}', '1: {voir plus}'])
  assert.deepEqual(scanClient("const a = <b title={ok ? t('a.b') : `${n} MAC`}>{t('c.d')}</b>\n").texts, [])
  // renamed t, namespace, ternary branches, dynamic keys
  const r = scanClient("import { t as tt, locale } from '../i18n/index.js'\nimport * as I from './i18n/index.js'\nconst A = I.t('top')\nconst f = () => [tt('a.b'), I.t('c.d'), I.tLabels('e', ['f']), tt(ok ? 'g.h' : 'i.j'), tt(k), I.t(`${k}`), tt('p.' + k)]\n")
  assert.deepEqual(r.moduleT, [3])
  assert.deepEqual(r.keys.map(k => k.dynamic ? '?' : k.key ?? `${k.prefix}…`), ['top', 'a.b', 'c.d', 'e.f', 'g.h', 'i.j', '?', '…', 'p.…'])
  assert.deepEqual(scanClient("import { t } from './other.js'\nimport * as I from './other.js'\nconst f = () => I.t('x')\n").keys.map(k => k.key), [])
})

test('plugin catalogs (client): same keys in fr and en, each registered by its meta.js', () => {
  const dir = path.join(CLIENT, 'src/plugins')
  const ids = fs.readdirSync(dir).filter(id => fs.existsSync(path.join(dir, id, 'locales')))
  assert.deepEqual(ids.sort(), ['example', 'gitea'])
  for (const id of ids) {
    const [fr, en] = ['fr', 'en'].map(l => Object.keys(json(path.join(dir, id, 'locales', `${l}.json`))).sort())
    assert.deepEqual(fr, en, id)
    assert.match(fs.readFileSync(path.join(dir, id, 'meta.js'), 'utf8'), new RegExp(`registerCatalog\\('${id}', \\{ fr, en \\}\\)`), id)
  }
})

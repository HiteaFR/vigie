// Client ESLint. The config (client/eslint.config.js) rejects a violation of the
// hooks rules and accepts clean code whatever its formatting; all of client/ passes;
// npm script and CI step (after the client install, before the tests). Skipped only if
// the client is not installed (the CI guard forbids it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CI_FILES, GITEA_CI, readCi } from './workflows.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = path.join(ROOT, 'client')
const ESLINT = path.join(CLIENT, 'node_modules/eslint/bin/eslint.js')
const lint = (code, file = 'src/injecte.jsx') => spawnSync(process.execPath, [ESLINT, '--stdin', '--stdin-filename', file, '--format', 'json'], { cwd: CLIENT, input: code, encoding: 'utf8' })
const rules = r => JSON.parse(r.stdout)[0].messages.map(m => `${m.ruleId}:${m.severity}`)

test('lint: hooks breaking the rules (conditional, missing dependency), unused variable and unknown global → errors; clean but badly formatted code → 0', t => {
  if (!fs.existsSync(ESLINT)) {
    t.skip('client not installed (npm ci in client/)')
    return
  }
  const cond = lint("import { useState } from 'react'\nexport function A({ on }) {\n  if (on) { const [x] = useState(0); return x }\n  return null\n}\n")
  assert.equal(cond.status, 1)
  assert.deepEqual(rules(cond), ['react-hooks/rules-of-hooks:2'])
  const deps = lint("import { useEffect } from 'react'\nexport function B({ id, load }) {\n  useEffect(() => { load(id) }, [id])\n  return null\n}\n")
  assert.equal(deps.status, 1)
  assert.deepEqual(rules(deps), ['react-hooks/exhaustive-deps:2'])
  const unused = lint('export function C() { const inutile = 1; return documentInconnu }\n')
  assert.equal(unused.status, 1)
  assert.deepEqual(rules(unused).sort(), ['no-undef:2', 'no-unused-vars:2'])
  // browser: window, document, localStorage known; no style rule
  const clean = lint("export function D(){return  window.location.href+document.title+localStorage.length+  1}\n\n\n")
  assert.equal(clean.status, 0, clean.stdout)
  assert.deepEqual(rules(clean), [])
})

test('lint: all of client/ passes without error or warning; no unused eslint-disable directive', t => {
  if (!fs.existsSync(ESLINT)) {
    t.skip('client not installed (npm ci in client/)')
    return
  }
  const r = spawnSync(process.execPath, [ESLINT, '.', '--max-warnings', '0', '--report-unused-disable-directives-severity', 'error'], { cwd: CLIENT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('static: npm lint script, flat config (recommended, rules-of-hooks and exhaustive-deps as errors, browser globals), CI step between the client install and the tests', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.lint, 'eslint . --max-warnings 0')
  for (const [name, v] of Object.entries({ eslint: '10.12.0', 'eslint-plugin-react-hooks': '7.1.1', '@eslint/js': '10.0.1', globals: '17.13.0' })) {
    assert.equal(pkg.devDependencies[name], v, name)
  }
  const conf = fs.readFileSync(path.join(CLIENT, 'eslint.config.js'), 'utf8')
  assert.match(conf, /js\.configs\.recommended/)
  assert.match(conf, /'react-hooks\/rules-of-hooks': 'error'/)
  assert.match(conf, /'react-hooks\/exhaustive-deps': 'error'/)
  assert.match(conf, /globals: globals\.browser/)
  // each CI present (GitHub; Gitea while it is in the tree)
  for (const f of CI_FILES) {
    const ci = readCi(f)
    const [install, lint] = f === GITEA_CI ? ['- name: Installation du client', '- name: Lint du client'] : ['- name: Install the client', '- name: Lint the client']
    const at = s => ci.indexOf(s)
    assert.ok(at(install) > 0, `${f}: ${install}`)
    assert.match(ci, f === GITEA_CI ? /- name: Lint du client\n {8}run: \|\n {10}cd client\n {10}npm run lint\n/ : /- name: Lint the client\n {8}working-directory: client\n {8}run: npm run lint\n/, f)
    assert.ok(at(install) < at(lint) && at(lint) < at('npm test > "$log"'), f)
  }
})

// The CI tests and never deploys. Static checks of each CI file present: .github/workflows/ci.yml
// (public CI) and .gitea/workflows/ci.yml while it is in the tree (Gitea CI, absent from
// the public snapshot). Deployment lives elsewhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_FILES, GITEA_CI, GITHUB_CI, hasGiteaCi, readCi, ciCode } from './workflows.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPLOY = path.join(ROOT, '.gitea/workflows/deploy.yml')

test('ci.yml: lint, check-config on config.example.json, npm test with the "# skipped 0" guard, build', () => {
  assert.ok(CI_FILES.includes(GITHUB_CI))
  for (const f of CI_FILES) {
    const code = ciCode(readCi(f))
    const at = s => code.indexOf(s)
    for (const s of ['npm ci', 'npm run lint', 'node scripts/check-config.js ../config.example.json', 'npm test', "grep -qx '# skipped 0'", 'npm run build']) assert.ok(at(s) > 0, `${f}: ${s}`)
    assert.ok(at('npm run lint') < at('npm test') && at('npm test') < at('npm run build'), f)
    assert.doesNotMatch(code, /check-config\.js \.\.\/config\.json/, `${f}: never the production config`)
  }
})

test('ci.yml never deploys: no sync, unit, systemctl, /opt, /etc, /var/lib or ops/; its own concurrency group', () => {
  for (const f of CI_FILES) {
    const code = ciCode(readCi(f))
    for (const re of [/sync\.sh/, /prune-assets/, /icons-migrate/, /systemctl/, /\binstall\s+-m/, /\/opt\//, /\/etc\//, /\/var\/lib\//, /\bops\//, /rsync/, /\bssh\b/, /deploy\.sh/]) {
      assert.doesNotMatch(code, re, `${f}: ${re}`)
    }
    assert.match(code, f === GITEA_CI ? /concurrency:\n {2}group: tests-[a-z0-9-]+-\$\{\{ github\.ref \}\}/ : /concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true/, f)
    assert.doesNotMatch(code, /group: deploy-/, f)
  }
})

test('ci.yml off main while deploy.yml exists (deploy.yml tests and deploys main); the GitHub CI covers main and PRs', () => {
  assert.match(ciCode(readCi(GITHUB_CI)), /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request: \{\}/m)
  if (!hasGiteaCi) return
  const code = ciCode(readCi(GITEA_CI))
  if (fs.existsSync(DEPLOY)) {
    assert.match(code, /push:\n {4}branches-ignore: \[main\]/)
    assert.match(fs.readFileSync(DEPLOY, 'utf8'), /push:\n {4}branches: \[main\]/)
  } else {
    assert.doesNotMatch(code, /branches-ignore: \[main\]/, 'without deploy.yml, ci.yml covers main too')
  }
})

test('ci.yml on a disposable runner (GitHub: ubuntu-latest; Gitea: generic label + host label, in a container), never on the production host; Node 22 installed before npm ci', () => {
  for (const f of CI_FILES) {
    const code = ciCode(readCi(f))
    const runs = [...code.matchAll(/^ {4}runs-on: (.+)$/gm)].map(m => m[1])
    assert.ok(runs.length >= 1, f)
    for (const r of runs) assert.match(r, f === GITEA_CI ? /^\[ubuntu-latest, [\w.-]+\]$/ : /^ubuntu-latest$/, `${f}: ${r}`)
    assert.doesNotMatch(code, /self-hosted|dashboard\]|dashboard-deploy/, `${f}: no runner on the production host`)
    assert.match(code, /uses: actions\/setup-node@\S+(?: # v\d+\.\d+\.\d+)?\n {8}with:\n {10}node-version: 22\n/, f)
    assert.ok(code.indexOf('setup-node') < code.indexOf('npm ci'), `${f}: Node installed before npm ci`)
  }
})

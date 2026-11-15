// /api/healthz exposes the version (package.json) and the deployed commit (REVISION file at the
// root of the code, written before the synchronization, validated: hexadecimal sha of 7 to 40 characters).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRevision, REVISION_RE } from '../lib/revision.js'
import { VERSION } from '../lib/user-agent.js'
import { bootServer, request } from './server-boot.js'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'))

test('readRevision: hexadecimal sha of 7 to 40 characters (surrounding whitespace ignored); anything else → null', t => {
  const dir = tmpDir('dash-revision-', t)
  const put = c => { const f = path.join(dir, `r-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, c); return f }
  assert.equal(readRevision(put('3f45ba6\n')), '3f45ba6')
  assert.equal(readRevision(put('  0123456789abcdef0123456789abcdef01234567  ')), '0123456789abcdef0123456789abcdef01234567')
  for (const bad of ['', '\n', '3f45ba', '0123456789abcdef0123456789abcdef012345678', 'ABCDEF1', 'v1.1.2', '3f45ba6 extra', '3f45ba6\n3f45ba6', '<script>', '../../etc', 'g123456']) {
    assert.equal(readRevision(put(bad)), null, JSON.stringify(bad))
  }
  assert.equal(readRevision(put('a'.repeat(200))), null, 'file too large')
  assert.equal(readRevision(path.join(dir, 'absent')), null)
  assert.equal(readRevision(dir), null, 'a folder')
  assert.ok(REVISION_RE.test('abcdef0') && !REVISION_RE.test('abcdef'))
})

test('/api/healthz: version from package.json and commit (REVISION file of the code, otherwise null)', async t => {
  assert.equal(VERSION, pkg.version)
  const s = await bootServer(t)
  const r = await request(s.port, '/api/healthz')
  assert.equal(r.status, 200)
  assert.equal(r.json.version, pkg.version)
  // the bench starts the real server of this repository: REVISION missing (case of the tests, of the CI
  // before the synchronization), or present after a local manual deployment
  assert.equal(r.json.commit, readRevision(path.join(ROOT, 'REVISION')))
  assert.ok(r.json.commit === null || REVISION_RE.test(r.json.commit))
})

test('static: index.js reads REVISION at the root at startup; the pipeline writes it in the source tree BEFORE sync.sh; never committed', () => {
  const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8')
  assert.match(index, /^const REVISION = readRevision\(path\.join\(ROOT, 'REVISION'\)\)$/m)
  assert.match(index, /ok: true, version: VERSION, commit: REVISION,/)
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\/REVISION$/m)
  // former pipeline, as long as it exists (to be removed, taken over elsewhere)
  const ci = path.join(ROOT, '.gitea/workflows/deploy.yml')
  if (fs.existsSync(ci)) {
    const y = fs.readFileSync(ci, 'utf8')
    assert.match(y, /run: git rev-parse --short HEAD > REVISION\n/)
    assert.ok(y.indexOf('> REVISION') < y.indexOf('deploy/sync.sh .'), 'before the synchronization')
  }
  const sh = path.join(ROOT, 'deploy/deploy.sh')
  if (fs.existsSync(sh)) {
    const x = fs.readFileSync(sh, 'utf8')
    assert.match(x, /^git rev-parse --short HEAD > REVISION$/m)
    assert.ok(x.indexOf('> REVISION') < x.indexOf('deploy/sync.sh .'), 'before the synchronization')
  }
})

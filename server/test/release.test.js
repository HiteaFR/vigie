// Release of a version: .github/workflows/release.yml (static checks, nothing is run), the helper
// scripts/release.mjs (version agreement, release notes) and the options of scripts/docker-proof.sh
// used by the workflow (fake docker, no real call).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changelogs } from './changelog.js'
import { tmpDir } from './tmpdir.js'
import { check, notes, entry, absoluteLinks, IMAGE } from '../../scripts/release.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const WF = read('.github/workflows/release.yml')
const code = text => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
const VERSION = JSON.parse(read('server/package.json')).version
// public changelog: CHANGELOG.md of the snapshot, or its template in the Gitea tree
const PUBLIC_LOG = changelogs().filter(l => l.isPublic).at(-1).file

// job block: lines under "  <name>:" up to the next job
function job(name) {
  const lines = code(WF).split('\n')
  const i = lines.indexOf(`  ${name}:`)
  assert.ok(i > 0, `job ${name}`)
  const out = []
  for (const l of lines.slice(i + 1)) {
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

// --- workflow ---------------------------------------------------------------------------------------

test('release.yml: on vX.Y.Z tags (publish) and on the pull requests touching the image or the tooling (dry run); read-only token by default', () => {
  const c = code(WF)
  assert.match(c, /^on:\n {2}push:\n {4}tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]\n {2}pull_request:\n {4}paths:\n/m)
  for (const p of ['.github/workflows/release.yml', 'Dockerfile', 'docker/**', 'docker-compose.yml', 'scripts/docker-proof.sh', 'scripts/release.mjs', 'server/package-lock.json', 'client/package-lock.json']) {
    assert.match(c, new RegExp(`^ {6}- ${p.replace(/[.*]/g, '\\$&')}$`, 'm'), p)
  }
  assert.match(c, /^permissions:\n {2}contents: read$/m)
  assert.doesNotMatch(c, /write-all|pull_request_target|workflow_run/)
  assert.match(c, /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m)
  const jobs = [...c.matchAll(/^ {2}([\w-]+):$/gm)].map(m => m[1]).filter(n => c.indexOf(`  ${n}:`) > c.indexOf('\njobs:'))
  assert.deepEqual(jobs, ['dry-run', 'publish'])
  for (const r of c.matchAll(/runs-on: (.+)/g)) assert.equal(r[1], 'ubuntu-latest')
})

test('release.yml: write permissions only in the publish job, which runs only on a tag push; the dry run is read-only and pushes nothing', () => {
  const dry = job('dry-run')
  assert.match(dry, /^ {4}if: github\.event_name == 'pull_request'$/m)
  assert.match(dry, /^ {4}permissions:\n {6}contents: read\n {4}steps:/m)
  assert.doesNotMatch(dry, /: write|login-action|push: true|push=true|imagetools|gh release|secrets\./)
  const pub = job('publish')
  assert.match(pub, /^ {4}if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)$/m)
  const perms = pub.match(/^ {4}permissions:\n((?: {6}.+\n)+)/m)[1].split('\n').filter(Boolean).map(l => l.trim().replace(/\s+#.*$/, ''))
  assert.deepEqual(perms, ['contents: write', 'packages: write', 'id-token: write', 'attestations: write'])
  // the only secret is the token of the run
  assert.deepEqual([...code(WF).matchAll(/secrets\.(\w+)/g)].map(m => m[1]), ['GITHUB_TOKEN'])
})

test('release.yml: actions pinned by commit SHA (version in a comment), QEMU and BuildKit images pinned by digest, checkout without persisted credentials', () => {
  const uses = [...WF.matchAll(/uses: (\S+)(.*)$/gm)]
  assert.ok(uses.length >= 10)
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref}: pinned by SHA`)
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${ref}: version in a comment`)
  }
  // same action, same SHA everywhere
  const byName = new Map()
  for (const [, ref] of uses) {
    const [n, sha] = ref.split('@')
    assert.equal(byName.get(n) ?? sha, sha, n)
    byName.set(n, sha)
  }
  assert.match(WF, /^ {2}BINFMT_IMAGE: docker\.io\/tonistiigi\/binfmt:qemu-v[\d.]+@sha256:[0-9a-f]{64}$/m)
  assert.match(WF, /^ {2}BUILDKIT_IMAGE: moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}$/m)
  assert.equal((WF.match(/image: \$\{\{ env\.BINFMT_IMAGE \}\}/g) ?? []).length, 2)
  assert.equal((WF.match(/driver-opts: image=\$\{\{ env\.BUILDKIT_IMAGE \}\}/g) ?? []).length, 2)
  assert.equal((WF.match(/uses: actions\/checkout@\S+ # v[\d.]+\n {8}with:\n {10}persist-credentials: false/g) ?? []).length, 2)
})

test('release.yml (publish): version checked first; one multi-platform build pushed BY DIGEST; both proofs on that digest pulled back; tags only then, on the same digest, checked; provenance; release last', () => {
  const pub = job('publish')
  const at = s => {
    const i = pub.indexOf(s)
    assert.ok(i > 0, s)
    return i
  }
  const order = [
    'node scripts/release.mjs check "$v"',
    'platforms: linux/amd64,linux/arm64',
    'push-by-digest=true,name-canonical=true,push=true',
    'docker pull -q --platform "linux/$arch" "$IMAGE@$DIGEST"',
    'VIGIE_PROOF_PLATFORM: linux/amd64',
    'VIGIE_PROOF_PLATFORM: linux/arm64',
    'docker buildx imagetools create',
    '[ "$got" = "$DIGEST" ]',
    'subject-digest: ${{ steps.build.outputs.digest }}',
    'git archive --format=tar.gz --prefix="vigie-agents-$VERSION/"',
    'subject-path: dist/vigie-agents-*.tar.gz',
    'gh release create "v$VERSION"',
  ]
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`)
  assert.match(pub, /v=\$\{GITHUB_REF_NAME#v\}/)
  // a single build: no tag on the build, no second build-push
  assert.equal((pub.match(/docker\/build-push-action@/g) ?? []).length, 1)
  const build = pub.slice(at('docker/build-push-action@'), at('Pull the digest back'))
  assert.doesNotMatch(build, /^ {10}tags:/m, 'pushed without a tag')
  assert.match(build, /build-args: REVISION=\$\{\{ github\.sha \}\}/)
  assert.match(build, /org\.opencontainers\.image\.source=https:\/\/github\.com\/\$\{\{ github\.repository \}\}/)
  assert.match(build, /org\.opencontainers\.image\.licenses=Apache-2\.0/)
  // the four tags, on the proven digest
  assert.match(pub, /--tag "\$IMAGE:\$VERSION" --tag "\$IMAGE:\$minor" --tag "\$IMAGE:\$major" --tag "\$IMAGE:latest" \\\n {12}"\$IMAGE@\$DIGEST"/)
  assert.match(pub, /for t in "\$VERSION" "\$minor" "\$major" latest; do/)
  // proofs: given image, platform, version, longer wait under QEMU
  for (const arch of ['amd64', 'arm64']) {
    const p = pub.slice(at(`VIGIE_PROOF_IMAGE: vigie-candidate:${arch}`))
    assert.match(p, new RegExp(`^ {10}VIGIE_PROOF_PLATFORM: linux/${arch}\\n {10}VIGIE_PROOF_VERSION: \\$\\{\\{ steps\\.version\\.outputs\\.version \\}\\}\\n`, 'm'))
    assert.match(p, /run: sh scripts\/docker-proof\.sh/)
  }
  assert.match(pub, /VIGIE_PROOF_PLATFORM: linux\/arm64\n.*\n {10}VIGIE_PROOF_WAIT: \d{3,}\n/)
  assert.match(pub, /push-to-registry: true/)
  assert.match(pub, /sha256sum "vigie-agents-\$VERSION\.tar\.gz" > SHA256SUMS/)
  assert.match(pub, /gh release create "v\$VERSION" "dist\/vigie-agents-\$VERSION\.tar\.gz" dist\/SHA256SUMS \\\n {12}--verify-tag --title "Vigie \$VERSION" --notes-file "\$RUNNER_TEMP\/notes\.md"/)
  assert.match(pub, /node scripts\/release\.mjs notes "\$VERSION" --digest "\$DIGEST"/)
})

test('release.yml (dry run): same checks, both platforms built and proven locally, nothing pushed', () => {
  const dry = job('dry-run')
  const at = s => {
    const i = dry.indexOf(s)
    assert.ok(i > 0, s)
    return i
  }
  assert.ok(at('node scripts/release.mjs check "$v"') < at('node scripts/release.mjs notes "$v"'))
  assert.ok(at('platforms: linux/amd64') < at('VIGIE_PROOF_IMAGE: vigie-candidate:amd64'))
  assert.ok(at('VIGIE_PROOF_IMAGE: vigie-candidate:amd64') < at('platforms: linux/arm64'))
  assert.ok(at('platforms: linux/arm64') < at('VIGIE_PROOF_IMAGE: vigie-candidate:arm64'))
  assert.equal((dry.match(/load: true/g) ?? []).length, 2)
  assert.match(dry, /git archive --format=tar\.gz --prefix="vigie-agents-\$v\/"/)
})

test('release.yml: the ARP companion (arp-scan, GPL) is never built nor published; the image is ghcr.io/hiteafr/vigie', () => {
  assert.doesNotMatch(code(WF), /net-scan/)
  assert.match(WF, /^ {2}IMAGE: ghcr\.io\/hiteafr\/vigie$/m)
  assert.equal(IMAGE, 'ghcr.io/hiteafr/vigie')
  assert.match(WF, /The ARP companion image \(docker\/net-scan, arp-scan under the GPL\) is never published/)
})

// --- version agreement ----------------------------------------------------------------------------

test(`the version of the repository (${VERSION}) agrees everywhere (package.json, package-lock.json, compose image, README, public changelog)`, () => {
  assert.deepEqual(check(VERSION, { changelog: PUBLIC_LOG }), [])
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release.mjs'), 'check', VERSION, '--changelog', PUBLIC_LOG], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`version ${VERSION.replace(/\./g, '\\.')} agrees everywhere`))
})

// minimal copy of the files read by check(), to break them one at a time
function fixture(t, v = '2.3.4') {
  const dir = tmpDir('vigie-release-', t)
  const w = (f, s) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), s)
  }
  for (const d of ['server', 'client']) {
    w(`${d}/package.json`, JSON.stringify({ name: d, version: v }))
    w(`${d}/package-lock.json`, JSON.stringify({ name: d, version: v, lockfileVersion: 3, packages: { '': { name: d, version: v } } }))
  }
  w('docker-compose.yml', `services:\n  vigie:\n    image: \${VIGIE_IMAGE:-ghcr.io/hiteafr/vigie:${v}}\n  init:\n    image: \${VIGIE_IMAGE:-ghcr.io/hiteafr/vigie:${v}}\n`)
  w('README.md', `git clone --branch v${v} https://github.com/HiteaFR/vigie.git && cd vigie\n`)
  w('CHANGELOG.md', `# Changelog\n\n## [Unreleased]\n\n## [${v}] - 2026-12-01\n\n### Added\n\n- Something, see [docs/x.md](docs/x.md#a) and [site](https://example.com/).\n\n## [2.3.3] - 2026-11-30\n\n- Older.\n\n[Unreleased]: https://github.com/HiteaFR/vigie/compare/v${v}...HEAD\n[${v}]: https://github.com/HiteaFR/vigie/releases/tag/v${v}\n[2.3.3]: https://github.com/HiteaFR/vigie/releases/tag/v2.3.3\n`)
  return { dir, w, edit: (f, fn) => w(f, fn(fs.readFileSync(path.join(dir, f), 'utf8'))) }
}

test('check: each disagreement is named (package.json, lockfile, compose image, README, changelog heading, empty entry, links); malformed version refused', t => {
  const ok = fixture(t)
  assert.deepEqual(check('2.3.4', { root: ok.dir }), [])
  assert.deepEqual(check('2.3', { root: ok.dir }), ['version "2.3": x.y.z expected'])
  const cases = [
    ['server/package.json', s => s.replace('2.3.4', '2.3.3'), /server\/package\.json: version 2\.3\.3/],
    ['client/package-lock.json', s => s.replace(/"version":"2\.3\.4"}}}$/, '"version":"2.3.3"}}}'), /client\/package-lock\.json: version 2\.3\.4\/2\.3\.3/],
    ['docker-compose.yml', s => s.replace(/vigie:2\.3\.4}\n$/, 'vigie:latest}\n'), /docker-compose\.yml: ghcr\.io\/hiteafr\/vigie:latest, 2\.3\.4 expected/],
    ['docker-compose.yml', s => s.replace(/ghcr\.io\/hiteafr\/vigie/g, 'vigie'), /docker-compose\.yml: no ghcr\.io\/hiteafr\/vigie image/],
    ['README.md', s => s.replace('v2.3.4', 'v2.3.3'), /README\.md: git clone --branch v2\.3\.3, v2\.3\.4 expected/],
    ['README.md', () => 'nothing\n', /README\.md: no "git clone --branch v<version>"/],
    ['CHANGELOG.md', s => s.replace('## [2.3.4] - 2026-12-01', '## [2.3.4]'), /CHANGELOG\.md: no "## \[2\.3\.4\] - YYYY-MM-DD" entry/],
    ['CHANGELOG.md', s => s.replace(/### Added\n\n- Something[^\n]*\n/, ''), /CHANGELOG\.md: empty 2\.3\.4 entry/],
    ['CHANGELOG.md', s => s.replace('## [Unreleased]\n\n', ''), /first entry "## \[Unreleased\]" expected/],
    ['CHANGELOG.md', s => s.replace('compare/v2.3.4...HEAD', 'compare/v2.3.3...HEAD'), /link \[Unreleased\] to compare\/v2\.3\.4\.\.\.HEAD missing/],
    ['CHANGELOG.md', s => s.replace('[2.3.4]: https://github.com/HiteaFR/vigie/releases/tag/v2.3.4\n', ''), /link \[2\.3\.4\] to releases\/tag\/v2\.3\.4 missing/],
  ]
  for (const [f, fn, re] of cases) {
    const fx = fixture(t)
    fx.edit(f, fn)
    const errors = check('2.3.4', { root: fx.dir })
    assert.ok(errors.some(e => re.test(e)), `${f}: ${re} in ${JSON.stringify(errors)}`)
  }
  // an older version is not the first one under Unreleased
  assert.ok(check('2.3.3', { root: ok.dir }).some(e => /first version entry "## \[2\.3\.4\] - 2026-12-01"/.test(e)))
  // command line: exit 1 and the list on stderr; usage: exit 2
  const fx = fixture(t)
  fx.edit('README.md', s => s.replace('v2.3.4', 'v9.9.9'))
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/release.mjs'), ...a], { cwd: fx.dir, encoding: 'utf8' })
  const r = cli('check', '2.3.4', '--changelog', path.join(fx.dir, 'CHANGELOG.md'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /✗ server\/package\.json: version \d+\.\d+\.\d+, 2\.3\.4 expected/, 'the repository files are read, not the cwd')
  assert.equal(cli('nope').status, 2)
  assert.equal(cli('check', '2.3.4', '--bogus', 'x').status, 1)
})

// --- notes ----------------------------------------------------------------------------------------

test('notes: entry of the version only, relative links pinned to the tag, image with its digest, agents archive and checksums; bad version, digest or missing entry refused', t => {
  const { dir } = fixture(t)
  const digest = `sha256:${'ab'.repeat(32)}`
  const n = notes('2.3.4', { root: dir, digest })
  assert.ok(n.startsWith('### Added\n\n- Something, see [docs/x.md](https://github.com/HiteaFR/vigie/blob/v2.3.4/docs/x.md#a) and [site](https://example.com/).'))
  assert.doesNotMatch(n, /Older|\[Unreleased\]:|## \[2\.3\.4\]/)
  assert.ok(n.includes(`Digest: \`${digest}\``))
  for (const s of ['docker pull ghcr.io/hiteafr/vigie:2.3.4', 'gh attestation verify oci://ghcr.io/hiteafr/vigie:2.3.4 --repo HiteaFR/vigie', '`vigie-agents-2.3.4.tar.gz`', '`SHA256SUMS`', 'linux/amd64 and linux/arm64', 'not published']) assert.ok(n.includes(s), s)
  assert.ok(n.includes('(https://github.com/HiteaFR/vigie/blob/v2.3.4/docs/docker.md)'))
  assert.doesNotMatch(notes('2.3.4', { root: dir }), /Digest:/)
  assert.throws(() => notes('2.3.4', { root: dir, digest: 'sha256:abc' }), /digest/)
  assert.throws(() => notes('v2.3.4', { root: dir }), /x\.y\.z/)
  assert.throws(() => notes('9.9.9', { root: dir }), /no 9\.9\.9 entry/)
  // the real public changelog renders for the current version
  assert.ok(notes(VERSION, { changelog: PUBLIC_LOG }).length > 500)
})

test('entry and absoluteLinks: entry stops at the next heading or the link block; absolute links, anchors and mailto kept', () => {
  const log = '## [Unreleased]\n\n## [1.0.0] - 2026-01-02\n\nBody [a](docs/a.md).\n\n[Unreleased]: x\n[1.0.0]: y\n'
  assert.deepEqual(entry(log, '1.0.0'), { date: '2026-01-02', body: 'Body [a](docs/a.md).' })
  assert.equal(entry(log, '1.0'), null)
  assert.equal(absoluteLinks('[a](./x.md) [b](https://h/) [c](#d) [e](mailto:m@example.com)', '1.0.0'),
    '[a](https://github.com/HiteaFR/vigie/blob/v1.0.0/x.md) [b](https://h/) [c](#d) [e](mailto:m@example.com)')
})

// --- proof script options (fake docker) -----------------------------------------------------------

function proof(t, env, docker = '') {
  const dir = tmpDir('vigie-proof-opt-', t)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(dir, 'docker.log')
  const w = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  w('docker', `printf '%s | platform=%s\\n' "$*" "\${DOCKER_DEFAULT_PLATFORM-<none>}" >>"${log}"
${docker}
case "$1 $2" in 'image inspect') exit 1 ;; esac
exit 0`)
  w('git', `case "$*" in *rev-parse*) echo 0123456789abcdef0123456789abcdef01234567 ;; esac`)
  w('tar', `cat >/dev/null; while [ $# -gt 0 ]; do [ "$1" = -C ] && d=$2; shift; done; echo 'services: {}' >"$d/docker-compose.yml"`)
  w('ss', ':')
  w('curl', 'exit 1')
  const r = spawnSync('sh', [path.join(ROOT, 'scripts/docker-proof.sh')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, ...env } })
  return { ...r, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }
}

test('proof script: VIGIE_PROOF_PLATFORM, VIGIE_PROOF_WAIT and VIGIE_PROOF_VERSION validated before any docker call', t => {
  for (const [k, v, re] of [
    ['VIGIE_PROOF_PLATFORM', 'linux/386', /linux\/amd64 or linux\/arm64 expected/],
    ['VIGIE_PROOF_PLATFORM', 'arm64', /linux\/amd64 or linux\/arm64 expected/],
    ['VIGIE_PROOF_WAIT', '10', /30 seconds at least/],
    ['VIGIE_PROOF_WAIT', '1m', /number of seconds expected/],
    ['VIGIE_PROOF_VERSION', 'v1.2.0', /x\.y\.z expected/],
    ['VIGIE_PROOF_VERSION', '1.2.', /x\.y\.z expected/],
  ]) {
    const r = proof(t, { [k]: v })
    assert.equal(r.status, 2, `${k}=${v}: ${r.stderr}`)
    assert.match(r.stderr, re)
    assert.equal(r.log, '', 'no docker call')
  }
})

test('proof script: VIGIE_PROOF_IMAGE missing on the machine → refused before anything is created; present → tagged with the unique name instead of a build, platform exported to compose', t => {
  const missing = proof(t, { VIGIE_PROOF_IMAGE: 'vigie-candidate:arm64' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /image vigie-candidate:arm64 \(VIGIE_PROOF_IMAGE\) not found on this machine/)
  assert.doesNotMatch(missing.log, /compose -f|^tag /m)
  // present; the service never gets healthy-ready logs, so the run stops at step 2 (after the tag)
  const r = proof(t, { VIGIE_PROOF_IMAGE: 'vigie-candidate:arm64', VIGIE_PROOF_PLATFORM: 'linux/arm64', VIGIE_PROOF_WAIT: '30' },
    `case "$*" in 'image inspect vigie-candidate:arm64') exit 0 ;; inspect\\ --format*) echo healthy; exit 0 ;; esac`)
  assert.notEqual(r.status, 0)
  assert.match(r.log, /^tag vigie-candidate:arm64 vigie-proof-\d{14}-\d+:local \| platform=linux\/arm64$/m)
  assert.doesNotMatch(r.log, / build vigie /)
  assert.match(r.stdout, /ok {3}1\. image given \(vigie-candidate:arm64\), tagged vigie-proof-/)
  assert.match(r.log, /down -v --rmi all --remove-orphans/, 'cleanup of the project (and of the unique tag)')
})

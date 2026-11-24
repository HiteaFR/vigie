// Showcase and governance of the public repository. Presence and shape of the files (short English
// README, docs/, official LICENSE, NOTICE, CONTRIBUTING with DCO, SECURITY, code of conduct, issue
// and PR templates, GitHub CI pinned by SHA, Dependabot with a 14-day delay), valid relative
// links, and no private term of the author's homelab in these files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { changelogs } from './changelog.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
const exists = f => fs.existsSync(path.join(ROOT, f))

export const DOCS = ['installation', 'configuration', 'docker', 'security', 'features', 'icons', 'agent', 'network', 'updates', 'alerts', 'proxmox', 'deployment', 'development', 'plugins']
  .map(d => `docs/${d}.md`)
export const PUBLIC = ['README.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
  '.github/workflows/ci.yml', '.github/workflows/release.yml', 'scripts/release.mjs', '.github/dependabot.yml', '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', ...DOCS,
  'agent/README.md', 'agent/dash-report/README.md', 'agent/net-scan/README.md', 'NOTICE']
test('public files present', () => {
  for (const f of PUBLIC) assert.ok(exists(f), `${f} missing`)
})

// The list of private terms never ships. It lives in docs/publication/ (excluded from the
// export) with its scanner; here, every file of the Gitea tree that the export keeps is scanned
// (git ls-files minus docs/publication/exclus.txt). In the public snapshot the folder is absent.
const SCANNER = 'docs/publication/scan-prive.mjs'
test('no private term in any file the public snapshot keeps (list and scanner outside the public tree)', async () => {
  if (!exists(SCANNER)) {
    assert.equal(exists('docs/publication'), false, 'scanner absent only with the whole folder (public snapshot)')
    return
  }
  const { loadBlacklist, scanFiles, isExcluded } = await import(pathToFileURL(path.join(ROOT, SCANNER)).href)
  const bl = loadBlacklist()
  assert.ok(bl.terms.length >= 20 && bl.excluded.includes('docs/publication/') && bl.excluded.includes('.gitea/'))
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const kept = tracked.filter(f => !isExcluded(f, bl.excluded) && exists(f))
  assert.ok(kept.length > 400 && kept.length < tracked.length, `${kept.length} / ${tracked.length}`)
  const { hits, scanned } = scanFiles(ROOT, kept, bl)
  assert.ok(scanned > 400)
  assert.deepEqual(hits, [])
})

test('short English README: promise, planned screenshots, integrations, security, installation (Docker and manual), links to docs/', () => {
  const r = read('README.md')
  assert.match(r, /^# Vigie\n/)
  assert.ok(r.split('\n').length < 220, `${r.split('\n').length} lines`)
  assert.doesNotMatch(r, /[àâéèêîôûç«»]/, 'README in English')
  for (const s of ['## Features', '## Integrations', '## Security model', '## Install', 'docs/screenshots/', 'docker compose run --rm init', 'npm run init', 'deploy/vigie.service.example', 'LICENSE', 'Apache License 2.0']) assert.ok(r.includes(s), s)
  for (const d of DOCS) assert.ok(r.includes(`(${d})`), `link to ${d}`)
})

test('relative links of the README and docs/: each target file exists', () => {
  const broken = []
  for (const f of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...DOCS, 'agent/README.md', 'agent/dash-report/README.md', 'agent/net-scan/README.md']) {
    for (const m of read(f).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target)) continue
      if (!exists(path.join(path.dirname(f), target))) broken.push(`${f} → ${target}`)
    }
  }
  assert.deepEqual(broken, [])
})

test('license and governance: official Apache-2.0 text, NOTICE and attributions, DCO, private reporting, Contributor Covenant, templates', () => {
  // fingerprint of the official text (https://www.apache.org/licenses/LICENSE-2.0.txt)
  assert.equal(crypto.createHash('md5').update(read('LICENSE')).digest('hex'), '3b83ef96387f14655fc854ddc3c6bd57')
  const notice = read('NOTICE')
  for (const s of ['Vigie', 'Apache License, Version 2.0', 'IEEE', 'oui.tsv', 'dashboard-icons', 'selfh.st', 'CC BY 4.0', 'Scanopy', 'Open-Meteo', 'arp-scan', 'Homepage', 'No code was copied']) assert.ok(notice.includes(s), `NOTICE: ${s}`)
  // agents: README in English
  for (const f of ['agent/README.md', 'agent/dash-report/README.md', 'agent/net-scan/README.md']) assert.doesNotMatch(read(f), /[àâéèêîôûç«»]/, f)
  const contrib = read('CONTRIBUTING.md')
  for (const s of ['Developer Certificate of Origin', 'https://developercertificate.org/', 'Signed-off-by:', 'git commit -s', 'SECURITY.md', '# skipped 0']) assert.ok(contrib.includes(s), `CONTRIBUTING: ${s}`)
  const sec = read('SECURITY.md')
  assert.match(sec, /do not open a public issue/i)
  assert.match(sec, /Report a vulnerability/)
  const coc = read('CODE_OF_CONDUCT.md')
  assert.match(coc, /^# Contributor Covenant Code of Conduct/)
  assert.match(coc, /version 2\.1/)
  assert.doesNotMatch(coc, /\[INSERT/)
  assert.match(coc, /reported to the community leaders responsible for enforcement at contact@hitea\.fr/)
  assert.match(read('.github/ISSUE_TEMPLATE/config.yml'), /blank_issues_enabled: false/)
  for (const f of ['bug_report.yml', 'feature_request.yml']) assert.match(read(`.github/ISSUE_TEMPLATE/${f}`), /^name: .+\ndescription: .+\n/)
  assert.match(read('.github/pull_request_template.md'), /signed off/i)
})

test('GitHub CI: PR and push, ubuntu-latest, Node 22, lint, tests with no skipped test, build, image built without being pushed; actions pinned by SHA; contents: read', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request: \{\}/m)
  assert.match(ci, /^permissions:\n {2}contents: read$/m)
  assert.doesNotMatch(ci, /write-all|: write\b/)
  assert.match(ci, /runs-on: ubuntu-latest/)
  assert.doesNotMatch(ci, /runs-on: (?!ubuntu-latest)/)
  assert.match(ci, /node-version: 22\b/)
  const uses = [...ci.matchAll(/uses: (\S+)(.*)$/gm)]
  assert.ok(uses.length >= 3)
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref}: pinned by SHA`)
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${ref}: version in a comment`)
  }
  for (const s of ['npm ci', 'npm run lint', 'node scripts/check-config.js ../config.example.json', 'npm test', "grep -qx '# skipped 0'", 'npm run build', 'docker build']) assert.ok(ci.includes(s), s)
  assert.doesNotMatch(ci, /docker push|docker login|--push|secrets\./, 'image never pushed, no secret')
  assert.ok(ci.indexOf('npm run lint') < ci.indexOf('npm test') && ci.indexOf('npm test') < ci.indexOf('npm run build'))
})

test('Dependabot: npm (client and server), actions, Docker; delay of at least 14 days everywhere', () => {
  const d = read('.github/dependabot.yml')
  assert.match(d, /^version: 2$/m)
  const blocks = d.split(/\n {2}- package-ecosystem: /).slice(1)
  const eco = blocks.map(b => `${b.split('\n')[0]} ${(b.match(/director(?:y|ies): (.+)/) ?? [])[1]}`)
  assert.deepEqual(eco, ['npm /client', 'npm /server', 'github-actions /', 'docker [/, /docker/net-scan]'])
  for (const b of blocks) {
    const days = Number((b.match(/cooldown:\n\s+default-days: (\d+)/) ?? [])[1])
    assert.ok(days >= 14, `${b.split('\n')[0]}: cooldown ${days}`)
  }
})

test('public changelog (snapshot, and its template in the Gitea tree): English, Keep a Changelog ("[Unreleased]", then dated versions, newest first, with their links), valid links', () => {
  const pub = changelogs().filter(l => l.isPublic)
  assert.ok(pub.length >= 1, 'public changelog or its template present')
  for (const { file, text } of pub) {
    assert.match(text, /^# Changelog\n/, file)
    const heads = text.match(/^## .*$/gm)
    assert.equal(heads[0], '## [Unreleased]', file)
    assert.ok(heads.length >= 2, `${file}: at least one release`)
    const versions = heads.slice(1).map(h => {
      const m = h.match(/^## \[(\d+)\.(\d+)\.(\d+)\] - (\d{4}-\d{2}-\d{2})$/)
      assert.ok(m, `${file}: heading ${h}`)
      assert.ok(!Number.isNaN(Date.parse(m[4])), `${file}: date ${m[4]}`)
      return { v: m.slice(1, 4).map(Number), name: m.slice(1, 4).join('.'), date: m[4] }
    })
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [versions[i - 1], versions[i]]
      assert.ok(a.v[0] > b.v[0] || (a.v[0] === b.v[0] && (a.v[1] > b.v[1] || (a.v[1] === b.v[1] && a.v[2] > b.v[2]))), `${file}: ${a.name} after ${b.name}`)
      assert.ok(a.date >= b.date, `${file}: dates of ${a.name} and ${b.name}`)
    }
    assert.ok(text.includes(`\n[Unreleased]: https://github.com/HiteaFR/vigie/compare/v${versions[0].name}...HEAD\n`), `${file}: [Unreleased] link`)
    for (const { name } of versions) assert.ok(text.includes(`\n[${name}]: https://github.com/HiteaFR/vigie/`), `${file}: [${name}] link`)
    assert.doesNotMatch(text, /[àâéèêîôûç«»]/, `${file}: in English`)
    // relative links read from the root (the template becomes CHANGELOG.md at the snapshot root)
    for (const m of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) if (!/^[a-z]+:/i.test(m[1])) assert.ok(exists(m[1]), `${file} → ${m[1]}`)
  }
})

test('Open-Meteo attribution under the weather widget: link to open-meteo.com, fr and en texts', () => {
  const src = read('client/src/views/Cockpit.jsx')
  const w = src.slice(src.indexOf('function Weather('), src.indexOf('\n}\n', src.indexOf('function Weather(')))
  assert.match(w, /<a href="https:\/\/open-meteo\.com\/" target="_blank" rel="noreferrer" [^>]*>\{t\('cockpit\.weather_source'\)\}<\/a>/)
  assert.equal(JSON.parse(read('client/src/i18n/fr.json'))['cockpit.weather_source'], 'Météo : Open-Meteo')
  assert.equal(JSON.parse(read('client/src/i18n/en.json'))['cockpit.weather_source'], 'Weather: Open-Meteo')
})

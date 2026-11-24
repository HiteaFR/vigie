#!/usr/bin/env node
// Release helpers, used by .github/workflows/release.yml and by the tests (no dependency, no network).
//
//   node scripts/release.mjs check <x.y.z> [--changelog <file>]
//     the version agrees everywhere: server/ and client/ package.json and package-lock.json, the
//     published image in docker-compose.yml, the clone command of the README, and a dated "## [x.y.z] - YYYY-MM-DD" entry of the
//     changelog (first version under "## [Unreleased]", with its reference links). Exit 1 with
//     the list of disagreements.
//   node scripts/release.mjs notes <x.y.z> [--digest sha256:<hex>] [--changelog <file>]
//     release notes on stdout: the changelog entry of that version (relative links made absolute,
//     pinned to the tag), then how to get the image and the agents.
//
// The changelog is the public one (English, Keep a Changelog): CHANGELOG.md of the public
// repository, docs/publication/CHANGELOG.public.md in the source tree.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = 'HiteaFR/vigie'
export const IMAGE = 'ghcr.io/hiteafr/vigie'
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE = /^\d+\.\d+\.\d+$/

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// entry of a version: text between its heading and the next level-2 heading or the link block
export function entry(changelog, version) {
  const m = changelog.match(new RegExp(`^## \\[${esc(version)}\\] - (\\d{4}-\\d{2}-\\d{2})\\n`, 'm'))
  if (!m) return null
  const start = m.index + m[0].length
  const rest = changelog.slice(start)
  const end = rest.search(/^## |^\[[^\]\n]+\]: /m)
  return { date: m[1], body: (end < 0 ? rest : rest.slice(0, end)).trim() }
}

export function check(version, { root = ROOT, changelog = 'CHANGELOG.md' } = {}) {
  const errors = []
  if (!VERSION_RE.test(String(version))) return [`version "${version}": x.y.z expected`]
  const read = f => fs.readFileSync(path.resolve(root, f), 'utf8')
  for (const dir of ['server', 'client']) {
    const pkg = JSON.parse(read(`${dir}/package.json`))
    if (pkg.version !== version) errors.push(`${dir}/package.json: version ${pkg.version}, ${version} expected`)
    const lock = JSON.parse(read(`${dir}/package-lock.json`))
    if (lock.version !== version || lock.packages?.['']?.version !== version) errors.push(`${dir}/package-lock.json: version ${lock.version}/${lock.packages?.['']?.version}, ${version} expected`)
  }
  const images = [...read('docker-compose.yml').matchAll(new RegExp(`${esc(IMAGE)}:([^}\\s"']+)`, 'g'))].map(m => m[1])
  if (!images.length) errors.push(`docker-compose.yml: no ${IMAGE} image`)
  for (const tag of images) if (tag !== version) errors.push(`docker-compose.yml: ${IMAGE}:${tag}, ${version} expected`)
  const clones = [...read('README.md').matchAll(/git clone --branch v(\S+) /g)].map(m => m[1])
  if (!clones.length) errors.push('README.md: no "git clone --branch v<version>"')
  for (const v of clones) if (v !== version) errors.push(`README.md: git clone --branch v${v}, v${version} expected`)
  const log = read(changelog)
  const heads = log.match(/^## .*$/gm) ?? []
  if (heads[0] !== '## [Unreleased]') errors.push(`${changelog}: first entry "## [Unreleased]" expected`)
  const first = heads.find(h => h !== '## [Unreleased]')
  if (!first?.startsWith(`## [${version}] - `)) errors.push(`${changelog}: first version entry "${first ?? 'none'}", "## [${version}] - YYYY-MM-DD" expected`)
  const e = entry(log, version)
  if (!e) errors.push(`${changelog}: no "## [${version}] - YYYY-MM-DD" entry`)
  else if (!e.body) errors.push(`${changelog}: empty ${version} entry`)
  if (!log.includes(`\n[Unreleased]: https://github.com/${REPO}/compare/v${version}...HEAD\n`)) errors.push(`${changelog}: link [Unreleased] to compare/v${version}...HEAD missing`)
  if (!log.includes(`\n[${version}]: https://github.com/${REPO}/releases/tag/v${version}`)) errors.push(`${changelog}: link [${version}] to releases/tag/v${version} missing`)
  return errors
}

// relative links ([text](docs/x.md#a)) → https://github.com/<repo>/blob/v<version>/docs/x.md#a
export function absoluteLinks(text, version) {
  return text.replace(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi, (_, p) => `](https://github.com/${REPO}/blob/v${version}/${p.replace(/^\.\//, '')})`)
}

export function notes(version, { root = ROOT, changelog = 'CHANGELOG.md', digest = null } = {}) {
  if (!VERSION_RE.test(String(version))) throw new Error(`version "${version}": x.y.z expected`)
  if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`digest "${digest}": sha256:<64 hex> expected`)
  const e = entry(fs.readFileSync(path.resolve(root, changelog), 'utf8'), version)
  if (!e?.body) throw new Error(`${changelog}: no ${version} entry`)
  const doc = p => `https://github.com/${REPO}/blob/v${version}/${p}`
  return `${absoluteLinks(e.body, version)}

## Install

**Docker image** (linux/amd64 and linux/arm64): \`${IMAGE}:${version}\`${digest ? `\n\nDigest: \`${digest}\`` : ''}

\`\`\`sh
docker pull ${IMAGE}:${version}
gh attestation verify oci://${IMAGE}:${version} --repo ${REPO}
\`\`\`

With Compose, see [docs/docker.md](${doc('docs/docker.md')}); without Docker, see
[docs/installation.md](${doc('docs/installation.md')}).

**Agents**: \`vigie-agents-${version}.tar.gz\` holds \`agent/\` (dash-report and net-scan, with their
install scripts), see [agent/README.md](${doc('agent/README.md')}). Checksums in \`SHA256SUMS\`
(\`sha256sum -c SHA256SUMS\`); the archive also has a signed build provenance
(\`gh attestation verify vigie-agents-${version}.tar.gz --repo ${REPO}\`).

The ARP companion image (\`docker/net-scan\`, with \`arp-scan\` under the GPL) is not published: it
is built locally by \`docker compose --profile arp up -d\`.
`
}

function main(argv) {
  const [cmd, version, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]
    const v = rest[i + 1]
    if (v === undefined) throw new Error(`${k}: value missing`)
    if (k === '--changelog') opts.changelog = v
    else if (k === '--digest' && cmd === 'notes') opts.digest = v
    else throw new Error(`unknown option ${k}`)
  }
  if (cmd === 'check') {
    const errors = check(version, opts)
    for (const e of errors) console.error(`✗ ${e}`)
    if (errors.length) return 1
    console.log(`✓ version ${version} agrees everywhere`)
    return 0
  }
  if (cmd === 'notes') {
    process.stdout.write(notes(version, opts))
    return 0
  }
  console.error('usage: node scripts/release.mjs check <x.y.z> [--changelog <file>]\n       node scripts/release.mjs notes <x.y.z> [--digest sha256:<hex>] [--changelog <file>]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exitCode = 1
  }
}

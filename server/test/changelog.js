// Changelog of the repository, for the tests: the Gitea one (French, "## Non publié" and
// "## x.y.z (date)" entries) while it is in the tree; the public snapshot has its own, in English
// (Keep a Changelog: "## [Unreleased]", then "## [x.y.z] - date"), written by
// docs/publication/exporter.sh from the template docs/publication/CHANGELOG.public.md. The
// guarantees apply to each text present.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PUBLIC_TEMPLATE = 'docs/publication/CHANGELOG.public.md'
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

export function changelogs() {
  const main = read('CHANGELOG.md')
  // Gitea: "## Non publié" or "## x.y.z (YYYY-MM-DD)"; public: "## [Unreleased]", "## [x.y.z] - YYYY-MM-DD"
  const out = [{ file: 'CHANGELOG.md', text: main, isPublic: !/^## (Non publié|\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\))$/m.test(main) }]
  if (fs.existsSync(path.join(ROOT, PUBLIC_TEMPLATE))) out.push({ file: PUBLIC_TEMPLATE, text: read(PUBLIC_TEMPLATE), isPublic: true })
  return out
}

// section after a level-2 heading, up to the next heading of the same level
export function section(text, heading) {
  const at = text.indexOf(`\n${heading}\n`)
  if (at < 0) return null
  const next = text.indexOf('\n## ', at + heading.length + 2)
  return text.slice(at, next < 0 ? text.length : next)
}

// entry of a released version: "## [x.y.z] - date" (public) or "## x.y.z (date)" (Gitea)
export function versionEntry({ text, isPublic }, version) {
  const v = version.replace(/\./g, '\\.')
  const h = (text.match(new RegExp(isPublic ? `^## \\[${v}\\] - \\d{4}-\\d{2}-\\d{2}$` : `^## ${v} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm')) ?? [])[0]
  return h ? section(text, h) : null
}

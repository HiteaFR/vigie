// Changelog of the repository, for the tests: the Gitea one (French, "## Non publié") while it is in
// the tree; the public snapshot has a new one, in English (a single "## [Unreleased]" entry, no
// version number), written by docs/publication/exporter.sh from the template
// docs/publication/CHANGELOG.public.md. The guarantees apply to each text present.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PUBLIC_TEMPLATE = 'docs/publication/CHANGELOG.public.md'
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

export function changelogs() {
  const main = read('CHANGELOG.md')
  const out = [{ file: 'CHANGELOG.md', text: main, isPublic: !/^## Non publié$/m.test(main) }]
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

export const unreleased = ({ text, isPublic }) => section(text, isPublic ? '## [Unreleased]' : '## Non publié')

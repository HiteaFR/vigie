// CI files of the repository, for the static checks: the public CI (.github/workflows/ci.yml)
// always; the Gitea one (.gitea/workflows/ci.yml) while it is in the tree. The public snapshot has
// no .gitea: there, the same guarantees apply to the GitHub CI alone.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const GITHUB_CI = '.github/workflows/ci.yml'
export const GITEA_CI = '.gitea/workflows/ci.yml'
export const hasGiteaCi = fs.existsSync(path.join(ROOT, GITEA_CI))
export const CI_FILES = [GITHUB_CI, ...(hasGiteaCi ? [GITEA_CI] : [])]
export const readCi = f => fs.readFileSync(path.join(ROOT, f), 'utf8')
// comment lines removed (a command, not an explanation)
export const ciCode = text => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

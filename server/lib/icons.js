// Icons served from ICONS_DIR (lib/paths.js), outside the repository. ONE single definition of what
// an icon file is, shared by the index (slug → URL map), the /icons route, the download script
// (scripts/vendor-icons.mjs) and, through an equality test, deploy/icons-migrate.sh.
import fs from 'node:fs'
import path from 'node:path'

export const ICON_SLUG = /^[a-z0-9-]+$/
export const ICON_EXTS = Object.freeze(['svg', 'png']) // order of preference in the index
export const ICON_FILE = /^([a-z0-9-]+)\.(svg|png)$/
const TYPES = { svg: 'image/svg+xml', png: 'image/png' }

// servable icon file: name matching the pattern, regular file (lstat: a link is never followed)
export function iconFile(dir, name) {
  const m = ICON_FILE.exec(String(name ?? ''))
  if (!m) return null
  const p = path.join(dir, name)
  try {
    return fs.lstatSync(p).isFile() ? { path: p, slug: m[1], ext: m[2] } : null
  } catch {
    return null
  }
}

// slug → public URL (svg preferred over png); missing folder → empty map; unreadable → empty map
// and a warning
export function loadIconUrls(dir, log = console) {
  const urls = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir).sort()
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`icons: ${dir} unreadable (${e.code || e.message}), monograms shown`)
    return urls
  }
  for (const name of names) {
    const f = iconFile(dir, name)
    if (!f) continue
    const cur = urls.get(f.slug)
    if (!cur || ICON_EXTS.indexOf(f.ext) < ICON_EXTS.indexOf(cur.split('.').pop())) urls.set(f.slug, `/icons/${name}`)
  }
  return urls
}

// route GET /icons/:file: only servable icon files, with setHeaders (CSP, cache);
// everything else (other name, sources.json, link, folder, missing) → fallback (404 no-store)
export function iconRoute(dir, { setHeaders, fallback }) {
  return (req, res) => {
    const f = iconFile(dir, req.params.file)
    if (!f) return fallback(req, res)
    setHeaders(res, f.path)
    res.type(TYPES[f.ext])
    res.sendFile(f.path, { cacheControl: false, dotfiles: 'deny' }, err => {
      if (err && !res.headersSent) fallback(req, res)
    })
  }
}

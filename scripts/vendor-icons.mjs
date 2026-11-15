#!/usr/bin/env node
// Downloads into ICONS_DIR the icons referenced by the config (services[].icon and
// bookmarks[].items[].icon), from dashboard-icons then selfh.st (the Homepage catalogs).
// Icons are not in the repository (brand logos, not redistributed); they live in a persistent
// directory outside the deployed tree (lib/paths.js: ICONS_DIR, otherwise <state directory>/icons).
// MANUAL tool, to run after adding a service (see docs/icons.md), never at deployment; the
// server makes no outgoing call for icons and reads the list again only at startup.
//
//   CONFIG_PATH=… ICONS_DIR=… node scripts/vendor-icons.mjs           # missing icons
//   CONFIG_PATH=… ICONS_DIR=… node scripts/vendor-icons.mjs --force   # download everything again
//
// Config: CONFIG_PATH, otherwise <root>/config.json. Safeguards: active SVG refused, 200 KB at
// most, slug [a-z0-9-] only, 10 s per request; 200 icons and 20 MiB at most per run, 120 s in
// total (clean stop, the rest counted as "not handled"), .*.tmp files of an interrupted run
// deleted at startup, an icon already present is kept if its download again (--force) fails.
// Manifest ICONS_DIR/sources.json: source of each file (attribution). One summary line
// "icons: …"; exit 0 even when icons are missing (monogram shown), 1 if the config is
// unreadable or the directory unusable.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { iconsDir } from '../server/lib/paths.js'
import { ICON_SLUG, ICON_FILE } from '../server/lib/icons.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST = 'sources.json'
export const MAX_BYTES = 200 * 1024
export const TIMEOUT_MS = 10_000
// limits of a run (clean stop beyond: the remaining icons are "not handled")
export const MAX_ICONS = 200
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const DEADLINE_MS = 120_000

export const UPSTREAMS = Object.freeze({
  'dashboard-icons': 'https://github.com/homarr-labs/dashboard-icons',
  'selfh.st': 'https://github.com/selfhst/icons',
})
const DI = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons'
const SH = 'https://cdn.jsdelivr.net/gh/selfhst/icons'
export const SOURCES = slug => [
  { url: `${DI}/svg/${slug}.svg`, upstream: 'dashboard-icons' },
  { url: `${SH}/svg/${slug}.svg`, upstream: 'selfh.st' },
  { url: `${DI}/png/${slug}.png`, upstream: 'dashboard-icons' },
  { url: `${SH}/png/${slug}.png`, upstream: 'selfh.st' },
]

// Served from the dashboard origin: an active SVG (script, event handler, javascript: link) is
// refused rather than cleaned.
export const unsafeSvg = s => /<script|\son[a-z]+\s*=|javascript:|<foreignObject/i.test(s)

export const slugsOf = cfg => [...new Set([
  ...(cfg.services || []).map(s => s.icon),
  ...(cfg.bookmarks || []).flatMap(g => (g.items || []).map(i => i.icon)),
].filter(Boolean))].sort()

// atomic write (temporary file, then rename), mode 0644
function writeFile(out, name, buf) {
  const tmp = path.join(out, `.${name}.tmp`)
  fs.writeFileSync(tmp, buf, { mode: 0o644 })
  fs.chmodSync(tmp, 0o644)
  fs.renameSync(tmp, path.join(out, name))
}

function readManifest(out) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8'))
    return m && typeof m.icons === 'object' && m.icons ? m.icons : {}
  } catch {
    return {}
  }
}

// temporary files of an interrupted run (writeFile: .<name>.tmp) → deleted
export function cleanTmp(out) {
  let n = 0
  for (const f of fs.readdirSync(out)) {
    if (/^\..+\.tmp$/.test(f) && fs.lstatSync(path.join(out, f)).isFile()) {
      fs.rmSync(path.join(out, f), { force: true })
      n++
    }
  }
  return n
}

// → { referenced, downloaded, missing: [], kept: [], skipped: [], files }; fetch, clocks and
// limits injectable (tests). kept: present, download again (--force) failed, kept;
// skipped: not handled (icon, volume or deadline limit reached)
export async function vendorIcons({ cfg, out, force = false, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = () => new Date(), log = console, clock = () => Date.now(), maxIcons = MAX_ICONS, maxTotalBytes = MAX_TOTAL_BYTES, deadlineMs = DEADLINE_MS }) {
  fs.mkdirSync(out, { recursive: true, mode: 0o755 })
  const cleaned = cleanTmp(out)
  if (cleaned) log.warn(`! ${cleaned} temporary file(s) of an interrupted run deleted`)
  const slugs = slugsOf(cfg)
  const icons = readManifest(out)
  const start = clock()
  const left = () => deadlineMs - (clock() - start)
  let total = 0
  const get = async url => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, left()))) })
      return r?.ok ? r : null
    } catch {
      return null // network, timeout: next source
    }
  }
  const have = slug => ['svg', 'png'].some(ext => fs.existsSync(path.join(out, `${slug}.${ext}`)))
  const missing = []
  const kept = []
  const skipped = []
  let downloaded = 0
  let handled = 0
  for (const [i, slug] of slugs.entries()) {
    if (!ICON_SLUG.test(slug)) { missing.push(`${slug} (invalid slug)`); continue }
    if (have(slug) && !force) continue
    // limits: clean stop, the rest is not handled
    const why = handled >= maxIcons ? `limit of ${maxIcons} icons` : total >= maxTotalBytes ? `limit of ${Math.round(maxTotalBytes / 1048576)} MiB` : left() <= 0 ? `deadline of ${Math.round(deadlineMs / 1000)} s` : null
    if (why) {
      const rest = slugs.slice(i).filter(s => ICON_SLUG.test(s) && (force || !have(s)))
      skipped.push(...rest)
      log.warn(`! ${why} reached: ${rest.length} icon(s) not handled`)
      break
    }
    handled++
    let saved = null
    for (const src of SOURCES(slug)) {
      const r = await get(src.url)
      if (!r) continue
      const ext = src.url.endsWith('.svg') ? 'svg' : 'png'
      let buf
      try {
        buf = Buffer.from(await r.arrayBuffer())
      } catch {
        continue
      }
      if (buf.length > MAX_BYTES) { log.warn(`! ${slug}: too large (${buf.length} B)`); continue }
      if (total + buf.length > maxTotalBytes) { log.warn(`! ${slug}: volume limit of the run reached`); total = maxTotalBytes; break }
      if (ext === 'svg' && unsafeSvg(buf.toString('utf8'))) { log.warn(`! ${slug}: active SVG refused (${src.url})`); continue }
      writeFile(out, `${slug}.${ext}`, buf)
      icons[`${slug}.${ext}`] = { slug, upstream: src.upstream, url: src.url, at: now().toISOString() }
      saved = src
      total += buf.length
      downloaded++
      break
    }
    // --force offline: a present icon stays in place, counted apart (not "missing")
    if (!saved) { (have(slug) ? kept : missing).push(slug); continue }
    log.log(`✓ ${slug}  ← ${saved.url}`)
    // light variant of monochrome icons (dashboard-icons), shown in the dark theme
    if (saved.url.endsWith('.svg')) {
      const url = `${DI}/svg/${slug}-light.svg`
      const r = await get(url)
      const text = r ? await r.text().catch(() => null) : null
      if (text && Buffer.byteLength(text) <= MAX_BYTES && total + Buffer.byteLength(text) <= maxTotalBytes && !unsafeSvg(text)) {
        total += Buffer.byteLength(text)
        writeFile(out, `${slug}-light.svg`, text)
        icons[`${slug}-light.svg`] = { slug, upstream: 'dashboard-icons', url, at: now().toISOString() }
        log.log(`✓ ${slug}-light`)
      }
    }
  }
  // manifest: one entry per present file; a file without a known source (migrated from an
  // earlier installation) is marked as such; --force downloads it again with its source
  const files = fs.readdirSync(out).filter(f => ICON_FILE.test(f) && fs.lstatSync(path.join(out, f)).isFile()).sort()
  const entries = {}
  for (const f of files) entries[f] = icons[f] ?? { slug: f.replace(/(-light)?\.(svg|png)$/, ''), upstream: null, url: null, note: 'source not recorded (file taken over from an earlier installation)' }
  writeFile(out, MANIFEST, `${JSON.stringify({
    note: 'Icons downloaded by scripts/vendor-icons.mjs, not redistributed with Vigie. Trademarks and logos belong to their respective owners.',
    upstreams: UPSTREAMS,
    icons: entries,
  }, null, 2)}\n`)
  return { referenced: slugs.length, downloaded, missing, kept, skipped, files }
}

export const summary = r => `icons: ${r.referenced} referenced, ${r.downloaded} downloaded, ${r.missing.length} missing${r.missing.length ? ` (${r.missing.join(', ')}: monogram shown)` : ''}`
  + (r.kept?.length ? `, ${r.kept.length} kept (download again failed: ${r.kept.join(', ')})` : '')
  + (r.skipped?.length ? `, ${r.skipped.length} not handled (run limit: ${r.skipped.join(', ')})` : '')

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(ROOT, 'config.json')
  const out = iconsDir(process.env, ROOT)
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const r = await vendorIcons({ cfg, out, force: process.argv.includes('--force') })
    console.log(summary(r))
  } catch (e) {
    console.error(`icons: failed (${e.code || e.message}); config ${configPath}, directory ${out}`)
    process.exit(1)
  }
}

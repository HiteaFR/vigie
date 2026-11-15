// Security headers set on ALL responses (API, static files, SPA, 404), by a middleware placed
// right after hostGuard, without helmet.
// No HSTS (HTTP on the LAN, accepted risk). The Vite development server is not concerned.
import { t as tr } from './i18n.js'

// Hash of the INLINE theme script (client/index.html, applied before the first render):
// base64 sha256 of the exact text between the tags. Checked by a test (security-headers.test.js), which recomputes it from
// client/index.html (and client/dist/index.html if it exists) and gives the new value if the script
// changes: never type it in without that test.
export const THEME_SCRIPT_HASH = 'sha256-h+EprICgdh9kn7lKOBFu3fsjSejb7eZ/jKsCYWaJpIo='

// CSP of the vendored icons (/icons/*.svg): an SVG opened directly cannot execute anything;
// it replaces the general CSP for these files
export const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const frameAncestorsOf = cfg => cfg?.frameAncestors ?? []

export function cspFor(cfg) {
  const fa = frameAncestorsOf(cfg)
  return [
    "default-src 'self'",
    `script-src 'self' '${THEME_SCRIPT_HASH}'`,
    // 'unsafe-inline' for styles only: the <style> elements created at runtime by react-remove-scroll
    // (Ctrl K palette, via cmdk); React style={…} and d3 .style() go through the CSSOM
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${fa.length ? fa.join(' ') : "'none'"}`,
  ].join('; ')
}

export function securityHeaders(cfg) {
  const csp = cspFor(cfg)
  const deny = frameAncestorsOf(cfg).length === 0
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // not no-referrer: the browser would send Origin: null on a same-origin POST, and
    // sameOrigin would refuse every login and every write
    res.setHeader('Referrer-Policy', 'same-origin')
    if (deny) res.setHeader('X-Frame-Options', 'DENY') // older browsers
    next()
  }
}

// headers of the client/dist files (express.static, setHeaders): cache, and strict CSP for SVGs
export function staticHeaders(res, p) {
  if (p.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache')
  } else if (/[\\/]icons[\\/]/.test(p)) {
    // non-hashed names: one day, so that a replaced icon eventually shows up
    res.setHeader('Cache-Control', 'public, max-age=86400')
  } else if (/\.(js|css|woff2?|png|svg|ico)$/.test(p)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }
  if (p.endsWith('.svg')) res.setHeader('Content-Security-Policy', ICON_CSP)
}

// headers of the icons served from ICONS_DIR (/icons route): non-hashed names, one day of
// cache; strict CSP for SVGs, whatever the folder path
export function iconHeaders(res, p) {
  res.setHeader('Cache-Control', 'public, max-age=86400')
  if (p.endsWith('.svg')) res.setHeader('Content-Security-Policy', ICON_CSP)
}

// missing file under /assets/ (chunk of an old build, deleted on deployment) → plain-text 404,
// Cache-Control: no-store (never the immutable of real assets, which would keep the 404 cached),
// never index.html (which the browser would take for a JavaScript module)
export function missingAsset(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(404).type('text/plain').send(tr('api.file_not_found'))
}

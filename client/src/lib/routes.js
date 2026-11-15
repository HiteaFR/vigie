// Client routes are in English. The old French names stay served PERMANENTLY (old links in
// the Telegram history, bookmarks): same view, then the URL is replaced by the English name
// (history.replaceState, no history entry), query string and fragment kept.
// The server serves index.html for every path (SPA fallback): nothing to declare there.
export const LEGACY_ROUTES = Object.freeze({
  '/alertes': '/alerts',
  '/reseau': '/network',
  '/sauvegardes': '/backups',
  '/maj': '/updates',
  '/mural': '/wall',
})

// English URL of an old path, with its query (without "?") and its fragment (with "#"); null
// if the path is not an old name
export function canonicalUrl(pathname, search = '', hash = '') {
  const to = Object.hasOwn(LEGACY_ROUTES, pathname) ? LEGACY_ROUTES[pathname] : null
  if (!to) return null
  return `${to}${search ? `?${search.replace(/^\?/, '')}` : ''}${hash && hash !== '#' ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`
}

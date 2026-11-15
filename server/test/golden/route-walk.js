// Walk of the route table of an Express 4 application, nested routers included
// (express.Router mounted by app.use(prefix, router), the natural shape of a plugin): method and
// full path, in registration order. Used by routes-preload.mjs (real server) and
// tested alone (golden.test.js) with a control mounted router.

// prefix of a mounted layer (app.use) from its regular expression (Express 4 does not keep
// the original path): "/^\/api\/p\/demo\/?(?=\/|$)/i" → "/api/p/demo"; mounted on "/": ""
export function mountPath(layer) {
  if (layer.regexp?.fast_slash) return ''
  const src = layer.regexp?.source ?? ''
  const m = src.match(/^\^((?:\\\/[^\\/?()[\]*+]+)*)\\\/\?\(\?=\\\/\|\$\)$/)
  if (!m) return `‹préfixe illisible : ${src}›`
  return m[1].replace(/\\\//g, '/')
}

// → [{ method, path }]; app.all() (every method) gives a single "ALL" line
export function collectRoutes(router, prefix = '') {
  const out = []
  for (const l of router?.stack ?? []) {
    if (l.route) {
      const methods = Object.keys(l.route.methods)
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path]
      for (const p of paths) {
        for (const m of methods.includes('_all') || methods.length > 10 ? ['ALL'] : methods) out.push({ method: m.toUpperCase(), path: prefix + p })
      }
    } else if (l.handle?.stack && (l.name === 'router' || typeof l.handle.handle === 'function')) {
      out.push(...collectRoutes(l.handle, prefix + mountPath(l)))
    }
  }
  return out
}

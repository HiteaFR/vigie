// Routes of the network module. Reads guarded like the rest of the API (session, unless
// anonymous read; guard in index.js); in-memory snapshot and SQLite, no outgoing call. Writes:
// behind `admin` (session, CIDR, Origin, JSON ≤ 8 KB), logged by lib/network/writes.js,
// refusals included.
// isAdmin(req): valid admin session (reasons and authors shown only in that case)
// wrap: a route that returns a promise passes its rejection to the final handler
import { t as tr } from '../i18n.js'
export function mountNetwork(app, { network, servicesOf = () => [], admin = null, fail = null, isAdmin = () => false, wrap = fn => fn }) {
  app.get('/api/network', wrap((req, res) => {
    res.json(network.view({ admin: isAdmin(req) }))
  }))
  // online devices per hour (History tab): days = 7, 30 or 90
  app.get('/api/network/history', wrap((req, res) => {
    const days = Number(req.query.days ?? 7)
    if (![7, 30, 90].includes(days)) return res.status(400).json({ error: tr('api.net.bad_days') })
    res.json(network.history(days) ?? { enabled: false, days, points: [] })
  }))
  // map: without session, without reason or author; Mermaid export as an attachment
  app.get('/api/network/topology', wrap((req, res) => {
    res.json(network.topology({ servicesOf }) ?? { enabled: false, nodes: [], edges: [], groups: [], warnings: [] })
  }))
  app.get('/api/network/topology.mmd', wrap((req, res) => {
    const text = network.topologyMermaid({ servicesOf })
    if (text == null) return res.status(404).json({ error: tr('api.net.off') })
    res.set('Content-Type', 'text/plain; charset=utf-8')
    res.set('Content-Disposition', 'attachment; filename="reseau.mmd"')
    res.send(text)
  }))
  app.get('/api/network/devices/:id', wrap((req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: tr('api.net.bad_id') })
    const d = network.device(id, { servicesOf, admin: isAdmin(req) })
    if (!d) return res.status(404).json({ error: network.enabled ? tr('api.net.unknown_device') : tr('api.net.off') })
    res.json(d)
  }))

  if (!admin || !network.writes) return
  const W = network.writes
  // a write route: JSON body → write → result; errors { status } through fail()
  const post = (path, fn) => app.post(path, admin, wrap((req, res) => {
    try {
      res.json(fn(req.body ?? {}, { by: req.actor, source: 'ui' }))
    } catch (e) {
      // refusal of a batch (Delete): the answer lists the ids involved
      if (e.status && Array.isArray(e.ids)) return res.status(e.status).json({ error: e.message, ids: e.ids })
      fail(res, e)
    }
  }))
  post('/api/network/devices/edit', (b, who) => W.edit(b, who))
  post('/api/network/devices/ack', (b, who) => W.ack(b, who))
  // no ignore, archive or restore (404); Delete and map links
  post('/api/network/devices/delete', (b, who) => W.delete(b, who))
  post('/api/network/links', (b, who) => W.link(b, who))
  post('/api/network/links/remove', (b, who) => W.unlink(b, who))
  post('/api/network/devices/merge', (b, who) => W.merge(b, who))
  post('/api/network/macs/confirm', (b, who) => W.confirmMac(b, who))
  post('/api/network/macs/detach', (b, who) => W.detachMac(b, who))
  post('/api/network/mac-rules', (b, who) => W.addRule(b, who))
  post('/api/network/mac-rules/remove', (b, who) => W.removeRule(b, who))
  post('/api/network/suggestions/dismiss', (b, who) => W.dismiss(b, who))
  // on-demand probe → 202, pass in the background; 429 with Retry-After
  app.post('/api/network/devices/probe', admin, wrap((req, res) => {
    try {
      res.status(202).json(W.probe(req.body ?? {}, { by: req.actor, source: 'ui' }))
    } catch (e) {
      if (e.status === 429 && e.retryAfter) res.set('Retry-After', String(e.retryAfter))
      fail(res, e)
    }
  }))
  // "Probe all": full pass by hand → 202; 409 if already running, 429 less than an hour after
  app.post('/api/network/probe/all', admin, wrap((req, res) => {
    try {
      res.status(202).json(W.probeAll(req.body ?? {}, { by: req.actor, source: 'ui' }))
    } catch (e) {
      if (e.status === 429 && e.retryAfter) res.set('Retry-After', String(e.retryAfter))
      fail(res, e)
    }
  }))
}

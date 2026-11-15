// The Gluetun forwarded port is shown as plain text ("41634"), without a
// thousands separator ("41 634" with int). Real widget engine against a FAKE local HTTP server
// (127.0.0.1, fake key).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createWidgets } from '../lib/widgets.js'

const NO_PIHOLE = { piholes: { get() {}, stop: async () => {} } }

test('Gluetun port: JSON number in text format → "41634" as is; int (before) → thousands separator; missing port → "—"', async t => {
  const bodies = { '/v1/portforward': { port: 41634 }, '/v1/empty': {} }
  const srv = http.createServer((req, res) => res.end(JSON.stringify(bodies[req.url] ?? {})))
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  const url = `http://127.0.0.1:${srv.address().port}`
  const cfg = { services: [{ id: 'gluetun', widget: { url, auth: { type: 'header', name: 'X-API-Key', secretEnv: 'GLUETUN_KEY' }, fields: [
    { label: 'Port', path: '/v1/portforward', json: 'port', format: 'text' },
    { label: 'Port int', path: '/v1/portforward', json: 'port', format: 'int' },
    { label: 'Absent', path: '/v1/empty', json: 'port', format: 'text' },
  ] } }] }
  const w = createWidgets(cfg, { GLUETUN_KEY: 'cle-factice' }, NO_PIHOLE)
  await w.runAll()
  const r = w.get('gluetun')
  assert.equal(r.error, null)
  assert.deepEqual(r.fields.map(f => [f.label, f.value]), [['Port', '41634'], ['Port int', '41 634'], ['Absent', '—']])
})

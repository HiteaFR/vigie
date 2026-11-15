// "Merge with…" never sends a record the user does not see (docs/network.md).
// mergeChoice imported directly (always run); real rendering of
// MergePicker through esbuild and react-dom/server, like alert-bell (skipped only without client).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeChoice } from '../../client/src/lib/mergeChoice.js'
import { createAudit } from '../lib/auth.js'
import { createNetworkWrites, validateMerge } from '../lib/network/writes.js'
import { prodConfig, prodLikeStore } from './network-fixture.js'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, 'client/src', f), 'utf8')
const dev = (id, name, ip, mac) => ({ id, name, ip, mac })
const PHONE = dev(52, 'Phone-de-alex', '192.0.2.52', '5a:00:00:00:d0:52')
const NICO = dev(45, 'Téléphone Nico', '192.0.2.45', '02:00:00:00:00:45')
const TV = dev(30, 'Télé <salon>', '192.0.2.30', '02:00:00:00:00:30')

test('mergeChoice: shown choice → it; not shown and several results → null; a single result → it; none → null', () => {
  assert.equal(mergeChoice([PHONE, TV], 52), PHONE)
  assert.equal(mergeChoice([PHONE, TV], '52'), PHONE) // value of a <select>
  assert.equal(mergeChoice([PHONE, TV], 99), null) // the chosen record has disappeared from the shown list
  assert.equal(mergeChoice([PHONE, TV], null), null)
  assert.equal(mergeChoice([PHONE, TV], ''), null)
  assert.equal(mergeChoice([TV], 52), TV) // a single result: it, whatever the previous choice
  assert.equal(mergeChoice([TV], null), TV)
  assert.equal(mergeChoice([], 52), null)
  assert.equal(mergeChoice([PHONE, TV], 0), null)
})

// --- real rendering -----------------------------------------------------------------------
const client = t => clientBundle(t, 'merge-picker', [
  "import { MergePicker } from './src/DeviceDrawer.jsx'",
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement } from 'react'",
  "import { Router } from 'wouter'",
  'export const picker = p => renderToStaticMarkup(createElement(Router, { ssrPath: "/" }, createElement(MergePicker, { onChoose() {}, ...p })))',
])
const selectedOptions = html => [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].filter(m => /\bselected=""/.test(m[1])).map(m => ({ attrs: m[1], text: m[2] }))

test('real rendering of MergePicker', async t => {
  const c = await client(t)
  if (!c) return
  await t.test('no selection: hidden and disabled empty option selected, no other, "no device chosen" notice', () => {
    const html = c.picker({ shown: [PHONE, TV], chosenId: null, into: NICO })
    assert.match(html, /<option value="" hidden="" disabled="" selected="">/)
    const sel = selectedOptions(html)
    assert.equal(sel.length, 1)
    assert.match(sel[0].attrs, /value=""/)
    assert.match(html, /Aucune fiche choisie/)
    assert.doesNotMatch(html, /Fiche absorbée/)
    // choice became invisible (search) with several results: same empty state
    const hidden = c.picker({ shown: [PHONE, TV], chosenId: 99, into: NICO })
    assert.equal(selectedOptions(hidden).length, 1)
    assert.match(hidden, /Aucune fiche choisie/)
  })
  await t.test('device 52 chosen and shown: option 52 selected, both devices restated in clear (escaped)', () => {
    const html = c.picker({ shown: [PHONE, TV], chosenId: 52, into: NICO })
    const sel = selectedOptions(html)
    assert.equal(sel.length, 1)
    assert.match(sel[0].attrs, /value="52"/)
    assert.match(html, /Fiche absorbée : <strong>#52 Phone-de-alex · 192\.0\.2\.52 · 5a:00:00:00:d0:52<\/strong>/)
    assert.match(html, /sera absorbée par <strong>#45 Téléphone Nico · 192\.0\.2\.45 · 02:00:00:00:00:45<\/strong>/)
    // a hostile name is escaped in the options and the reminder
    const tv = c.picker({ shown: [TV], chosenId: null, into: NICO })
    assert.match(tv, /#30 Télé &lt;salon&gt;/)
    assert.doesNotMatch(tv, /<salon>/)
    // beyond 100: "100 premiers sur N" (first 100 of N)
    assert.match(c.picker({ shown: [PHONE, TV], chosenId: null, total: 340 }), /2 premiers sur 340 : affiner la recherche/)
  })
})

test('static: the merge body uses the effective id (mergeChoice), no longer Number(mergeWith); canSubmit; reset', () => {
  const src = SRC('DeviceDrawer.jsx')
  assert.match(src, /^import \{ mergeChoice \} from '\.\/lib\/mergeChoice\.js'$/m)
  assert.match(src, /const choice = mergeChoice\(shown, mergeWith\)/)
  assert.match(src, /body=\{\(\) => \(\{ into: d\.id, from: \[choice\.id\] \}\)\}/)
  assert.match(src, /canSubmit=\{!!choice\}/)
  assert.doesNotMatch(src, /Number\(mergeWith\)/)
  assert.match(src, /<MergePicker shown=\{shown\} chosenId=\{mergeWith\} onChoose=\{setMergeWith\} into=\{d\} total=\{others\.length\} \/>/)
  assert.match(src, /<option value="" hidden disabled>/)
  const close = src.slice(src.indexOf('const close = () => {'), src.indexOf('}', src.indexOf('const close = () => {')))
  assert.match(close, /setMergeWith\(null\)/)
  assert.match(close, /setQ\(''\)/)
  assert.match(SRC('DeviceForm.jsx'), /canSubmit=\{canSubmit\}/)
  assert.match(SRC('admin.jsx'), /disabled=\{busy \|\| !ok \|\| !canSubmit\}/)
})

test('server (validateMerge): 0, "x", unknown, itself → refused; duplicates removed; no write on a refusal', () => {
  const cfg = prodConfig()
  const T = Date.parse('2026-10-21T10:00:00Z')
  const { store, ns } = prodLikeStore({ T })
  const W = createNetworkWrites({ ns, kv: store.kv, cfg, audit: createAudit(store), now: () => T })
  const st = ns.load()
  const ids = [...st.devices.values()].filter(d => !d.host_id).map(d => d.id).slice(0, 2)
  const [into, from] = ids
  const who = { by: 'admin (192.0.2.5)', source: 'ui' }
  const snapshot = () => JSON.stringify([[...ns.load().devices.keys()], [...ns.load().macs.values()].map(m => [m.mac, m.device_id])])
  const before = snapshot()
  const refuse = (body, status, re) => assert.throws(() => W.merge({ ...body, reason: 'test test' }, who), e => e.status === status && re.test(e.message), JSON.stringify(body))
  refuse({ into, from: [0] }, 400, /id invalide/)
  refuse({ into, from: ['x'] }, 400, /id invalide/)
  refuse({ into, from: [999999] }, 404, /appareil inconnu/)
  refuse({ into, from: [into] }, 400, /une fiche ne fusionne pas avec elle-même/)
  assert.equal(snapshot(), before, 'no write on a refusal')
  assert.deepEqual(validateMerge(into, [from, from], st), { into, from: [from] })
})

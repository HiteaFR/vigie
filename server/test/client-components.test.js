// Real rendering of sensitive client components, with DUMMY data in the
// react-query cache (no request): the client's esbuild and react-dom/server (client-render.js),
// no new dependency. Each test checks a text or an accessibility attribute that matters, never a
// snapshot of the whole HTML. AlertBell (badge, list): alert-bell.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientBundle } from './client-render.js'

const NOW = Date.parse('2026-10-29T10:00:00Z')
const client = t => clientBundle(t, 'components', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import DeviceForm from './src/DeviceForm.jsx'",
  "import DeviceDrawer from './src/DeviceDrawer.jsx'",
  "import Updates from './src/views/Updates.jsx'",
  "import ViewBoundary from './src/ui/ViewBoundary.jsx'",
  // prefilled cache (useSource key or useJson URL); rendered inside the router, outside the browser
  'export function render(el, { seed = {}, path = "/", search = "" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: path, ssrSearch: search }, h(AdminProvider, null, el))))',
  '}',
  'export const deviceForm = (p, o) => render(h(DeviceForm, p), o)',
  'export const drawer = o => render(h(DeviceDrawer), o)',
  'export const updates = o => render(h(Updates), o)',
  'export { ViewBoundary, renderToStaticMarkup, h }',
])

const ADMIN = { admin: true, configured: true, networkAllowed: true }
const iso = ms => new Date(NOW - ms).toISOString()
// device record in the /api/network/devices/:id format (fields read by the drawer)
const device = (over = {}) => ({
  id: 7, name: 'Salon-TV', mac: '00:00:5e:00:53:07', ip: '192.0.2.70', type: 'tv', vendor: 'Exemple', state: 'known', review: 0,
  freshness: 'active', online: null, lastSeen: iso(60_000), firstSeen: iso(86400_000), hostId: null, hostSrc: null, saisie: {},
  macs: [{ mac: '00:00:5e:00:53:07', grade: 'weak', attach: null, identity: false, pending: false, lastIp: '192.0.2.70' }],
  attrs: [], events: [], addresses: [], rules: [], services: [], sessions: [], seen: [],
  deletion: { allowed: true, why: null },
  ...over,
})
const seedDrawer = (d, session = ADMIN) => ({ session, network: { presence: 'passive', devices: [d], types: ['tv', 'nas'] }, [`/api/network/devices/${d.id}`]: d })

test('DeviceForm: title, bounded fields, host help (aria-describedby), already linked host greyed out with its record, unlinking, severity depending on the alert', async t => {
  const c = await client(t)
  if (!c) return
  const seed = {
    session: ADMIN,
    services: { hosts: [{ id: 'web', name: 'web' }, { id: 'nas', name: 'NAS' }] },
    network: { devices: [{ id: 9, hostId: 'nas', name: 'Autre fiche', mac: '00:00:5e:00:53:09' }] },
  }
  const html = c.deviceForm({ open: true, onClose() {}, device: device({ hostId: 'web', hostSrc: 'pve' }), types: ['tv', 'nas'] }, { seed })
  assert.match(html, /<dialog[^>]*aria-label="Modifier « Salon-TV »"/)
  for (const [label, max] of [['Nom', 64], ['Emplacement', 64], ['IP attendue', 15]]) {
    assert.match(html, new RegExp(`${label}[^<]*(<[^>]*>[^<]*)*?<input[^>]*maxLength="${max}"`), label)
  }
  assert.match(html, /<textarea[^>]*maxLength="500"/)
  assert.match(html, /<select[^>]*aria-describedby="host-identity-help"/)
  assert.match(html, /<span id="host-identity-help"[^>]*>À choisir seulement si cette fiche <b>est<\/b> la machine elle-même/)
  // discovered host shown, unlinking offered, host of another record greyed out (prevents the 409)
  assert.match(html, /<option value=""[^>]*>— découvert : web —<\/option>/)
  assert.match(html, /<option value="\u0000unlink">Aucun : dissocier de web<\/option>/)
  assert.match(html, /<option value="nas" disabled="">NAS \(nas\) — déjà : fiche 9 \(Autre fiche\)<\/option>/)
  assert.match(html, /<option value="web">web \(web\)<\/option>/)
  assert.match(html, /— deviné : TV —/)
  // severity only if the offline alert is checked; the reason only appears when unchecking
  assert.doesNotMatch(html, /Sévérité/)
  const on = c.deviceForm({ open: true, onClose() {}, device: device({ saisie: { alertDown: true, alertSeverity: 'critical' } }) }, { seed })
  assert.match(on, /<input type="checkbox" checked=""/)
  assert.match(on, /Sévérité<select[^>]*>[\s\S]*<option value="critical" selected="">critique<\/option>/)
  assert.doesNotMatch(on, /Motif \(obligatoire/)
  // without a record: nothing more than the provider (its login modal, closed)
  assert.equal(c.deviceForm({ open: true, onClose() {}, device: null }, { seed }), c.render(null, { seed }))
})

test('DeviceDrawer: deletion blocked → no button, server reason shown; allowed → button; without session → no action', async t => {
  const c = await client(t)
  if (!c) return
  const blocked = device({ id: 8, hostId: 'web', hostSrc: 'pve', deletion: { allowed: false, why: 'MAC d\'identité de l\'hôte « web » (Proxmox)' } })
  const html = c.drawer({ seed: seedDrawer(blocked), search: 'd=8' })
  assert.match(html, /<section[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Détail de l&#x27;appareil Salon-TV"/)
  assert.match(html, /role="toolbar" aria-label="Actions sur l&#x27;appareil"/)
  assert.match(html, /Suppression impossible : MAC d&#x27;identité de l&#x27;hôte « web » \(Proxmox\)/)
  assert.doesNotMatch(html, />Supprimer…<\/button>/)
  const free = c.drawer({ seed: seedDrawer(device({ id: 9 })), search: 'd=9' })
  assert.match(free, />Supprimer…<\/button>/)
  assert.doesNotMatch(free, /Suppression impossible/)
  const anon = c.drawer({ seed: seedDrawer(device({ id: 10 }), { admin: false, configured: true, networkAllowed: true }), search: 'd=10' })
  assert.doesNotMatch(anon, /Actions sur l&#x27;appareil|Supprimer…/)
  assert.equal(c.drawer({ seed: seedDrawer(device()), search: '' }), c.render(null, { seed: seedDrawer(device()) }))
})

test('Updates view: gap badges (security, end of life, major, patch) and border, up-to-date components hidden by default, aria-pressed filters with counters', async t => {
  const c = await client(t)
  if (!c) return
  const comp = (id, over) => ({ id, name: `Composant ${id}`, kind: 'app', env: 'prod', where: 'web', current: '1.0.0', latest: '1.0.0', gap: 'same', ...over })
  const seed = {
    session: { admin: false },
    agents: { hosts: [] },
    updates: {
      checkedAt: iso(60_000), sources: [], stats: { requests: 3, notModified: 1, githubAuth: false },
      components: [
        comp('sec', { latest: '1.0.1', gap: 'patch', security: true }),
        comp('maj', { latest: '2.0.0', gap: 'major' }),
        comp('pat', { latest: '1.0.2', gap: 'patch' }),
        comp('fdv', { eol: { date: '2026-04-30', passed: true } }),
        comp('ok', {}),
      ],
    },
  }
  const html = c.updates({ seed })
  // one row = one <li> of the list
  const row = id => html.split('<li ').find(x => x.includes(`title="Composant ${id}"`)) ?? ''
  assert.match(row('sec'), /border-l-crit/)
  assert.match(row('sec'), /<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>sécurité<\/span>/)
  assert.match(row('maj'), /border-l-warn/)
  assert.match(row('maj'), /<span aria-hidden="true">▲<\/span>majeure<\/span>/)
  assert.match(row('pat'), /<span aria-hidden="true">●<\/span>patch<\/span>/)
  assert.match(row('fdv'), /border-l-crit/)
  assert.match(row('fdv'), /<\/svg>fin de vie<\/span>/)
  assert.match(row('fdv'), /fin de vie depuis le/)
  assert.match(html, /aria-label="Détail de Composant sec"/)
  assert.doesNotMatch(html, /Composant ok/, 'up to date: hidden without a filter')
  assert.match(html, /role="group" aria-label="Filtrer par écart"/)
  assert.match(html, /aria-pressed="false"[^>]*>Sécurité \/ EOL<span[^>]*>2<\/span>/)
  assert.match(html, /aria-pressed="false"[^>]*>Majeures<span[^>]*>1<\/span>/)
  assert.match(html, /5 composants suivis/)
  // "patch" filter active: pressed, the major one disappears
  const patch = c.updates({ seed, search: 'f=patch' })
  assert.match(patch, /aria-pressed="true"[^>]*>Patchs<span[^>]*>/)
  assert.doesNotMatch(patch, /title="Composant maj"/)
  // all up to date: explicit empty state
  const none = c.updates({ seed: { ...seed, updates: { ...seed.updates, components: [comp('ok', {})] } } })
  assert.match(none, /Tout est à jour/)
})

test('view error box: after a real error, chunk → new version notice (role alert); other error → neutral label and escaped message', async t => {
  const c = await client(t)
  if (!c) return
  const saved = { window: globalThis.window }
  t.after(() => { globalThis.window = saved.window })
  const store = new Map()
  let reloads = 0
  globalThis.window = { location: { reload: () => { reloads++ } }, sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } }
  const run = err => {
    const b = new c.ViewBoundary({ resetKey: '/ci', children: 'vue' })
    b.setState = s => { b.state = { ...b.state, ...(typeof s === 'function' ? s(b.state) : s) } }
    b.state = { ...b.state, ...c.ViewBoundary.getDerivedStateFromError(err) }
    b.componentDidCatch(err)
    const el = b.render()
    return el ? c.renderToStaticMarkup(el) : ''
  }
  const chunk = new TypeError('Failed to fetch dynamically imported module: http://dash.test/assets/Ci-ancien.js')
  assert.equal(run(chunk), '', 'first chunk failure: reload, nothing shown')
  assert.equal(reloads, 1)
  const again = run(chunk)
  assert.equal(reloads, 1, 'same build: no second reload')
  assert.match(again, /^<div role="alert"/)
  assert.match(again, /Nouvelle version du dashboard disponible/)
  assert.match(again, /<button type="button"[^>]*>.*Recharger<\/button>/)
  const other = run(new Error('boum <img src=x>'))
  assert.match(other, /Cette vue a rencontré une erreur/)
  assert.match(other, /boum &lt;img src=x&gt;/)
  assert.doesNotMatch(other, /Nouvelle version/)
  assert.equal(reloads, 1)
})

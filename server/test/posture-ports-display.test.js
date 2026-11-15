// Display of the posture and the ports (host drawer, Network entry), real
// rendering of the client. Fake data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFast } from '../lib/agents.js'
import { clientBundle } from './client-render.js'

const client = t => clientBundle(t, 'l12-display', [
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import HostDrawer from './src/HostDrawer.jsx'",
  "import DeviceDrawer from './src/DeviceDrawer.jsx'",
  "import { PostureList, PortsList } from './src/components/AgentSecurity.jsx'",
  'export function render(el, { seed = {}, search = "" } = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })',
  '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
  '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/", ssrSearch: search }, h(AdminProvider, null, el))))',
  '}',
  'export const drawer = seed => render(h(HostDrawer), { seed, search: "h=p1" })',
  'export const device = (seed, id) => render(h(DeviceDrawer), { seed, search: `d=${id}` })',
  'export const posture = (p, seed) => render(h(PostureList, p), { seed })',
  'export const ports = (p, seed) => render(h(PortsList, p), { seed })',
])
const ADMIN = { admin: true, configured: true, networkAllowed: true }
const HOST = { id: 'p1', name: 'pihole' }
const P = {
  ssh_root: { state: 'ok', seenOk: 1, regression: false, accepted: null },
  ssh_password: { state: 'gap', seenOk: Date.parse('2026-11-03T08:00:00Z'), regression: true, accepted: null },
  firewall: { state: 'accepted', seenOk: null, regression: false, accepted: { at: Date.parse('2026-11-04T10:00:00Z'), by: 'admin', reason: 'pare-feu de Proxmox' } },
}
const row = (html, label) => html.split('<li ').find(x => x.includes(`>${label}</span>`)) ?? ''

test('posture: compliant, deviation (badge, regression), accepted (neutral, reason on hover), unknown; admin actions', async t => {
  const c = await client(t)
  if (!c) return
  const html = c.posture({ host: HOST, v8: { known: true, posture: P }, actions: true }, { session: ADMIN })
  assert.match(row(html, 'Connexion root'), /<span class="text-ok" title="standard : PermitRootLogin no, prohibit-password ou forced-commands-only">conforme<\/span>/)
  assert.match(row(html, 'Mot de passe SSH'), /bg-warn-bg[^"]*text-warn" title="standard : PasswordAuthentication no">écart<\/span><span class="text-2xs text-warn">régression \(conforme jusqu&#x27;au 03\/11\/2026\)<\/span><button[^>]*>Accepter l&#x27;écart…<\/button>/)
  assert.match(row(html, 'Pare-feu'), /text-subtle" title="accepté par admin le 04\/11\/2026 : pare-feu de Proxmox">accepté<\/span><button[^>]*>Retirer l&#x27;acceptation…<\/button>/)
  assert.doesNotMatch(row(html, 'Pare-feu'), /bg-warn-bg/)
  // without actions (read-only entry): no button
  assert.doesNotMatch(c.posture({ host: HOST, v8: { known: true, posture: P } }, { session: ADMIN }), /<button/)
  // unknown: agent v7, or posture not reported
  assert.match(c.posture({ host: HOST, v8: { known: false } }), /Posture SSH et pare-feu : inconnue \(agent antérieur à la v8\)\./)
  assert.match(c.posture({ host: HOST, v8: { known: true, restricted: false, posture: null } }), /non remontée/)
  assert.match(c.posture({ host: HOST, v8: { known: true, restricted: true, posture: null } }), /Posture SSH et pare-feu : réservée à l&#x27;admin \(connexion requise\)\./)
  assert.match(c.posture({ host: HOST, v8: { known: true, posture: { ...P, ssh_root: { state: 'unknown' } } } }), />Connexion root<\/span><span class="text-subtle"[^>]*>inconnu<\/span>/)
})

test('ports: local, known, new (badge and "Known…" button); without session: reserved to the admin; v7: unknown', async t => {
  const c = await client(t)
  if (!c) return
  const ports = [
    { proto: 'tcp', port: 22, addrs: ['0.0.0.0', '[::]'], processes: ['sshd'], status: 'known', known: { at: 1, by: 'amorçage', reason: null, bootstrap: true } },
    { proto: 'tcp', port: 5432, addrs: ['127.0.0.1'], processes: ['postgres'], status: 'local', known: null },
    { proto: 'tcp', port: 8443, addrs: ['0.0.0.0'], processes: [], status: 'new', known: null },
  ]
  const html = c.ports({ host: HOST, v8: { known: true, ports }, actions: true }, { session: ADMIN })
  const li = p => html.split('<li ').find(x => x.includes(`>tcp/${p}</span>`)) ?? ''
  assert.match(li(22), /sshd · 0\.0\.0\.0, \[::\]<\/span><span class="font-sans text-muted">connu<\/span>/)
  assert.doesNotMatch(li(22), /<button/)
  assert.match(li(5432), /font-sans text-subtle">local<\/span>/)
  assert.match(li(8443), /— · 0\.0\.0\.0<\/span><span class="font-sans [^"]*text-warn">nouveau<\/span><button[^>]*>Connu…<\/button>/)
  assert.match(c.ports({ host: HOST, v8: { known: true, restricted: true, ports: null } }), /Ports en écoute : réservés à l&#x27;admin \(connexion requise\)\./)
  assert.match(c.ports({ host: HOST, v8: { known: true, restricted: false, ports: null } }), /non remontés par l&#x27;agent/)
  assert.match(c.ports({ host: HOST, v8: { known: false } }), /Ports en écoute : inconnus \(agent antérieur à la v8\)\./)
  assert.match(c.ports({ host: HOST, v8: { known: true, ports: [] } }), /Aucun port en écoute remonté\./)
})

test('host drawer: Posture and Ports sections present; agent v7: "unknown" for both', async t => {
  const c = await client(t)
  if (!c) return
  const fast = cleanFast({ version: 7, ts: Math.floor(Date.now() / 1000), uptime: 3600, load: [0, 0, 0], mem: { total: 2e9, avail: 1e9 }, fs: [], systemd: { failed: [], watched: [] }, reboot: { required: false } })
  const host = v8 => ({ agents: { hosts: [{ id: 'p1', name: 'pihole', kind: 'lxc', agent: 'ssh', ok: true, at: Date.now(), fast, slow: null, v8 }] } })
  const d7 = c.drawer(host({ known: false, posture: null, ports: null }))
  assert.match(d7, /Posture SSH et pare-feu<\/h3>[\s\S]*inconnue \(agent antérieur à la v8\)/)
  assert.match(d7, /Ports en écoute<\/h3>[\s\S]*inconnus \(agent antérieur à la v8\)/)
  const d8 = c.drawer(host({ known: true, posture: P, ports: null }))
  assert.match(d8, />Mot de passe SSH<\/span>[\s\S]*?>écart<\/span>/)
})

test('Network entry of the linked device: listening ports of the host, read-only; device without host: nothing', async t => {
  const c = await client(t)
  if (!c) return
  const iso = ms => new Date(Date.now() - ms).toISOString()
  const dev = (over = {}) => ({
    id: 7, name: 'pihole', mac: '00:00:5e:00:53:07', ip: '192.0.2.158', type: 'server', vendor: 'Exemple', state: 'known', review: 0,
    freshness: 'active', online: null, lastSeen: iso(60_000), firstSeen: iso(86400_000), hostId: 'p1', hostSrc: 'pve', saisie: {},
    macs: [{ mac: '00:00:5e:00:53:07', grade: 'weak', attach: null, identity: true, pending: false, lastIp: '192.0.2.158' }],
    attrs: [], events: [], addresses: [], rules: [], services: [], sessions: [], seen: [], deletion: { allowed: false, why: 'hôte' }, ...over,
  })
  const ports = [{ proto: 'tcp', port: 8443, addrs: ['0.0.0.0'], processes: ['caddy'], status: 'new', known: null }]
  const seed = d => ({ session: ADMIN, network: { presence: 'passive', devices: [d], types: ['server'] }, [`/api/network/devices/${d.id}`]: d,
    agents: { hosts: [{ id: 'p1', name: 'pihole', agent: 'ssh', v8: { known: true, posture: null, ports } }] } })
  const html = c.device(seed(dev()), 7)
  assert.match(html, /Ports en écoute \(agent\)<\/h3>[\s\S]*>tcp\/8443<\/span>[\s\S]*>nouveau<\/span>/)
  assert.doesNotMatch(html.slice(html.indexOf('Ports en écoute (agent)')), /Connu…/, 'read only: actions in the host drawer')
  assert.doesNotMatch(c.device(seed(dev({ id: 8, hostId: null, hostSrc: null, deletion: { allowed: true, why: null } })), 8), /Ports en écoute \(agent\)/)
})

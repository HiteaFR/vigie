// Golden of the CLIENT, frozen on the code from before the plugin registries. Real rendering of
// the application (the client's esbuild and react-dom/server, like client-render.js) with
// prefilled data (no request): side and mobile navigation (order, links, labels), served
// routes (path found or "Page introuvable"), cockpit tiles (order, labels, links, grid)
// with and without Gitea, cockpit cards, rule labels (order included). Text readable in review.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../tmpdir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
export const CLIENT_INSTALLED = fs.existsSync(path.join(ROOT, 'client/node_modules/esbuild/lib/main.js'))

const ENTRY = [
  "import App from './src/App.jsx'",
  "import { AdminProvider } from './src/admin.jsx'",
  "import { RULE_LABEL } from './src/lib/alerts.js'",
  "import { renderToString } from 'react-dom/server'",
  "import { createElement as h } from 'react'",
  "import { Router } from 'wouter'",
  "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
  // lazy views rendered directly (their content, not only their route)
  "import Ci from './src/plugins/gitea/Ci.jsx'",
  "import Integrations from './src/views/Integrations.jsx'",
  'export { RULE_LABEL }',
  'export function renderView(name, data = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })',
  '  for (const [k, v] of Object.entries(data)) qc.setQueryData(JSON.parse(k), v)',
  '  const El = { ci: Ci, integrations: Integrations }[name]',
  '  return renderToString(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: `/${name}` }, h(El))))',
  '}',
  "export { loadLocale as __loadLocale } from './src/i18n/index.js'",
  'export function render(path, data = {}) {',
  '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })',
  '  for (const [k, v] of Object.entries(data)) qc.setQueryData(JSON.parse(k), v)',
  '  return renderToString(h(QueryClientProvider, { client: qc }, h(AdminProvider, null, h(Router, { ssrPath: path }, h(App)))))',
  '}',
]

async function bundle() {
  const { build } = await import(path.join(ROOT, 'client/node_modules/esbuild/lib/main.js'))
  const r = await build({
    stdin: { contents: ENTRY.join('\n'), resolveDir: path.join(ROOT, 'client'), loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  const file = path.join(tmpDir('vigie-golden-client-'), 'app.mjs')
  fs.writeFileSync(file, r.outputFiles[0].text)
  // fr catalog preloaded (in the browser: main.jsx, before the first render)
  const mod = await import(file)
  await mod.__loadLocale('fr')
  return mod
}

const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
const block = (html, re) => html.match(re)?.[0] ?? ''
const links = html => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map(m => ({ href: m[1], label: text(m[2]) }))

// screen data: session (anonymous read), config, and the server golden summary
const SUMMARY = JSON.parse(fs.readFileSync(path.join(HERE, 'summary.json'), 'utf8'))
const NETWORK = { presence: 'arp', online: 10, active: 11, total: 12, new: 1, sourcesDown: [] }
const base = summary => ({
  '["session"]': { admin: false, anonymousRead: true, configured: true },
  '["config"]': { title: 'Banc', subtitle: 'sous-titre', footer: 'pied de page' },
  '["/api/summary"]': summary,
})

export async function clientOutputs() {
  const m = await bundle()
  const out = []
  const home = m.render('/', base({ ...SUMMARY.all, network: NETWORK }))
  // side and mobile navigation
  const side = block(home, /<nav aria-label="Navigation principale".*?<\/nav>/s)
  const mobile = block(home, /<nav aria-label="Navigation mobile".*?<\/nav>/s)
  out.push('# navigation latérale (lien · libellé)')
  for (const l of links(side)) out.push(`${l.href} · ${l.label}`)
  out.push('', '# navigation mobile (grille ; lien · libellé)', `grille : ${mobile.match(/<ul class="([^"]*)"/)?.[1] ?? '?'}`)
  for (const l of links(mobile)) out.push(`${l.href} · ${l.label}`)
  // routes: path served or "Page introuvable"
  out.push('', '# routes (chemin : servie / introuvable)')
  // English names, then the former French names (durable aliases)
  for (const p of ['/', '/services', '/infra', '/network', '/updates', '/backups', '/ci', '/alerts', '/integrations', '/wall', '/reseau', '/maj', '/sauvegardes', '/alertes', '/mural', '/inconnu']) {
    out.push(`${p} : ${m.render(p, base(SUMMARY.all)).includes('Page introuvable') ? 'introuvable' : 'servie'}`)
  }
  // cockpit tiles (with network; without network; Gitea not configured)
  const kpis = html => {
    const grid = block(html, /<div class="mb-6 grid[^"]*">.*?<\/div><\/a><\/div>|<div class="mb-6 grid[^"]*">.*?(?=<div class="min-w-0)/s)
    const cls = html.match(/<div class="(mb-6 grid[^"]*)">/)?.[1] ?? '?'
    return [`grille : ${cls}`, ...[...grid.matchAll(/<a href="([^"]+)" class="([^"]*)">(.*?)<\/a>/gs)].map(t => `${t[1]} · ${text(t[3])}${/col-span-2/.test(t[2]) ? ' · col-span-2 md:col-span-1' : ''}`)]
  }
  out.push('', '# tuiles du cockpit, avec le réseau', ...kpis(home))
  out.push('', '# tuiles du cockpit, sans le réseau', ...kpis(m.render('/', base({ ...SUMMARY.all, network: null }))))
  out.push('', '# tuiles du cockpit, Gitea non configuré', ...kpis(m.render('/', base({ ...SUMMARY.all, network: null, ci: SUMMARY.ciGiteaOff }))))
  // cockpit cards (panel titles, in order)
  out.push('', '# panneaux du cockpit (titres)')
  for (const t of home.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)) out.push(text(t[1]))
  // CI view (gitea plugin) and Integrations page rendered with data; dates
  // relative to the rendering time, so the text is stable
  const ago = ms => new Date(Date.now() - ms).toISOString()
  const H = 3600_000
  const run = (status, number, title, ms) => ({ status, number, sha: 'abc1234', title, branch: 'main', date: ago(ms), url: `https://forge.example.test/org/app/actions/runs/${number}` })
  const repo = (name, mainStatus, extra = {}) => ({
    name, htmlUrl: `https://forge.example.test/org/${name}`, openPRs: 0, defaultBranch: 'main',
    lastCommit: { message: `commit de ${name}`, author: 'auteur', date: ago(3 * H), sha: 'def5678', url: `https://forge.example.test/org/${name}/commit/def5678` },
    lastRun: run(mainStatus, 12, `run de ${name}`, 2 * H), mainRun: run(mainStatus, 12, `run de ${name}`, 2 * H), lastSuccess: null, ...extra,
  })
  const runner = (id, name, status, busy = false) => ({ id, name, status, busy, labels: ['ubuntu-latest', 'linux:host', 'docker'] })
  const ci = {
    'en échec': { '["gitea"]': [repo('app', 'failure', { openPRs: 2 }), repo('site', 'success'), { name: 'casse', error: true }], '["runners"]': [runner(1, 'runner-a', 'online', true), runner(2, 'runner-b', 'offline')] },
    'au vert': { '["gitea"]': [repo('app', 'success'), repo('site', 'running')], '["runners"]': [runner(1, 'runner-a', 'online'), runner(2, 'runner-b', 'online')] },
    'non configurée': { '["gitea"]': { configured: false }, '["runners"]': { configured: false } },
  }
  for (const [name, data] of Object.entries(ci)) out.push('', `# vue CI, ${name}`, text(m.renderView('ci', data)))
  const integrations = { apiVersion: 0, modules: [
    { id: 'updates', label: 'versions', kind: 'core', state: 'active', errors: [] },
    { id: 'gitea', label: 'Gitea', kind: 'plugin', state: 'unconfigured', errors: [] },
    { id: 'casse', label: 'Cassé', kind: 'plugin', state: 'error', errors: [{ hook: 'signals', message: 'boum', at: ago(5 * 60_000) }, { hook: 'digest', message: 'digest cassé', at: ago(2 * H) }] },
    { id: 'backups', label: 'backups', kind: 'plugin', state: 'error', errors: [{ hook: 'load', message: 'id backups réservé au cœur (source ou module du cœur), plugin non chargé', at: ago(3 * H) }] },
  ] }
  out.push('', '# page Intégrations (actif, non configuré, en erreur, refusé au chargement)', text(m.renderView('integrations', { '["plugins"]': integrations })))

  // rule labels (RULE_LABEL order: list of rules of the silence form)
  out.push('', '# libellés des règles (ordre compris)')
  for (const [k, v] of Object.entries(m.RULE_LABEL)) out.push(`${k} : ${v}`)
  return `${out.join('\n')}\n`
}

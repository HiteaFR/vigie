// Parity of ALL catalogs (server, client, each server and client plugin): same keys,
// same {…} parameters, same required plural forms (one and other, in both languages), no
// empty value, no English value identical to the French outside a named list (proper nouns,
// acronyms, units, words identical in both languages). And the translators' strict mode: under
// node --test, a key missing from the current locale throws (server, plugins, client), with no
// silent fallback to English.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createI18n } from '../lib/i18n.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'))
const plugins = (dir, label) => fs.readdirSync(path.join(ROOT, dir)).filter(id => fs.existsSync(path.join(ROOT, dir, id, 'locales'))).map(id => [`${label}:${id}`, `${dir}/${id}/locales`])
export const CATALOG_DIRS = [['serveur', 'server/locales'], ['client', 'client/src/i18n'], ...plugins('server/plugins', 'plugin serveur'), ...plugins('client/src/plugins', 'plugin client')]

// English values identical to the French, intended: per catalog, named keys (and why)
const SAME = {
  serveur: [
    // proper nouns, acronyms, units and templates without words
    'net.source.pihole', 'net.source.pve', 'rules.label.guest_inodes', 'time.hours', 'time.hours_minutes', 'time.minutes', 'bot.net.sources_ok', 'net.digest.sources_ok',
    // words identical in both languages
    'alerts.maintenance', 'alerts.maintenance_reason', 'audit.silence', 'digest.silences', 'status.infra', 'errors.arp.perms', 'modules.updates', 'plugins.kind.module', 'plugins.kind.plugin', 'silences.target.service',
    // log action codes and Telegram buttons, in English in both languages
    'audit.ack', 'audit.unack', 'buttons.ack', 'buttons.mute',
  ],
  client: [
    // proper nouns, acronyms, paths, units and templates without words
    'dev.attach.config', 'dev.attach.pve', 'map.origin.pve', 'sources.config', 'sources.mdns', 'sources.pihole', 'sources.pve', 'updates.kind.ha', 'updates.kind.os', 'updates.kind.pve',
    'devtypes.nas', 'devtypes.tv', 'rules.label.guest_inodes', 'sec.std.ssh_password', 'nodes.task.aptupdate', 'services.cert_unknown',
    'alerts.dur.1h', 'alerts.dur.4h', 'alerts.dur.24h', 'range.24h', 'time.h', 'time.h_mm', 'time.min', 'time.uptime_hm', 'time.uptime_m',
    'host.exit_code', 'drawer.code', 'map.port', 'net.anchor_src', 'dev.profile.normal',
    // words identical in both languages
    'alerts.digest_at', 'alerts.kind.service', 'alerts.notifications', 'alerts.sev.info', 'alerts.silence_2', 'alerts.silences_2', 'alerts.src_dashboard', 'alerts.type',
    'cockpit.kpi_services', 'dev.attr.type', 'dev.manual.notes', 'dev.manual.type', 'devtypes.console', 'devtypes.switch', 'drawer.incidents', 'form.information',
    'form.notes', 'form.type', 'gap.digest', 'gap.patch', 'infra.infrastructure_vm_lxc', 'integrations.kind.plugin', 'map.kind.wifi', 'map.origin.config', 'map.parent',
    'nav.cockpit', 'nav.infra', 'nav.services', 'netmap.note', 'netmap.port', 'palette.action', 'palette.actions', 'palette.services_2', 'ports.conf.low',
    'sec.port.local', 'services.services_2', 'sources.agent', 'state.info', 'state.maint', 'theme.auto', 'updates.breaking', 'updates.filter.digest', 'updates.kind.app',
    'updates.kind.docker', 'updates.kind.runtime', 'updates.skipped',
  ],
  // raw state of a runner, as Gitea names it
  'plugin client:gitea': ['runner_status.offline', 'runner_status.online'],
}
const FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])
const forms = v => (typeof v === 'object' && v ? Object.entries(v) : [['', v]])
const params = v => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) ?? [])].sort()

test('catalogs: the list covers server, client and each plugin (server and client)', () => {
  assert.deepEqual(CATALOG_DIRS.map(([n]) => n).sort(), ['client', 'plugin client:example', 'plugin client:gitea', 'plugin serveur:example', 'plugin serveur:gitea', 'plugin serveur:ntfy', 'serveur'])
})

test('catalogs: same keys, same parameters, complete plurals (one and other), no empty value, no English identical to the French outside the named list', () => {
  const problems = []
  for (const [name, dir] of CATALOG_DIRS) {
    const fr = read(`${dir}/fr.json`)
    const en = read(`${dir}/en.json`)
    const [kf, ke] = [Object.keys(fr).sort(), Object.keys(en).sort()]
    for (const k of kf.filter(x => !(x in en))) problems.push(`${name} : ${k} absente en anglais`)
    for (const k of ke.filter(x => !(x in fr))) problems.push(`${name} : ${k} absente en français`)
    const same = new Set(SAME[name] ?? [])
    for (const k of kf.filter(x => x in en)) {
      if (JSON.stringify(params(fr[k])) !== JSON.stringify(params(en[k]))) problems.push(`${name} : ${k} paramètres ${params(fr[k])} / ${params(en[k])}`)
      const plural = [fr[k], en[k]].map(v => typeof v === 'object' && v !== null)
      if (plural[0] !== plural[1]) problems.push(`${name} : ${k} pluriel d'un seul côté`)
      for (const [l, v] of [['fr', fr[k]], ['en', en[k]]]) {
        if (typeof v === 'object' && v !== null) {
          for (const f of ['one', 'other']) if (!(f in v)) problems.push(`${name} : ${k}.${f} absente (${l})`)
          for (const f of Object.keys(v)) if (!FORMS.has(f)) problems.push(`${name} : ${k}.${f} forme inconnue (${l})`)
        }
        for (const [f, s] of forms(v)) if (typeof s !== 'string' || !s.trim()) problems.push(`${name} : ${k}${f ? `.${f}` : ''} vide (${l})`)
      }
      const identical = JSON.stringify(fr[k]) === JSON.stringify(en[k])
      if (identical && !same.has(k)) problems.push(`${name} : ${k} identique en anglais et en français (${JSON.stringify(en[k]).slice(0, 60)})`)
      if (!identical && same.has(k)) problems.push(`${name} : ${k} nommée identique, mais traduite : la retirer de la liste`)
    }
    for (const k of same) if (!(k in fr)) problems.push(`${name} : ${k} nommée identique, mais absente`)
  }
  assert.deepEqual(problems, [])
})

// key names are English: no segment made of a common French word (keys used to be derived from the
// French text); the list is a guard, not a dictionary
const FRENCH_WORDS = new Set(['aucun', 'aucune', 'ajouter', 'appareil', 'appareils', 'acquitter', 'cette', 'chargement', 'connexion',
  'derniere', 'dernier', 'detacher', 'ecarter', 'enregistrer', 'etat', 'fermer', 'fiche', 'fiches', 'fusionner', 'hote', 'jamais',
  'lever', 'lien', 'mises', 'motif', 'nouveau', 'nouvelle', 'pas', 'plus', 'poser', 'rafraichir', 'reseau', 'retirer', 'sans',
  'sauvegarde', 'sauvegardes', 'sonde', 'sonder', 'supprimer', 'sur', 'tout', 'valider', 'voir', 'vue', 'vues', 'saisie', 'connu'])
test('catalogs: key names are English (no segment made of a common French word)', () => {
  for (const [name, dir] of CATALOG_DIRS) {
    const bad = Object.keys(read(`${dir}/en.json`)).filter(k => k.split(/[._]/).some(w => FRENCH_WORDS.has(w)))
    assert.deepEqual(bad, [], name)
  }
})

test('strict mode: under node --test, a key missing from the current locale throws (server, plugin), without fallback to English; outside strict, fallback', () => {
  const catalogs = { fr: { a: 'oui' }, en: { a: 'yes', b: 'only in English' } }
  let l = 'fr'
  const t = createI18n({ catalogs, getLocale: () => l })
  assert.equal(t('a'), 'oui')
  assert.throws(() => t('b'), /i18n: missing key: b \(fr\)/, 'missing in French: error, no fallback')
  assert.throws(() => t('c'), /i18n: missing key: c \(fr\)/)
  l = 'en'
  assert.equal(t('b'), 'only in English')
  const loose = createI18n({ catalogs, getLocale: () => 'fr', strict: false })
  assert.deepEqual([loose('b'), loose('c')], ['only in English', 'c'])
  // plugins go through the same translator, strict by default under node --test
  assert.match(fs.readFileSync(path.join(ROOT, 'server/lib/plugins/host.js'), 'utf8'), /t: createI18n\(\{ catalogs: def\.locales \?\? \{\} \}\)/)
})

// component pinned on its major whose hidden major is unknown (hidden null, possible for a
// plugin component that gives its gap without a latest version): no more "null" displayed
test('updates view: unknown hidden major (pinned.hidden null) → label without version, never "null"', async t => {
  const { clientBundle } = await import('./client-render.js')
  const c = await clientBundle(t, 'p5e-pinned', [
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement as h } from 'react'",
    "import { Router } from 'wouter'",
    "import { QueryClient, QueryClientProvider } from '@tanstack/react-query'",
    "import { AdminProvider } from './src/admin.jsx'",
    "import Updates from './src/views/Updates.jsx'",
    "import { loadLocale } from './src/i18n/index.js'",
    'export { loadLocale }',
    'export function render(seed) {',
    '  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })',
    '  for (const [k, v] of Object.entries(seed)) qc.setQueryData([k], v)',
    '  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(Router, { ssrPath: "/maj", ssrSearch: "" }, h(AdminProvider, null, h(Updates)))))',
    '}',
  ])
  if (!c) return
  const comp = hidden => ({ id: 'p:db', name: 'db', kind: 'app', env: 'prod', where: 'web', current: '16.2', latest: '16.4', gap: 'minor', pinned: { pin: 'major', reason: 'figée', hidden, source: 'config', decisionId: null } })
  const seed = hidden => ({ session: { admin: false }, agents: { hosts: [] }, updates: { checkedAt: null, sources: [], stats: null, components: [comp(hidden)] } })
  assert.match(c.render(seed('17.0')), /épinglé \(majeure 17\.0 masquée\)/)
  const html = c.render(seed(null))
  assert.match(html, /épinglé \(majeure suivante masquée\)/)
  assert.doesNotMatch(html, /null/)
  await c.loadLocale('en')
  try {
    assert.match(c.render(seed(null)), /pinned \(next major hidden\)/)
  } finally {
    await c.loadLocale('fr')
  }
})

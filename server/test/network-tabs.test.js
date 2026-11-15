// Network page tab bar, in real rendering (esbuild and react-dom/server, shared harness
// client-render.js); order of the Alerts page panels (static check of the source).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientBundle } from './client-render.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TABS = [['devices', 'Appareils'], ['carte', 'Carte'], ['history', 'Historique']]

const client = t => clientBundle(t, 'network-tabs', [
  "import { NetworkTabs } from './src/views/Network.jsx'",
  "import { renderToStaticMarkup } from 'react-dom/server'",
  "import { createElement } from 'react'",
  "import { Router } from 'wouter'",
  'export const tabs = p => renderToStaticMarkup(createElement(Router, { ssrPath: "/reseau" }, createElement(NetworkTabs, { tabs: ' + JSON.stringify(TABS) + ', onTab() {}, ...p })))',
])
const tabsOf = html => [...html.matchAll(/<button([^>]*role="tab"[^>]*)>([^<]*)<\/button>/g)].map(m => ({ attrs: m[1], label: m[2] }))

test('tab bar (real rendering): tablist, three tabs, aria-selected on the active tab only; "Probe all" for an admin only', async t => {
  const c = await client(t)
  if (!c) return
  for (const active of ['devices', 'carte', 'history']) {
    const html = c.tabs({ tab: active })
    assert.match(html, /role="tablist" aria-label="Vues du réseau"/)
    const tabs = tabsOf(html)
    assert.deepEqual(tabs.map(x => x.label), ['Appareils', 'Carte', 'Historique'])
    // a single selected tab; each one points to its unique panel
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1)
    for (const x of tabs) assert.match(x.attrs, /aria-controls="net-tabpanel"/)
    for (const [i, [k]] of TABS.entries()) {
      const on = k === active
      assert.match(tabs[i].attrs, new RegExp(`aria-selected="${on}"`), `${k} (active: ${active})`)
      assert.match(tabs[i].attrs, new RegExp(`tabindex="${on ? 0 : -1}"`))
      assert.match(tabs[i].attrs, new RegExp(`id="net-tab-${k}"`))
      assert.match(tabs[i].attrs, on ? /border-accent bg-surface-2 text-fg/ : /border-transparent text-muted/)
    }
  }
  // unknown tab in the URL → Devices selected (alone) and reachable with the keyboard
  for (const [tab, list] of [['xyz', TABS], ['history', TABS.slice(0, 2)]]) {
    const html = c.tabs({ tab, tabs: list })
    const t = tabsOf(html)
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, tab)
    assert.match(t[0].attrs, /aria-selected="true"/)
    assert.match(t[0].attrs, /tabindex="0"/)
    assert.equal(t.filter(x => /tabindex="0"/.test(x.attrs)).length, 1)
  }
  const probe = { enabled: true, running: false }
  // admin, probe enabled: the button, on the right of the bar, accessible label
  const admin = c.tabs({ tab: 'carte', probe, isAdmin: true })
  assert.match(admin, /<button type="button" class="[^"]*bg-accent[^"]*ml-auto[^"]*" aria-label="Sonder tout" title="[^"]+"><svg[^>]*lucide-radar[\s\S]*?<\/svg><span class="hidden sm:inline">Sonder tout<\/span><\/button>/)
  // probe running: disabled, label "Sonde en cours…"
  const running = c.tabs({ tab: 'devices', probe: { enabled: true, running: true }, isAdmin: true })
  assert.match(running, /disabled="" aria-label="Sonde en cours…"/)
  // the 4 admin × probe.enabled combinations: only admin + enabled renders the button; probe absent: nothing
  for (const p of [{ probe, isAdmin: false }, { probe: { enabled: false, running: false }, isAdmin: true }, { probe: { enabled: false, running: false }, isAdmin: false }, { probe: null, isAdmin: true }]) {
    assert.doesNotMatch(c.tabs({ tab: 'devices', ...p }), /Sonder tout|Sonde en cours/, JSON.stringify(p))
  }
})

test('tab bar, static: "Probe all" leaves the Devices filter bar, rendered by NetworkTabs whatever the tab', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/src/views/Network.jsx'), 'utf8')
  assert.doesNotMatch(src, /<ProbeAll\b/)
  assert.match(src, /<NetworkTabs tabs=\{[^\n]+\n\s+tab=\{tab\} onTab=\{setTab\} probe=\{v\.sources\.probe\} isAdmin=\{probeAll\.isAdmin\} busy=\{probeAll\.busy\} onProbe=\{probeAll\.run\} \/>/)
  // the bar is rendered before the tab is chosen (Map, History or Devices), inside a
  // role="tabpanel" panel that names the displayed tab
  assert.ok(src.indexOf('<NetworkTabs') < src.indexOf("tab === 'carte' ?"))
  const panel = src.indexOf('<div role="tabpanel" id={NET_PANEL_ID} aria-labelledby={`net-tab-$')
  assert.ok(panel > src.indexOf('<NetworkTabs') && panel < src.indexOf("tab === 'carte' ?"))
  assert.match(src, /^export const NET_PANEL_ID = 'net-tabpanel'$/m)
})

test('Alerts page, static: order Notifications, Active alerts, Silences, History; the grace delay stays in Active alerts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/src/views/Alerts.jsx'), 'utf8')
  const page = src.slice(src.indexOf('export default function Alerts()'))
  const at = s => page.indexOf(s)
  // titles from the catalog
  const order = [`title={t('alerts.notifications')}`, `title={t('alerts.active_alerts')}`, '<Silences />', `title={t('alerts.history_7_days')}`].map(at)
  assert.ok(order.every(i => i > 0), JSON.stringify(order))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  const grace = at("t('alerts.grace'")
  assert.ok(grace > order[1] && grace < order[2])
})

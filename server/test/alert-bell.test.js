// Alerts bell.
// - REAL rendering of the pure parts of client/src/AlertBell.jsx (the client's esbuild and
//   react-dom, like the MdnsName rendering test), skipped only if the client is not installed;
// - Escape: client/src/lib/escape.js, pure code imported directly, with a fake window
//   that respects DOM order (capture then bubbling, each in registration order);
// - static checks of the sources, always run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listenBellEscape, listenDrawerEscape } from '../../client/src/lib/escape.js'
import { tmpDir } from './tmpdir.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, 'client/src', f), 'utf8')
const T0 = Date.parse('2026-10-27T10:00:00Z')

// --- real rendering -----------------------------------------------------------------------

let bundle = null
async function client(t) {
  const esb = path.join(ROOT, 'client/node_modules/esbuild/lib/main.js')
  if (!fs.existsSync(esb)) {
    t.skip('client not installed (npm ci in client/)')
    return null
  }
  if (bundle) return bundle
  const { build } = await import(esb)
  const entry = [
    "import { firingOf, panelOf, badgeOf, BellButton, AlertRows } from './src/AlertBell.jsx'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement } from 'react'",
    "import { Router } from 'wouter'",
    // wouter Links need a router outside the browser
    'const html = el => renderToStaticMarkup(createElement(Router, { ssrPath: "/" }, el))',
    'export { firingOf, panelOf, badgeOf }',
    'export const button = p => html(createElement(BellButton, p))',
    'export const rows = p => html(createElement(AlertRows, p))',
    // fr catalog preloaded (in the browser: main.jsx, before rendering)
    "export { loadLocale as __loadLocale } from './src/i18n/index.js'",
  ].join('\n')
  const r = await build({
    stdin: { contents: entry, resolveDir: path.join(ROOT, 'client'), loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  const file = path.join(tmpDir('dash-bell-render-'), 'bell.mjs')
  fs.writeFileSync(file, r.outputFiles[0].text)
  bundle = await import(file)
  await bundle.__loadLocale('fr')
  return bundle
}

// alerts in the engine.active() format (already sorted by severity then age by the server)
const alert = (key, over = {}) => ({ key, rule: 'service_down', title: `Titre ${key}`, detail: `détail ${key}`, severity: 'warning', state: 'firing', env: 'prod', since: T0 - 60_000, link: `/services?s=${key}`, ...over })
const DATA = {
  active: [
    alert('a', { severity: 'critical' }),
    alert('b'),
    alert('c', { suppressed: 'silence : maintenance du NAS' }),
    alert('d', { env: 'dev' }),
    alert('e', { state: 'pending' }),
    alert('f', { env: 'dev', severity: 'critical', suppressed: 'maintenance' }),
  ],
  incidents: [],
}
const keys = list => list.map(a => a.key)

// the bell checks are subtests of ONE real rendering test, skipped only once if the client is not
// installed (CI without client: exactly "# skipped 2", MdnsName and the bell)
test('real rendering of the bell', async t => {
  const c = await client(t)
  if (!c) return
  await t.test('firingOf: firing, not suppressed, of the env; "all" keeps both envs; order kept', () => {
    assert.deepEqual(keys(c.firingOf(DATA, 'prod')), ['a', 'b'])
    assert.deepEqual(keys(c.firingOf(DATA, 'dev')), ['d'])
    assert.deepEqual(keys(c.firingOf(DATA, 'all')), ['a', 'b', 'd'])
    assert.deepEqual(c.firingOf(undefined, 'all'), [])
  })

  await t.test('panelOf: firing alerts of the env, suppressed included, order kept', () => {
    assert.deepEqual(keys(c.panelOf(DATA, 'prod')), ['a', 'b', 'c'])
    assert.deepEqual(keys(c.panelOf(DATA, 'all')), ['a', 'b', 'c', 'd', 'f'])
    const rev = { active: [alert('z2', { title: 'Zèbre' }), alert('z1', { title: 'Abeille' })] }
    assert.deepEqual(keys(c.panelOf(rev, 'all')), ['z2', 'z1'])
  })

  await t.test('BellButton, 0 alerts: no badge, label for no active alert', () => {
    const html = c.button({ ...c.badgeOf([]), open: false, panelId: 'p1' })
    assert.match(html, /aria-label="Alertes : aucune alerte active"/)
    assert.doesNotMatch(html, />0</)
    assert.doesNotMatch(html, /bg-warn|bg-crit/)
  })

  await t.test('BellButton, 3 warnings: orange "3" badge, label for 3 active alerts; 1 → singular label', () => {
    const three = [alert('x'), alert('y'), alert('z')]
    const html = c.button({ ...c.badgeOf(three), open: false, panelId: 'p1' })
    assert.match(html, /aria-label="Alertes : 3 actives"/)
    assert.match(html, /<span[^>]*bg-warn[^>]*>3<\/span>/)
    assert.doesNotMatch(html, /bg-crit/)
    assert.match(c.button({ ...c.badgeOf([alert('x')]), open: false, panelId: 'p1' }), /aria-label="Alertes : 1 active"/)
  })

  await t.test('BellButton (toneOf): last one critical → red; infos only → BLUE; infos and a warning → orange', () => {
    const html = c.button({ ...c.badgeOf([alert('x'), alert('y', { severity: 'critical' })]), open: false, panelId: 'p1' })
    assert.match(html, /<span[^>]*bg-crit[^>]*>2<\/span>/)
    assert.doesNotMatch(html, /bg-warn/)
    const infos = c.badgeOf([alert('i1', { severity: 'info' }), alert('i2', { severity: 'info' })])
    assert.deepEqual([infos.count, infos.critical, infos.warning, infos.info, infos.tone], [2, 0, 0, 2, 'info'])
    const blue = c.button({ ...infos, open: false, panelId: 'p1' })
    assert.match(blue, /<span[^>]*bg-info text-on-info[^>]*>2<\/span>/)
    assert.doesNotMatch(blue, /bg-warn|bg-crit/)
    const mixed = c.badgeOf([alert('i1', { severity: 'info' }), alert('w1')])
    assert.equal(mixed.tone, 'warn')
    assert.match(c.button({ ...mixed, open: false, panelId: 'p1' }), /<span[^>]*bg-warn text-on-warn[^>]*>2<\/span>/)
    assert.equal(c.badgeOf([]).tone, null)
  })

  await t.test('tile = dot = bell on the SAME set: suppressed, other env, pending and infos', async () => {
    const { alertsKpi } = await import('../../client/src/lib/kpi.js')
    const data = { ...DATA, active: [...DATA.active, alert('g', { severity: 'info' }), alert('h', { severity: 'info', env: 'dev' }), alert('i', { severity: 'info', suppressed: 'silence' })] }
    for (const env of ['prod', 'dev', 'all']) {
      const f = c.firingOf(data, env)
      const k = alertsKpi(f, {})
      assert.equal(k.parts.reduce((x, p) => x + p.n, 0), c.badgeOf(f).count, env)
      assert.equal(k.tone, c.badgeOf(f).tone, env)
    }
    // prod: a (critical) and b; c suppressed, e pending, d and f from another env: excluded; g info
    assert.equal(alertsKpi(c.firingOf(data, 'prod'), {}).value, '1 · 1 · 1')
    assert.equal(alertsKpi(c.firingOf(data, 'dev'), {}).value, '0 · 1 · 1')
  })

  await t.test('BellButton: aria-expanded follows open, aria-controls = panelId, NO aria-haspopup', () => {
    const closed = c.button({ count: 1, critical: false, open: false, panelId: 'cloche-panneau' })
    const opened = c.button({ count: 1, critical: false, open: true, panelId: 'cloche-panneau' })
    assert.match(closed, /aria-expanded="false"/)
    assert.match(opened, /aria-expanded="true"/)
    assert.match(opened, /aria-controls="cloche-panneau"/)
    assert.doesNotMatch(opened + closed, /aria-haspopup/)
  })

  await t.test('AlertRows, 7 alerts: 5 rows, then a "+ 2 others" link to /alerts?env=prod (env prod) and /alerts (env all)', () => {
    const seven = Array.from({ length: 7 }, (_, i) => alert(`k${i}`))
    const prod = c.rows({ list: seven, env: 'prod' })
    assert.equal((prod.match(/<li>/g) ?? []).length, 6) // 5 rows and the "others" link
    assert.equal((prod.match(/Titre k\d/g) ?? []).length, 5)
    assert.match(prod, /<a href="\/alerts\?env=prod"[^>]*>\+ 2 autres<\/a>/)
    const all = c.rows({ list: seven, env: 'all' })
    assert.match(all, /<a href="\/alerts"[^>]*>\+ 2 autres<\/a>/)
  })

  await t.test('AlertRows, suppressed alert: dimmed (opacity-70), maint dot, subtitle = suppression text', () => {
    const html = c.rows({ list: [alert('m', { suppressed: 'silence : maintenance du NAS' })], env: 'all' })
    assert.match(html, /opacity-70/)
    assert.match(html, /silence : maintenance du NAS/)
    const plain = c.rows({ list: [alert('n')], env: 'all' })
    assert.doesNotMatch(plain, /opacity-70/)
    // status dot: Maintenance for the suppressed one, Degraded for the unsuppressed one (warning)
    const dot = h => h.match(/<svg[^>]*role="img"[^>]*aria-label="([^"]*)"/)?.[1]
    assert.deepEqual([dot(html), dot(plain)], ['Maintenance', 'Dégradé'])
  })

  await t.test('AlertRows, empty list: no active alert message and the last resolved one', () => {
    const html = c.rows({ list: [], env: 'all', lastResolved: { title: 'Gitea injoignable', resolvedAt: new Date(T0).toISOString() } })
    assert.match(html, /Aucune alerte active/)
    assert.match(html, /dernière résolue : Gitea injoignable/)
    assert.match(c.rows({ list: [], env: 'all' }), /aucun incident sur 7 jours/)
  })

  await t.test('AlertRows, hostile title: escaped rendering, no img element', () => {
    const html = c.rows({ list: [alert('h', { title: '<img src=x onerror=alert(1)>', detail: '<script>x</script>' })], env: 'all' })
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(html, /<img|<script/i)
  })

  await t.test('AlertRows env=prod: the alert link keeps the env, merged into its query; env=all: link unchanged', () => {
    const list = [alert('a', { link: '/reseau?d=12' }), alert('b', { link: '/infra' }), alert('c', { link: null })]
    const prod = c.rows({ list, env: 'prod' })
    assert.match(prod, /<a href="\/reseau\?d=12&amp;env=prod"/)
    assert.match(prod, /<a href="\/infra\?env=prod"/)
    assert.match(prod, /<a href="\/alerts\?env=prod"[^>]*>(?:(?!<\/a>).)*Titre c/s)
    assert.doesNotMatch(prod, /env=prod[^"]*env=/)
    const dev = c.rows({ list, env: 'dev' })
    assert.match(dev, /<a href="\/reseau\?d=12&amp;env=dev"/)
    const all = c.rows({ list, env: 'all' })
    assert.match(all, /<a href="\/reseau\?d=12"/)
    assert.match(all, /<a href="\/infra"/)
    assert.doesNotMatch(all, /env=/)
  })
})

// --- Escape (always run) -------------------------------------------------------------------

// fake window: a keydown targeting a descendant first goes through the capture listeners
// (registration order), then through the bubbling listeners (registration order)
function fakeWindow() {
  const list = []
  return {
    addEventListener: (type, fn, opts) => list.push({ type, fn, capture: !!(opts === true || opts?.capture) }),
    removeEventListener: (type, fn, opts) => {
      const capture = !!(opts === true || opts?.capture)
      const i = list.findIndex(l => l.type === type && l.fn === fn && l.capture === capture)
      if (i >= 0) list.splice(i, 1)
    },
    count: () => list.length,
    press(key, target = { closest: () => null }) {
      const e = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      for (const l of [...list.filter(x => x.capture), ...list.filter(x => !x.capture)]) if (l.type === 'keydown') l.fn(e)
      return e
    },
  }
}
const noDialog = { querySelector: () => null }

test('drawer open, then bell open: one Escape closes only the bell; the second closes the drawer', () => {
  const win = fakeWindow()
  const closed = []
  listenDrawerEscape(win, () => closed.push('tiroir'), noDialog) // drawer registered first
  const offBell = listenBellEscape(win, { close: () => { closed.push('cloche'); offBell() } }) // the bell unregisters when closing
  const e = win.press('Escape')
  assert.deepEqual(closed, ['cloche'])
  assert.equal(e.defaultPrevented, true)
  win.press('Escape')
  assert.deepEqual(closed, ['cloche', 'tiroir'])
})

test('bell closed (not registered), drawer open: Escape closes the drawer', () => {
  const win = fakeWindow()
  const closed = []
  listenDrawerEscape(win, () => closed.push('tiroir'), noDialog)
  win.press('Escape')
  assert.deepEqual(closed, ['tiroir'])
})

test('modal open inside a drawer: the drawer does not close (dialog[open], target inside the dialog)', () => {
  const closed = []
  const dialog = { tagName: 'DIALOG' }
  // modal open in the document, target inside the dialog
  const win = fakeWindow()
  listenDrawerEscape(win, () => closed.push('tiroir'), { querySelector: sel => (sel === 'dialog[open]' ? dialog : null) })
  win.press('Escape', { closest: sel => (sel === 'dialog' ? dialog : null) })
  // each guard alone is enough
  const w2 = fakeWindow()
  listenDrawerEscape(w2, () => closed.push('tiroir'), { querySelector: sel => (sel === 'dialog[open]' ? dialog : null) })
  w2.press('Escape')
  const w3 = fakeWindow()
  listenDrawerEscape(w3, () => closed.push('tiroir'), noDialog)
  w3.press('Escape', { closest: sel => (sel === 'dialog' ? dialog : null) })
  assert.deepEqual(closed, [])
})

test('listenBellEscape: another key closes nothing and prevents nothing; unregistering removes the capture listener', () => {
  const win = fakeWindow()
  let n = 0
  const off = listenBellEscape(win, { close: () => n++ })
  const e = win.press('Enter')
  assert.equal(n, 0)
  assert.equal(e.defaultPrevented, false)
  assert.equal(win.count(), 1)
  off()
  assert.equal(win.count(), 0)
  win.press('Escape')
  assert.equal(n, 0)
  // unregistering the drawer too
  const w2 = fakeWindow()
  const offDrawer = listenDrawerEscape(w2, () => n++, noDialog)
  offDrawer()
  w2.press('Escape')
  assert.equal(n, 0)
})

// --- static checks (always run) -----------------------------------------------------------------

const code = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

test('AlertBell.jsx: no dangerouslySetInnerHTML', () => {
  assert.doesNotMatch(SRC('AlertBell.jsx'), /dangerouslySetInnerHTML/)
})

test('Shell.jsx: firingOf imported from ./AlertBell.jsx, no own "a.state === \'firing\'" filter anymore', () => {
  const s = code(SRC('Shell.jsx'))
  assert.match(s, /import \{[^}]*\bfiringOf\b[^}]*\} from '\.\/AlertBell\.jsx'/)
  assert.doesNotMatch(s, /a\.state === 'firing'/)
  assert.match(s, /firingOf\(data, env\)/)
  assert.match(s, /<AlertBell \/>/)
})

test('Cockpit.jsx: <ActiveAlerts only once, in the wall branch; lg:grid-cols-5 only there', () => {
  const s = code(SRC('views/Cockpit.jsx'))
  assert.equal((s.match(/<ActiveAlerts/g) ?? []).length, 1)
  assert.equal((s.match(/lg:grid-cols-5/g) ?? []).length, 1)
  const branch = s.slice(s.indexOf('{mural ? ('), s.indexOf(') : (', s.indexOf('{mural ? (')))
  assert.match(branch, /<ActiveAlerts env=\{env\} \/>/)
  assert.match(branch, /lg:grid-cols-5/)
  assert.match(s, /import \{ AlertRows, panelOf \} from '\.\.\/AlertBell\.jsx'/)
})

test('AlertBell.jsx: listenBellEscape(window, focus restored, pointerdown, closing on location and search, click on a link', () => {
  const s = code(SRC('AlertBell.jsx'))
  assert.match(s, /listenBellEscape\(window/)
  assert.match(s, /button\.current\?\.focus\(\)/)
  assert.match(s, /addEventListener\('pointerdown'/)
  assert.match(s, /useSearch\(\)/)
  assert.match(s, /\}, \[location, search\]\)/)
  assert.match(s, /closest\?\.\('a'\)\) setOpen\(false\)/)
})

test('the three drawers: listenDrawerEscape(window, no own e.key === \'Escape\' test anymore; CURRENT close via useEffectEvent, effect on opening only, no eslint-disable directive', () => {
  for (const f of ['DeviceDrawer.jsx', 'HostDrawer.jsx', 'ServiceDrawer.jsx']) {
    const s = code(SRC(f))
    assert.match(s, /const onEscape = useEffectEvent\(\(\) => close\(\)\)\n\s+useEffect\(\(\) => \{\n\s+if \(!id\) return/, f)
    assert.match(s, /listenDrawerEscape\(window, \(\) => onEscape\(\), document\)/, f)
    assert.match(s, /prev\?\.focus\?\.\(\)\n\s+\}\n\s+\}, \[id\]\)/, f)
    assert.doesNotMatch(SRC(f), /eslint-disable/, f)
    assert.doesNotMatch(s, /e\.key === 'Escape'/, f)
  }
})

test('bell panel: full width below md, anchored under the bell from md only', () => {
  const s = code(SRC('AlertBell.jsx'))
  const cls = s.match(/role="region"[\s\S]*?className="([^"]+)"/)?.[1] ?? ''
  const list = cls.split(/\s+/)
  for (const c of ['fixed', 'inset-x-2', 'top-14']) assert.ok(list.includes(c), c)
  for (const c of ['md:absolute', 'md:inset-x-auto', 'md:right-0', 'md:top-full', 'md:w-[22rem]']) assert.ok(list.includes(c), c)
  // no anchoring (nor fixed width) before md: every prefixed token starts with md:
  // (sm:, min-[640px]: or any other variant is refused)
  assert.deepEqual(list.filter(c => c.includes(':') && !c.startsWith('md:')), [])
  assert.ok(!list.some(c => /^(absolute|right-0|w-\[22rem\]|top-full)$/.test(c)))
})

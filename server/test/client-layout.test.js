// Inert background behind drawers, mobile nav under 360 px, wall display clock and layout. Pure
// functions imported directly; real rendering through the client-render harness; static checks of the sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { holdInert, APP_SHELL_ID } from '../../client/src/lib/inert.js'
import { msToNextMinute, startMinuteTicks } from '../../client/src/lib/minuteTick.js'
import { clientBundle } from './client-render.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, 'client/src', f), 'utf8')

// fake document: one element per id, attributes
function fakeDoc() {
  const attrs = new Map()
  const el = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), hasAttribute: k => attrs.has(k) }
  return { getElementById: id => (id === APP_SHELL_ID ? el : null), el }
}

test('holdInert: sets inert on the Shell container, removes it on release; counter; idempotent release', () => {
  const d = fakeDoc()
  const a = holdInert(d)
  assert.equal(d.el.hasAttribute('inert'), true)
  const b = holdInert(d) // two drawers (switching from one to the other)
  a()
  assert.equal(d.el.hasAttribute('inert'), true, 'one hold remains: still inert')
  a() // idempotent: does not release the hold of b
  assert.equal(d.el.hasAttribute('inert'), true)
  b()
  assert.equal(d.el.hasAttribute('inert'), false)
  // without a container (wall display): nothing breaks
  const r = holdInert({ getElementById: () => null })
  r()
})

test('static: the three drawers take holdInert(document) and release it BEFORE giving focus back; Shell carries the id; modal and drawers outside the container', () => {
  for (const f of ['DeviceDrawer.jsx', 'HostDrawer.jsx', 'ServiceDrawer.jsx']) {
    const s = SRC(f)
    assert.match(s, /^import \{ holdInert \} from '\.\/lib\/inert\.js'$/m, f)
    const fx = s.slice(s.indexOf('const prev = document.activeElement'), s.indexOf('}, [id])'))
    assert.match(fx, /const release = holdInert\(document\)\n\s+panel\.current\?\.focus\(\)/, f)
    assert.match(fx, /off\(\)\n\s+release\(\)\n\s+prev\?\.focus\?\.\(\)/, f)
    assert.match(s, /role="dialog"\n\s+aria-modal="true"/, f)
  }
  assert.match(SRC('Shell.jsx'), /<div id=\{APP_SHELL_ID\} className="min-h-full md:pl-52">/)
  // drawers rendered AFTER Shell (siblings, outside the inert container); login modal after children
  const app = SRC('App.jsx')
  assert.ok(app.indexOf('</Shell>') < app.indexOf('<ServiceDrawer />') && app.indexOf('</Shell>') < app.indexOf('<DeviceDrawer />') && app.indexOf('</Shell>') < app.indexOf('<HostDrawer />'))
  const admin = SRC('admin.jsx')
  const prov = admin.slice(admin.indexOf('export function AdminProvider'))
  assert.ok(prov.indexOf('{children}') < prov.indexOf('<LoginDialog'))
})

test('static: mobile nav, label sr-only under 360 px and visible above; badge anchored on the icon', () => {
  const s = SRC('Shell.jsx')
  // label from the catalogue (shell.navigation_mobile)
  const nav = s.slice(s.indexOf("aria-label={t('shell.navigation_mobile')}"))
  assert.ok(s.includes("aria-label={t('shell.navigation_mobile')}"))
  assert.match(nav, /<span className="sr-only min-\[360px\]:not-sr-only">\{v\.short \|\| v\.label\}<\/span>/)
  assert.match(nav, /<span className="relative inline-flex">\n\s+<v\.icon size=\{18\} aria-hidden \/>\n\s+\{v\.badge && <Badge kind=\{v\.badge\} className="absolute -top-2 -right-2\.5" \/>\}/)
  assert.doesNotMatch(nav, /left-1\/2 ml-1\.5/)
  assert.match(nav, /aria-current=\{isActive\(v\.path\) \? 'page' : undefined\}/)
})

test('msToNextMinute: delay until the next minute (pure)', () => {
  const t0 = Date.parse('2026-10-28T10:15:00.000Z')
  assert.equal(msToNextMinute(t0), 60_000)
  assert.equal(msToNextMinute(t0 + 1), 59_999)
  assert.equal(msToNextMinute(t0 + 59_999), 1)
  assert.equal(msToNextMinute(t0 + 12_345), 47_655)
  assert.equal(msToNextMinute(t0 + 60_000 * 7 + 30_000), 30_000)
})

test('startMinuteTicks: first tick at the next minute, then one per minute (delay recomputed); stop', () => {
  let clock = Date.parse('2026-10-28T10:15:42.250Z')
  const timers = []
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  const cleared = []
  let ticks = 0
  const stop = startMinuteTicks(() => { ticks++ }, { now: () => clock, setTimer, clearTimer: id => cleared.push(id) })
  assert.deepEqual(timers.map(t => t.ms), [17_750])
  // the timer fires 3 ms late: the next tick stays aligned on the minute
  clock += 17_753
  timers[0].fn()
  assert.equal(ticks, 1)
  assert.deepEqual(timers.map(t => t.ms), [17_750, 59_997])
  clock += 59_997
  timers[1].fn()
  assert.equal(ticks, 2)
  assert.equal(timers[2].ms, 60_000)
  stop()
  assert.deepEqual(cleared, [3])
  timers[2].fn() // already stopped: no tick
  assert.equal(ticks, 2)
})

test('static: the wall display no longer has a one-second setInterval; MuralClock separate; 6 h reload and hidden cursor kept', () => {
  const s = SRC('views/Mural.jsx')
  assert.doesNotMatch(s, /setInterval/)
  assert.match(s, /export function MuralClock\(/)
  assert.match(s, /useEffect\(\(\) => startMinuteTicks\(\(\) => setNow\(new Date\(\)\)\), \[\]\)/)
  assert.match(s, /<MuralClock \/>/)
  assert.match(s, /setTimeout\(\(\) => window\.location\.reload\(\), 6 \* 3600_000\)/)
  assert.match(s, /\$\{idle \? 'cursor-none' : ''\}/)
  // the Cockpit is no longer rendered inside a component that holds the time
  const mural = s.slice(s.indexOf('export default function Mural'))
  assert.doesNotMatch(mural, /setNow|useState\(new Date/)
})

test('real rendering of MuralClock: HH:MM time and date in French', async t => {
  const c = await clientBundle(t, 'mural-clock', [
    "import { MuralClock } from './src/views/Mural.jsx'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    "import { createElement } from 'react'",
    'export const clock = d => renderToStaticMarkup(createElement(MuralClock, { initial: d }))',
  ])
  if (!c) return
  const html = c.clock(new Date(2026, 9, 28, 9, 5, 30))
  assert.match(html, /<time class="ml-auto font-mono text-2xl tabular-nums text-fg">09:05<\/time>/)
  assert.match(html, /mercredi 28 octobre/)
})

test('static: uptime band on its own line up to lg; a single hypervisor card spans the full row; "Ctrl K" without line break', () => {
  const ck = SRC('views/Cockpit.jsx')
  const health = ck.slice(ck.indexOf('function Health('))
  assert.match(health, /className="flex w-full flex-wrap items-center gap-x-3 gap-y-1\.5 px-3 py-2 text-left hover:bg-surface-2 lg:flex-nowrap"/)
  assert.match(health, /<UptimeBand band=\{s\.band24h\} height="h-4" className="order-last basis-full min-w-0 lg:order-none lg:basis-auto lg:flex-1" \/>/)
  assert.match(health, /<span className="w-14 shrink-0 text-right text-xs tabular-nums text-fg">\{fmtUptime\(s\.uptime24h\)\}<\/span>/)
  const hv = ck.slice(ck.indexOf('function Hypervisors('))
  assert.match(hv, /grid grid-cols-1 gap-3 \$\{list\?\.length > 1 \? 'md:grid-cols-2' : ''\}/)
  assert.match(SRC('Shell.jsx'), /<kbd className="hidden lg:inline whitespace-nowrap font-mono text-2xs text-subtle border border-line rounded px-1">Ctrl K<\/kbd>/)
})

test('static: header tightened under 375 px (margins, spacing, All/Prod/Dev, search, theme); bell, refresh, theme and admin kept on the line', () => {
  const s = SRC('Shell.jsx')
  const hdr = s.slice(s.indexOf('<header'), s.indexOf('</header>'))
  assert.match(hdr, /<div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center gap-3 max-\[374px\]:gap-1\.5 max-\[374px\]:px-2">/)
  assert.match(hdr, /<div className="ml-auto flex items-center gap-2 max-\[374px\]:gap-1">/)
  assert.match(hdr, /px-2\.5 py-1\.5 text-xs text-muted hover:border-line-strong hover:text-fg max-\[374px\]:px-1\.5"/)
  assert.match(hdr, /rounded-lg border border-line bg-surface p-1\.5 text-muted hover:text-fg max-\[374px\]:p-1"/)
  assert.match(s, /rounded-md px-2\.5 py-1 text-xs font-medium transition max-\[374px\]:px-1\.5 /)
  // nothing is hidden: bell (1st line), All/Prod/Dev, refresh, search, theme, admin
  const bar = hdr.slice(hdr.indexOf('ml-auto flex items-center'))
  const order = ['<AlertBell />', '<EnvSwitch />', '<RefreshButton />', 'onClick={onSearch}', 'setTheme(nextTheme(theme))', '<AdminButton />'].map(x => bar.indexOf(x))
  assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), JSON.stringify(order))
  assert.doesNotMatch(bar.slice(0, bar.indexOf('<AdminButton />')), /max-\[374px\]:hidden|hidden max-/)
})

test('static: the backdrop of the three drawers is out of the tab order (tabIndex -1), click kept; "Close details" stays keyboard reachable', () => {
  for (const f of ['DeviceDrawer.jsx', 'HostDrawer.jsx', 'ServiceDrawer.jsx']) {
    const s = SRC(f)
    // labels from the catalogue (common.close, common.close_details), in the three drawers
    const close = String.raw`\{t\('common\.close'\)\}`
    assert.match(s, new RegExp(String.raw`<button type="button" aria-label=${close} tabIndex=\{-1\} className="absolute inset-0 bg-black\/40" onClick=\{close\} \/>`), f)
    assert.doesNotMatch(s, new RegExp(String.raw`aria-label=${close} className="absolute inset-0`), f)
    assert.match(s, /aria-label=\{t\('common\.close_details'\)\}/, f)
  }
})

test('static: under sm (640 px), app title sr-only (h1 kept); visible from sm to md, then in the sidebar', () => {
  const s = SRC('Shell.jsx')
  const hdr = s.slice(s.indexOf('<header'), s.indexOf('</header>'))
  assert.match(hdr, /<div className="min-w-0 md:hidden max-sm:sr-only">\n\s+<h1 className="text-sm font-bold leading-tight text-fg truncate">\{config\?\.title \|\| 'Vigie'\}<\/h1>/)
})

// "Alerts" and "Updates" tiles of the cockpit, and shared color rule. kpi.js, tone.js and
// updates.js are pure code, imported directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alertsKpi, updatesKpi, valueEm, DIGIT_EM, SEP_EM } from '../../client/src/lib/kpi.js'
import { toneOf, tileState, BADGE_CLASS, TEXT_CLASS, FILL_CLASS } from '../../client/src/lib/tone.js'
import { todoOf, updateCounts, displayGap } from '../../client/src/lib/updates.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalog loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = f => fs.readFileSync(path.join(here, '../../client/src', f), 'utf8')
const COCKPIT = path.join(here, '../../client/src/views/Cockpit.jsx')
const alert = severity => ({ severity, state: 'firing', suppressed: false, env: 'prod' })
const firing = (crit, warn, info) => [
  ...Array.from({ length: crit }, () => alert('critical')),
  ...Array.from({ length: warn }, () => alert('warning')),
  ...Array.from({ length: info }, () => alert('info')),
]
const ALERTS_LEGEND = 'crit · warn · info'
const ns = k => k.parts.map(p => p.n)

// --- Alerts (three colored numbers, short legend) ---
test('0 critical, 0 warning, 1 info → "0 · 0 · 1", legend, ok state (blue alone stays green), info tint', () => {
  const k = alertsKpi(firing(0, 0, 1), { incidents24h: 0, masked: 0 })
  assert.equal(k.value, '0 · 0 · 1')
  assert.deepEqual(ns(k), [0, 0, 1])
  assert.deepEqual(k.parts.map(p => p.tone), ['crit', 'warn', 'info'])
  assert.equal(k.sub, ALERTS_LEGEND)
  assert.equal(k.state, 'ok')
  assert.equal(k.tone, 'info')
})

test('same input: the state is neither warn nor crit', () => {
  const k = alertsKpi(firing(0, 0, 1), { incidents24h: 0, masked: 0 })
  assert.notEqual(k.state, 'warn')
  assert.notEqual(k.state, 'crit')
})

test('0 critical, 7 warnings, 1 info → "0 · 7 · 1", sum 8 = badge; the subtitle loses incidents and muted; warn', () => {
  const list = firing(0, 7, 1)
  const k = alertsKpi(list, { incidents24h: 3, masked: 2 })
  assert.equal(k.value, '0 · 7 · 1')
  assert.equal(ns(k).reduce((a, b) => a + b, 0), list.length)
  assert.equal(k.sub, ALERTS_LEGEND)
  assert.doesNotMatch(k.sub, /incident|masqu/)
  assert.equal(k.state, 'warn')
})

test('1 critical, no info → "1 · 0 · 0", crit', () => {
  const k = alertsKpi(firing(1, 0, 0), { incidents24h: 1, masked: 0 })
  assert.equal(k.value, '1 · 0 · 0')
  assert.equal(k.state, 'crit')
  assert.equal(k.tone, 'crit')
})

test('static: Cockpit.jsx calls alertsKpi(firingOf( with firingOf imported from ../AlertBell.jsx, without its own recomputation', () => {
  const src = fs.readFileSync(COCKPIT, 'utf8')
  assert.match(src, /alertsKpi\(firingOf\(/)
  assert.match(src, /^import \{[^}]*\bfiringOf\b[^}]*\} from '\.\.\/AlertBell\.jsx'$/m)
  assert.match(src, /^import \{ alertsKpi, updatesKpi \} from '\.\.\/lib\/kpi\.js'$/m)
  assert.ok(!src.includes('`${a.critical} · ${a.warning}`'), 'old computation of the value')
  assert.doesNotMatch(src, /label="(Alertes|Mises à jour)" value=\{`/)
})

test('firing null → counters of /api/summary; [] takes precedence; nothing at all → "—"', () => {
  const summary = { critical: 0, warning: 2, info: 1, incidents24h: 0, masked: 0 }
  const k = alertsKpi(null, summary)
  assert.deepEqual([k.value, k.state], ['0 · 2 · 1', 'warn'])
  assert.deepEqual(alertsKpi(undefined, summary), k)
  assert.deepEqual([alertsKpi([], summary).value, alertsKpi([], summary).state], ['0 · 0 · 0', 'ok'])
  // auditor case: a critical known from /api/summary only → crit
  const crit = alertsKpi(null, { critical: 1 })
  assert.deepEqual([crit.value, crit.state], ['1 · 0 · 0', 'crit'])
  // strict rule: neither alerts nor summary → unavailable, never a green "0 · 0 · 0"
  assert.deepEqual(alertsKpi(null, null), { parts: null, value: '—', em: null, label: 'alertes indisponibles', sub: 'alertes indisponibles', state: 'unknown', tone: null })
})

test('static: Cockpit.jsx goes through firingOf if alerts.data exists, otherwise alertsKpi(null, s.alerts)', () => {
  const src = fs.readFileSync(COCKPIT, 'utf8')
  assert.match(src, /alerts\.data \? alertsKpi\(firingOf\(alerts\.data, env\), s\.alerts\) : alertsKpi\(null, s\.alerts\)/)
})

test('static: in function Kpis, useSource(\'alerts\') and useSource(\'updates\') without options, once each, BEFORE if (!s) return', () => {
  const src = fs.readFileSync(COCKPIT, 'utf8')
  const start = src.indexOf('function Kpis(')
  assert.ok(start > 0, 'function Kpis found')
  const end = src.indexOf('\nfunction ', start + 1)
  const body = src.slice(start, end > 0 ? end : undefined)
  const early = body.indexOf('if (!s) return')
  assert.ok(early > 0, 'early return found')
  for (const name of ['alerts', 'updates']) {
    const hook = body.indexOf(`useSource('${name}')`)
    assert.ok(hook > 0 && hook < early, `useSource('${name}') without options, before the early return`)
    assert.equal((body.match(new RegExp(`useSource\\('${name}'`, 'g')) ?? []).length, 1, `a single ${name} query`)
  }
})

// --- shared color rule ---
test('toneOf: truth table and priorities; tileState; ONE class table (badges, numbers, bars)', () => {
  const table = [
    [[0, 0, 0], null], [[0, 0, 1], 'info'], [[0, 1, 0], 'warn'], [[0, 1, 1], 'warn'],
    [[1, 0, 0], 'crit'], [[1, 0, 1], 'crit'], [[1, 1, 0], 'crit'], [[1, 1, 1], 'crit'], [[0, 3, 7], 'warn'], [[10, 2, 26], 'crit'],
  ]
  for (const [args, want] of table) assert.equal(toneOf(...args), want, args.join(' · '))
  assert.equal(toneOf(), null)
  assert.deepEqual(['crit', 'warn', 'info', null].map(tileState), ['crit', 'warn', 'ok', 'ok'])
  assert.deepEqual(BADGE_CLASS, { crit: 'bg-crit text-on-crit', warn: 'bg-warn text-on-warn', info: 'bg-info text-on-info' })
  assert.deepEqual(TEXT_CLASS, { crit: 'text-crit', warn: 'text-warn', info: 'text-info' })
  assert.deepEqual(FILL_CLASS, { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit' })
  const css = SRC('index.css')
  for (const t of ['crit', 'warn', 'info']) assert.match(css, new RegExp(`--color-on-${t}: var\\(--on-${t}\\);`))
})

// WCAG contrast (relative luminance), read in index.css: background --crit/--warn/--info, number --on-*
const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
test('badge contrast: 3 tints × 2 themes ≥ 4.5:1, values read in index.css (--crit, --warn, --info unchanged)', () => {
  const css = SRC('index.css')
  const block = sel => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)))
  const v = (blk, name) => blk.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6});`))?.[1]
  const out = []
  for (const [theme, sel] of [['light', ':root'], ['dark', '[data-theme="dark"]']]) {
    const blk = block(sel)
    for (const t of ['crit', 'warn', 'info']) {
      const bg = v(blk, t), fg = v(blk, `on-${t}`)
      assert.ok(bg && fg, `${theme} ${t}`)
      const r = ratio(bg, fg)
      out.push(`${theme} ${t} ${bg}/${fg} ${r.toFixed(2)}`)
      assert.ok(r >= 4.5, `${theme} ${t}: ${r.toFixed(2)}:1 < 4.5`)
    }
  }
  // the backgrounds do not move (only --on-* changes), except light warn darkened (#a16207 → #9d6007)
  assert.deepEqual([v(block(':root'), 'crit'), v(block(':root'), 'warn'), v(block(':root'), 'info')], ['#c81e1e', '#9d6007', '#0369a1'])
  // dark crit lightened (#f05252 → #f26666)
  assert.deepEqual([v(block('[data-theme="dark"]'), 'crit'), v(block('[data-theme="dark"]'), 'warn'), v(block('[data-theme="dark"]'), 'info')], ['#f26666', '#fab219', '#38bdf8'])
  assert.equal(out.length, 6)
})

// Subdued texts and accent ≥ 4.5:1 on the four surfaces, in both themes;
// white (accent-fg) on the accent; hover of filled buttons (brightness-90); state
// colors (ok, warn, crit, info) as text ≥ 4.5:1 on the four surfaces too
const hexOf = c => c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
const darker = (hex, k) => `#${hexOf([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) * k))}`
test('AA contrasts: fg-subtle, fg-muted, accent and state colors on bg and surface-1/2/3, accent-fg on accent, hover of filled buttons', () => {
  const css = SRC('index.css')
  const block = sel => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)))
  const v = (blk, name) => blk.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6});`))?.[1]
  const SURF = ['bg', 'surface', 'surface-2', 'surface-3']
  const fails = []
  const states = []
  for (const [theme, sel] of [['light', ':root'], ['dark', '[data-theme="dark"]']]) {
    const blk = block(sel)
    for (const fg of ['fg-subtle', 'fg-muted', 'accent']) {
      for (const bg of SURF) {
        const r = ratio(v(blk, fg), v(blk, bg))
        if (!(r >= 4.5)) fails.push(`${theme} ${fg}/${bg} ${r.toFixed(2)}`)
      }
    }
    const onAccent = ratio(v(blk, 'accent-fg'), v(blk, 'accent'))
    if (!(onAccent >= 4.5)) fails.push(`${theme} accent-fg/accent ${onAccent.toFixed(2)}`)
    // hover of filled buttons: brightness(0.9) filter on the background AND the text
    const hover = ratio(darker(v(blk, 'accent-fg'), 0.9), darker(v(blk, 'accent'), 0.9))
    if (!(hover >= 4.5)) fails.push(`${theme} survol ${hover.toFixed(2)}`)
    for (const st of ['ok', 'warn', 'crit', 'info', 'unknown', 'maint']) for (const bg of SURF) states.push([theme, st, bg, Number(ratio(v(blk, st), v(blk, bg)).toFixed(2))])
  }
  assert.deepEqual(fails, [])
  // expected values
  assert.deepEqual([v(block(':root'), 'fg-subtle'), v(block(':root'), 'accent'), v(block('[data-theme="dark"]'), 'fg-subtle'), v(block('[data-theme="dark"]'), 'accent')], ['#5f6672', '#0f766e', '#8590a2', '#2dd4bf'])
  // filled buttons: no more opacity on hover (it lightened the background), brightness-90 instead
  const admin = SRC('admin.jsx')
  assert.match(admin, /^export const btnPrimary = `\$\{btn\} bg-accent text-accent-fg hover:brightness-90`$/m)
  for (const f of ['admin.jsx', 'views/Network.jsx']) assert.doesNotMatch(SRC(f), /bg-accent[^'"`]*hover:opacity/, f)
  // header "admin" button: accent text on surface background (on bg-accent/10, 4.41:1; on hover /20, 3.82:1)
  assert.match(admin, /border border-accent\/50 bg-surface px-2 py-1\.5 text-xs text-accent hover:border-accent/)
  assert.doesNotMatch(admin, /bg-accent\/10|hover:bg-accent\/20/)
  // state colors as text, all ≥ 4.5 (before: ok 4.43 and warn 4.35 on surface-3, in light)
  const under = states.filter(x => x[3] < 4.5).map(x => x.join(' '))
  assert.deepEqual(under, [])
  assert.equal(states.length, 48)
  assert.deepEqual([v(block(':root'), 'ok'), v(block(':root'), 'warn')], ['#157e3c', '#9d6007'])
  assert.deepEqual([v(block('[data-theme="dark"]'), 'ok'), v(block('[data-theme="dark"]'), 'warn')], ['#22c55e', '#fab219'])
  // state text on ITS background (bg-ok-bg text-ok, bg-crit-bg text-crit…). In dark, the
  // -bg backgrounds are translucent: composited on bg, surface, surface-2 and surface-3. ALL pairs
  // required ≥ 4.5, without exception
  const v8 = (blk, name) => blk.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?);`))?.[1]
  const over = (fill, under) => {
    const a = fill.length > 7 ? parseInt(fill.slice(7, 9), 16) / 255 : 1
    return `#${hexOf([1, 3, 5].map(i => a * parseInt(fill.slice(i, i + 2), 16) + (1 - a) * parseInt(under.slice(i, i + 2), 16)))}`
  }
  const onBg = []
  for (const [theme, sel] of [['light', ':root'], ['dark', '[data-theme="dark"]']]) {
    const blk = block(sel)
    for (const st of ['ok', 'warn', 'crit', 'info', 'unknown', 'maint']) {
      for (const u of SURF) onBg.push([theme, st, u, Number(ratio(v(blk, st), over(v8(blk, `${st}-bg`), v(blk, u))).toFixed(2))])
    }
  }
  assert.equal(onBg.length, 48)
  assert.deepEqual(onBg.filter(x => x[3] < 4.5).map(x => x.join(' ')), [])
  // values of the lightened and darkened colors
  assert.deepEqual([v(block(':root'), 'unknown'), v(block('[data-theme="dark"]'), 'unknown'), v(block('[data-theme="dark"]'), 'crit')], ['#686e7c', '#8d95a2', '#f26666'])
})

// --- Updates: ONE set with all the cases ---
const comp = (id, extra) => ({ id, name: id, env: 'prod', gap: 'minor', ...extra })
const UPDATES = {
  components: [
    comp('sec', { gap: 'minor', security: true }), // security (with a gap) → red
    comp('eol', { gap: 'same', eol: { passed: true } }), // end of life passed, up to date → red
    comp('maj', { gap: 'major' }), comp('dep', { gap: 'deploy', kind: 'deploy' }), // orange
    comp('min', { gap: 'minor' }), comp('pat', { gap: 'patch' }), comp('dig', { gap: 'digest' }), comp('unk', { gap: 'unknown' }), // blue
    comp('soon', { gap: 'same', eol: { soon: true } }), // end of life near, up to date → blue
    comp('secsame', { gap: 'same', security: true, eol: { soon: true } }), // security flag, but up to date → blue (via displayGap)
    comp('err', { gap: null, error: 'injoignable', latest: null }), // error without latest version → blue
    comp('apt', { gap: 'patch', kind: 'apt' }), comp('auto', { gap: 'digest', auto: true }), // apt, automatic update → blue
    // excluded: ignored, up to date, ahead, other environment
    comp('ign', { gap: 'major', ignored: true }), comp('same', { gap: 'same' }), comp('ahead', { gap: 'ahead' }),
    comp('devmaj', { gap: 'major', env: 'dev' }), comp('devsec', { gap: 'minor', security: true, env: 'dev' }),
  ],
}
test('updatesKpi: red = security and end of life, orange = major and not deployed, blue = the REST (by difference)', () => {
  const todo = todoOf(UPDATES, 'prod')
  assert.deepEqual(todo.map(c => c.id), ['sec', 'eol', 'maj', 'dep', 'min', 'pat', 'dig', 'unk', 'soon', 'secsame', 'err', 'apt', 'auto'])
  assert.deepEqual(todo.map(c => displayGap(c)), ['security', 'eol', 'major', 'deploy', 'minor', 'patch', 'digest', 'unknown', 'same', 'same', 'error', 'patch', 'digest'])
  const k = updatesKpi(todo)
  assert.deepEqual([k.value, k.sub, k.state, k.tone], ['2 · 2 · 9', 'sécu · maj. · autres', 'crit', 'crit'])
  assert.equal(k.label, '2 en sécurité ou fin de vie, 2 majeures, 9 autres')
  // a gap unknown to the list (new kind) falls into blue, never lost
  assert.deepEqual(updateCounts([comp('x', { gap: 'nouveau' })]), { r: 0, o: 0, b: 1 })
})

test('sum = number on the badge (same todoOf filter, same set); environment filter; blue alone → green tile', () => {
  for (const env of ['prod', 'dev', 'all']) {
    const todo = todoOf(UPDATES, env)
    const k = updatesKpi(todo)
    assert.equal(k.parts.reduce((a, p) => a + p.n, 0), todo.length, env)
    assert.deepEqual(updateCounts(todo), { r: k.parts[0].n, o: k.parts[1].n, b: k.parts[2].n })
  }
  assert.equal(updatesKpi(todoOf(UPDATES, 'dev')).value, '1 · 1 · 0')
  assert.equal(updatesKpi(todoOf(UPDATES, 'all')).value, '3 · 3 · 9')
  const others = updatesKpi(todoOf({ components: [comp('a', { gap: 'minor' }), comp('b', { gap: 'patch' })] }, 'prod'))
  assert.deepEqual([others.value, others.state, others.tone], ['0 · 0 · 2', 'ok', 'info'])
  assert.deepEqual([updatesKpi([]).value, updatesKpi([]).state, updatesKpi([]).tone], ['0 · 0 · 0', 'ok', null])
})

test('without /api/updates → "—", unknown, no number, even if /api/summary has numbers', () => {
  const summary = { checkedAt: '2026-10-27T08:00:00Z', security: 2, eol: 1, major: 3, total: 9 }
  for (const k of [updatesKpi(null), updatesKpi(undefined), updatesKpi(null, summary)]) {
    assert.deepEqual(k, { parts: null, value: '—', em: null, label: 'mises à jour indisponibles', sub: 'mises à jour indisponibles', state: 'unknown', tone: null })
  }
  const cockpit = fs.readFileSync(COCKPIT, 'utf8')
  assert.match(cockpit, /const uk = updates\.data \? updatesKpi\(todoOf\(updates\.data, env\)\) : updatesKpi\(null\)/)
  assert.doesNotMatch(cockpit, /s\.updates/)
})

test('accessible texts: each number readable without the color (sr-only), agreements', () => {
  assert.equal(alertsKpi(firing(2, 1, 0), {}).label, '2 critiques, 1 avertissement, 0 info')
  assert.equal(alertsKpi(firing(0, 0, 3), {}).label, '0 critique, 0 avertissement, 3 infos')
  assert.equal(updatesKpi(todoOf({ components: [comp('m', { gap: 'major' })] }, 'prod')).label, '0 en sécurité ou fin de vie, 1 majeure, 0 autre')
  const cockpit = fs.readFileSync(COCKPIT, 'utf8')
  assert.match(cockpit, /<span className="sr-only">\{k\.label\}<\/span>/)
  assert.match(cockpit, /<span aria-hidden="true">/)
})

test('static: the tile and UpdatesBadge go through lib/updates.js (todoOf), without a local copy; a single definition', () => {
  const cockpit = fs.readFileSync(COCKPIT, 'utf8')
  const shell = SRC('Shell.jsx')
  const updates = SRC('views/Updates.jsx')
  assert.match(cockpit, /^import \{ todoOf \} from '\.\.\/lib\/updates\.js'$/m)
  assert.match(shell, /^import \{ todoOf, updateCounts \} from '\.\/lib\/updates\.js'$/m)
  const badge = shell.slice(shell.indexOf('function UpdatesBadge('), shell.indexOf('\n}\n', shell.indexOf('function UpdatesBadge(')))
  assert.match(badge, /const todo = todoOf\(data, env\)/)
  assert.doesNotMatch(badge, /actionable|displayGap|matchEnv|\.filter\(/)
  assert.match(updates, /^import \{ displayGap, actionable \} from '\.\.\/lib\/updates\.js'$/m)
  // the view no longer re-exports the rules; they are taken from lib/updates.js (import line 10)
  assert.doesNotMatch(updates, /^export \{/m)
  const all = fs.readdirSync(path.join(here, '../../client/src'), { recursive: true }).filter(f => /\.(jsx?|mjs)$/.test(f))
  const defs = re => all.filter(f => re.test(fs.readFileSync(path.join(here, '../../client/src', f), 'utf8')))
  assert.deepEqual(defs(/(const|function) actionable\b/), [path.join('lib', 'updates.js')])
  assert.deepEqual(defs(/function displayGap\b/), [path.join('lib', 'updates.js')])
  assert.deepEqual(defs(/const matchEnv\b/), [path.join('lib', 'env.js')])
  assert.deepEqual(defs(/function todoOf\b|const todoOf\b/), [path.join('lib', 'updates.js')])
})

test('static: bg-crit, bg-warn, bg-info in Shell.jsx, AlertBell.jsx and Cockpit.jsx ONLY through the lib/tone.js table; badges and bell through toneOf', () => {
  const shell = SRC('Shell.jsx')
  const bell = SRC('AlertBell.jsx')
  // the tile (Kpi) is in ui/Kpi.jsx, the CI tile in the gitea plugin
  const kpiSrc = SRC('ui/Kpi.jsx')
  const ciTiles = SRC('plugins/gitea/tiles.jsx')
  const cockpit = fs.readFileSync(COCKPIT, 'utf8') + kpiSrc
  for (const [name, src] of [['Shell.jsx', shell], ['AlertBell.jsx', bell], ['Cockpit.jsx', cockpit], ['plugins/gitea/tiles.jsx', ciTiles]]) {
    assert.doesNotMatch(src, /\bbg-(crit|warn|info)\b/, `${name}: local color class`)
    assert.doesNotMatch(src, /\btext-(white|black)\b/, `${name}: local number color`)
  }
  const body = (src, name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)))
  assert.match(body(shell, 'AlertBadge'), /const \{ tone \} = badgeOf\(firing\)/)
  assert.match(body(shell, 'AlertBadge'), /BADGE_CLASS\[tone\]/)
  assert.match(body(shell, 'UpdatesBadge'), /BADGE_CLASS\[toneOf\(k\.r, k\.o, k\.b\)\]/)
  assert.match(body(shell, 'NetworkBadge'), /BADGE_CLASS\.warn/)
  assert.match(body(bell, 'BellButton'), /BADGE_CLASS\[tone\]/)
  assert.match(bell, /tone: toneOf\(critical, warning, info\)/)
  // tiles: state and colors through kpi.js (toneOf, tileState), numbers through TEXT_CLASS, bars through FILL_CLASS
  // tile labels through the catalog
  assert.match(cockpit, /<Kpi mural=\{mural\} tri em=\{ak\.em\} icon=\{Bell\} label=\{t\('cockpit\.kpi_alerts'\)\} value=\{<Tri k=\{ak\} \/>\} sub=\{ak\.sub\} state=\{ak\.state\}/)
  assert.match(cockpit, /<Kpi mural=\{mural\} tri em=\{uk\.em\} icon=\{PackageCheck\} label=\{t\('cockpit\.kpi_updates'\)\} value=\{<Tri k=\{uk\} \/>\} sub=\{uk\.sub\} state=\{uk\.state\}/)
  assert.equal((cockpit.match(/<Kpi [^>]*\btri\b/g) ?? []).length, 2, 'only these two tiles')
  assert.match(cockpit, /className=\{p\.n \? TEXT_CLASS\[p\.tone\] : 'text-subtle'\}/)
  assert.equal((cockpit.match(/FILL_CLASS\.(ok|warn|crit)/g) ?? []).length, 3)
  // value on one line; size according to the tile width AND the value length
  // (--kpi-em set by the component); legend on two lines at most, never "…"
  assert.ok(cockpit.includes("{'\\u202f·\\u202f'}"), 'separator U+202F · U+202F')
  assert.match(cockpit, /\{i > 0 && <Sep \/>\}/)
  assert.match(cockpit, /^const TRI_VALUE = 'whitespace-nowrap text-\[length:clamp\(0\.75rem,calc\(100cqw\/var\(--kpi-em,5\)\),1\.5rem\)\]'$/m)
  assert.match(cockpit, /^const TRI_VALUE_MURAL = 'whitespace-nowrap text-\[length:clamp\(0\.75rem,calc\(100cqw\/var\(--kpi-em,5\)\),1\.875rem\)\]'$/m)
  assert.match(cockpit, /style=\{tri && em \? \{ '--kpi-em': em \} : undefined\}/)
  assert.match(cockpit, /<Kpi mural=\{mural\} tri em=\{ak\.em\}/)
  assert.match(cockpit, /<Kpi mural=\{mural\} tri em=\{uk\.em\}/)
  assert.match(cockpit, /\$\{tri \? '@container' : ''\}/)
  assert.match(cockpit, /\$\{tri \? 'line-clamp-2' : 'truncate'\}/)
  assert.doesNotMatch(cockpit, /xl:text-xl|xl:hidden|function Legend/)
  assert.match(SRC('lib/kpi.js'), /state: tileState\(tone\)/)
})

test('value length in em and size that shrinks as the value grows (12 px floor)', () => {
  // ratio measured on the bench at 24 px: 118 px for "10 · 2 · 26", 168 px for "120 · 15 · 260"
  assert.equal(DIGIT_EM, 0.694)
  assert.equal(SEP_EM, 0.722)
  const em = (...ns) => valueEm(ns)
  assert.equal(em(10, 2, 26), 5.111) // 5 digits, 2 separators, 4 % margin
  assert.equal(em(120, 15, 260), 7.276) // 8 digits
  assert.equal(em(0, 3, 7), 3.667)
  assert.equal(em(123, 45, 678), em(120, 15, 260)) // same number of digits
  assert.ok(em(1, 1, 1) < em(10, 1, 1) && em(10, 1, 1) < em(10, 10, 1) && em(10, 10, 1) < em(100, 10, 1), 'grows with each digit')
  // rendered size: clamp(12 px, width / em, 24 px) — decreasing with the length
  const px = (width, e) => Math.min(24, Math.max(12, width / e))
  const sizes = [em(0, 3, 7), em(10, 2, 26), em(120, 15, 260), em(1234, 567, 8901)].map(e => px(138, e))
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] <= sizes[i - 1], `size ${sizes[i]} > ${sizes[i - 1]}`)
  assert.equal(px(138, em(10, 2, 26)), 24) // 375 px: 24 px, as before
  // at 88 px (narrow tile): "10 · 2 · 26" ≈ 17.2 px; "120 · 15 · 260" ≈ 12.1 px, above the floor
  assert.ok(Math.abs(px(88, em(10, 2, 26)) - 17.22) < 0.01)
  assert.ok(px(88, em(120, 15, 260)) >= 12)
  // the tile carries em; "—" has none
  assert.equal(alertsKpi(firing(1, 2, 3), {}).em, em(1, 2, 3))
  assert.equal(updatesKpi(null).em, null)
})

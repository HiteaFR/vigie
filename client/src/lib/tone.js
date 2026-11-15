// ONE color rule for the cockpit tiles and the badges (menu, bell): red if there is red,
// otherwise orange if there is orange, otherwise blue (info); null when everything is zero
// (no badge). Pure code, tested by server/test/kpi.test.js.
export function toneOf(r = 0, o = 0, i = 0) {
  if (r > 0) return 'crit'
  if (o > 0) return 'warn'
  if (i > 0) return 'info'
  return null
}
// ONE table for every badge: background and number; --on-* reads at ≥ 4.5:1 in both themes
// (index.css, checked by the contrast test)
export const BADGE_CLASS = { crit: 'bg-crit text-on-crit', warn: 'bg-warn text-on-warn', info: 'bg-info text-on-info' }
// colored number of a tile; a zero is dimmed
export const TEXT_CLASS = { crit: 'text-crit', warn: 'text-warn', info: 'text-info' }
// solid bars, no text (cockpit backups)
export const FILL_CLASS = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit' }
// tile state: green when there is only blue (or nothing)
export const tileState = tone => (tone === 'crit' || tone === 'warn' ? tone : 'ok')

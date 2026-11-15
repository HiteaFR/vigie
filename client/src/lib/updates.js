// Updates: pure rules shared by the Updates view, the menu badge and the cockpit tile (same
// source, same filter, same groups). No React.
import { matchEnv } from './env.js'

// displayed gap of a component
export function displayGap(c) {
  if (c.error && !c.latest) return 'error'
  if (c.ignored) return 'ignored'
  if (c.eol?.passed) return 'eol'
  if (c.security && c.gap && c.gap !== 'same') return 'security'
  return c.gap || 'unknown'
}

// to handle: the default view of Updates
export const actionable = c => !c.ignored && ((c.gap && !['same', 'ahead'].includes(c.gap)) || c.eol?.passed || c.eol?.soon || (c.error && !c.latest))

// components to handle in the environment: the menu badge number
export const todoOf = (data, env) => (data?.components ?? []).filter(c => matchEnv(env, c.env) && actionable(c))

// three groups by displayed gap: red (security, end of life), orange (major, not deployed),
// blue = the REST of the components to handle, computed by difference (never by a closed list)
const RED = new Set(['security', 'eol'])
const ORANGE = new Set(['major', 'deploy'])
export function updateCounts(list) {
  const r = list.filter(c => RED.has(displayGap(c))).length
  const o = list.filter(c => ORANGE.has(displayGap(c))).length
  return { r, o, b: list.length - r - o }
}

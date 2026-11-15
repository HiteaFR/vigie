// "automatic updates" state of a host for display (updates page, host drawer), computed once
// on the server side, with the same criteria as the autoupdate_off and autoupdate_failed
// rules. States: active, off (disabled), failed, unknown (agent v6, missing block or no
// report). "Never run" stays active, with a note: the alert waits autoUpdateMaxAgeHours
// before firing (recent installation). detail: only what the state label and the "last run"
// line do not already say (no repetition on screen).
import { fmtDuration } from '../clock.js'
import { t as tr } from '../i18n.js'

export function autoUpdateStatus(slow, { now = Date.now(), maxAgeHours = 48 } = {}) {
  if (!slow) return { state: 'unknown', detail: tr('updates.auto.no_report') }
  if (!(slow.version >= 7)) return { state: 'unknown', detail: tr('updates.auto.v6') }
  const au = slow.autoUpdate
  if (!au) return { state: 'unknown', detail: tr('updates.auto.no_apt') }
  const run = { lastRunAt: au.lastRunAt, lastResult: au.lastResult, applied: au.applied }
  if (!au.installed) return { state: 'off', detail: tr('updates.auto.missing'), ...run }
  if (!au.enabled) return { state: 'off', detail: null, ...run }
  if (!au.securityOnly) return { state: 'off', detail: tr('updates.auto.not_security'), ...run }
  if (au.lastResult === 'failed') return { state: 'failed', detail: null, ...run }
  if (au.lastRunAt == null) return { state: 'active', detail: tr('updates.auto.never'), ...run }
  const age = now - au.lastRunAt * 1000
  if (age > maxAgeHours * 3600_000) return { state: 'failed', detail: tr('updates.auto.stale', { duration: fmtDuration(maxAgeHours * 3600_000) }), ...run }
  return { state: 'active', detail: null, ...run }
}

import { ago } from './format.js'
import { t } from '../i18n/index.js'

// Reading a host's dash-report report (/api/agents view): overall state and
// counters, shared by the Infra page cards and the host drawer.
const FRESH_MS = 5 * 60_000

export function fsPct(f) {
  return f.used + f.avail ? (f.used / (f.used + f.avail)) * 100 : 0
}

export function agentSummary(a) {
  if (!a || !a.agent) return { state: 'none', label: t('agent.none') }
  const f = a.fast
  if (!a.ok || !f || Date.now() - a.at > FRESH_MS) {
    return { state: 'unknown', label: a.error || t('agent.no_report'), error: true }
  }
  const cs = f.docker?.containers || []
  const running = cs.filter(c => c.state === 'running').length
  const unhealthy = cs.filter(c => c.health === 'unhealthy').length
  const restarting = cs.filter(c => c.state === 'restarting' || c.recentRestarts >= 3).length
  const failedUnits = [...new Set([...(f.systemd?.failed || []), ...(f.systemd?.watched || []).filter(u => u.active !== 'active').map(u => u.unit)])]
  const maxFs = Math.max(0, ...f.fs.map(fsPct))
  const apt = a.slow?.apt
  const aptAgeDays = apt?.listsAt ? (Date.now() / 1000 - apt.listsAt) / 86400 : null
  const crit = unhealthy || restarting || maxFs >= 95
  const warn = failedUnits.length || maxFs >= 85 || (aptAgeDays != null && aptAgeDays > 7)
  return {
    state: crit ? 'crit' : warn ? 'warn' : 'ok',
    containers: f.docker ? { running, total: cs.length, unhealthy, restarting } : null,
    failedUnits, maxFs, apt, aptAgeDays,
    reboot: f.reboot?.required ? f.reboot.reason || t('agent.reboot_yes') : null,
    // services to restart (agent v8); null: unknown (agent v7 or v6, no report)
    restart: a.slow?.version >= 8 ? a.slow.restart ?? null : null,
  }
}

// "3 d" from an ISO Docker timestamp ("for 3 d"); "—" if missing or before 2000. Same
// computation as ago (lib/format.js), bare format
export function since(iso) {
  const t = Date.parse(iso)
  if (!t || t < Date.UTC(2000, 0, 1)) return '—'
  return ago(t, { bare: true })
}

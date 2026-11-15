#!/usr/bin/env node
// Simulation of the alert rules on the REAL state, without sending anything.
//   node scripts/alerts-preview.mjs [--api http://127.0.0.1:8088] [--config ../config.json] [--all]
// --api: address of the dashboard (default: http://127.0.0.1:8088, the server's default port on
// the same machine). Never read from the environment: the script does not touch variables.
// Reads the dashboard API with GET only, without a session (the target instance must allow
// anonymous read, security.anonymousRead): /api/agents, /api/cluster, /api/services (probes and
// widgets), /api/backups, /api/proxmox (node disks); applies the repository's rules (createRules,
// the same code as the engine) with the repository's config; prints, per rule, the signals that
// would raise an alert (cond true): key, severity, title, detail, and the parents that would
// suppress it. No database, no engine, no notifier: nothing can be sent. Sources not read
// (runners, Gitea, memory and swap of the Proxmox nodes, network module, versions): their rules
// are not simulated.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { createRules, RULE_LABEL } from '../lib/alerts/rules.js'
import { createMonitor } from '../lib/monitor.js'
import { setLocale } from '../lib/i18n.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// these rules are always listed, even without an alert
export const L7_RULES = ['systemd_failed', 'guest_disk', 'vpn_down', 'vpn_leak', 'vpn_noinfo', 'guest_undeclared']
// automatic security updates (agent v7); security_updates in automatic-updates mode is not
// simulated (the age of the fixes lives in the service database: without the updates module,
// cond null)
// posture_regression and port_new are not simulated: the API read WITHOUT a session serves neither
// the posture nor the listening ports (admin only), and their memory lives in the service
// database; they are checked through the test scenarios
export const L9_RULES = ['autoupdate_off', 'autoupdate_failed']
export const L12_RULES = ['restart_required', 'guest_inodes', 'time_unsynced']
// temperature of the node disks (disks read through /api/proxmox)
export const L14_RULES = ['disk_temp']
// declared containers (services[].container) missing or stopped, from /api/agents
export const L15_RULES = ['container_down']
const LISTED = [...L7_RULES, ...L9_RULES, ...L12_RULES, ...L14_RULES, ...L15_RULES]

async function get(api, p) {
  const r = await fetch(new URL(p, api), { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`GET ${p} → HTTP ${r.status}`)
  return r.json()
}

// real state (API) → inputs of createRules; now: local clock
export async function preview({ api, configPath, now = Date.now() }) {
  const loaded = loadConfig(configPath)
  if (loaded.errors) throw new Error(`invalid config:\n  - ${loaded.errors.join('\n  - ')}`)
  const cfg = loaded.config
  // rule labels and titles in the instance language (en by default), like the server
  setLocale(cfg.locale)
  const [agentsView, cluster, services, backups, proxmox] = await Promise.all(['/api/agents', '/api/cluster', '/api/services', '/api/backups', '/api/proxmox'].map(p => get(api, p)))
  // probes: the view only gives the state; consecutive failures and successes approximated by the thresholds
  const monitor = createMonitor(cfg)
  const checkState = new Map(services.services.flatMap(s => s.checks.map(c => [c.id, c])))
  const results = {
    checks: monitor.checks,
    result: id => {
      const c = checkState.get(id)
      if (!c || c.state === 'unknown') return null
      const crit = c.state === 'crit'
      return { ...c, fails: crit ? cfg.alerts.failAfter : 0, oks: crit ? 0 : cfg.alerts.recoverAfter }
    },
  }
  const byId = new Map(agentsView.hosts.map(h => [h.id, h]))
  const agents = { hosts: cfg.hosts.filter(h => h.agent), get: id => byId.get(id) ?? { ok: null } }
  const widgets = { get: id => services.services.find(s => s.id === id)?.widget ?? null }
  const snap = {
    cluster: { data: cluster, at: now, error: null },
    backups: { data: backups, at: now, error: null },
    // node disks: same shape as the engine source ({ id, disks } or { id, error })
    disks: { data: proxmox.clusters.map(c => (c.disksError ? { id: c.id, error: c.disksError } : { id: c.id, disks: c.disks ?? [] })), at: now, error: null },
  }
  const signals = createRules(cfg, results, agents, null, null, widgets).evaluate(snap, now)
  const firing = signals.filter(s => s.cond === true)
  const keys = new Set(firing.map(s => s.key))
  return firing.map(s => ({ ...s, maskedBy: (s.parents ?? []).filter(k => keys.has(k)) }))
}

export function render(list, { all = false } = {}) {
  const lines = []
  const byRule = Map.groupBy(list, s => s.rule)
  const rules = all ? [...new Set([...LISTED, ...byRule.keys()])] : LISTED
  for (const r of rules) {
    const items = byRule.get(r) ?? []
    lines.push(`${r} (${RULE_LABEL[r] ?? r}): ${items.length ? `${items.length} alert(s)` : 'none'}`)
    for (const s of items) {
      lines.push(`  ${s.severity.padEnd(8)} ${s.key} · ${s.title}${s.detail ? ` · ${s.detail}` : ''}${s.maskedBy.length ? ` (masked by ${s.maskedBy.join(', ')})` : ''}${s.muted ? ' (muted)' : ''}`)
    }
  }
  if (!all) lines.push(`other rules (not listed above): ${list.filter(s => !LISTED.includes(s.rule)).length} signal(s) firing; --all for details`)
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k)
    return i > 0 ? process.argv[i + 1] : d
  }
  try {
    const list = await preview({ api: arg('--api', 'http://127.0.0.1:8088'), configPath: path.resolve(arg('--config', path.join(HERE, '..', '..', 'config.json'))) })
    console.log(render(list, { all: process.argv.includes('--all') }))
  } catch (e) {
    console.error(`✗ preview: ${e.message}`)
    process.exit(1)
  }
}

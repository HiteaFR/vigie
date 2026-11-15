// Update decisions taken from the UI ("ignore this version", postpone, pin the
// major version), with a mandatory reason. They are added to updates.ignore of
// config.json, which remains the source for durable decisions.
import { t as tr } from '../i18n.js'
const MODES = ['version', 'until', 'pin', 'all']

function validateDecision({ compId, mode, version, until, reason }, now = Date.now()) {
  if (!/^[\w.:/@+#-]{1,200}$/.test(String(compId || ''))) return tr('api.decision.bad_component')
  if (!MODES.includes(mode)) return tr('api.decision.bad_mode')
  if (mode === 'version' && !/^[\w.+~:-]{1,80}$/.test(String(version || ''))) return tr('api.decision.bad_version')
  if (mode === 'until') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(until || ''))) return tr('api.decision.bad_date_format')
    const t = Date.parse(until)
    if (!(t > now) || t > now + 400 * 86400_000) return tr('api.decision.bad_date')
  }
  const r = String(reason ?? '').trim()
  if (r.length < 3 || r.length > 200) return tr('api.reason_required')
  return null
}

export function createDecisions({ store, now = () => Date.now() }) {
  const { db } = store
  const q = {
    insert: db.prepare('INSERT INTO update_decisions (comp_id, version, until, pin, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    active: db.prepare('SELECT * FROM update_decisions WHERE removed_at IS NULL ORDER BY created_at'),
    get: db.prepare('SELECT * FROM update_decisions WHERE id = ?'),
    remove: db.prepare('UPDATE update_decisions SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL'),
  }
  const view = r => ({
    decisionId: r.id, id: r.comp_id, version: r.version ?? undefined, until: r.until ?? undefined,
    pin: r.pin ?? undefined, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at,
  })
  return {
    create({ compId, mode, version, until, reason, by }) {
      const err = validateDecision({ compId, mode, version, until, reason }, now())
      if (err) throw Object.assign(new Error(err), { status: 400 })
      const id = Number(q.insert.run(compId, mode === 'version' ? version : null, mode === 'until' ? until : null,
        mode === 'pin' ? 'major' : null, String(reason).trim(), by, now()).lastInsertRowid)
      return view(q.get.get(id))
    },
    remove(id, by) {
      const ok = q.remove.run(now(), by, id).changes > 0
      return ok ? view(q.get.get(id)) : null
    },
    active: () => q.active.all().map(view),
  }
}

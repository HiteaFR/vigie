// Persistent state (alerts, incidents, send queue) in SQLite, through the built-in
// node:sqlite module: no native dependency to compile on the container.
// In production, systemd provides STATE_DIRECTORY (for example /var/lib/vigie); never under the
// deployed tree, which a deployment overwrites (rsync --delete).
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY, rule TEXT NOT NULL, entity TEXT NOT NULL, state TEXT NOT NULL,
  severity TEXT NOT NULL, since INTEGER NOT NULL, fired_at INTEGER, last_notified INTEGER,
  notified INTEGER NOT NULL DEFAULT 0, flapping INTEGER NOT NULL DEFAULT 0,
  transitions TEXT NOT NULL DEFAULT '[]', incident_id INTEGER, payload TEXT
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, rule TEXT NOT NULL, entity TEXT NOT NULL,
  title TEXT, env TEXT, severity TEXT NOT NULL, started_at INTEGER NOT NULL,
  resolved_at INTEGER, summary TEXT, suppressed TEXT
);
CREATE INDEX IF NOT EXISTS ix_incidents_started ON incidents(started_at);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, key TEXT, kind TEXT NOT NULL,
  severity TEXT, text TEXT NOT NULL, silent INTEGER NOT NULL DEFAULT 0,
  deliver TEXT NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT, dropped TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(sent_at, deliver);
-- delivery per channel, for the channels other than Telegram (whose state stays in outbox);
-- an added table, nothing is moved: neither loss nor duplicate at the first start
CREATE TABLE IF NOT EXISTS outbox_delivery (
  outbox_id INTEGER NOT NULL, channel TEXT NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT, dropped TEXT, PRIMARY KEY (outbox_id, channel)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS http_cache (
  url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, body TEXT, fetched_at INTEGER NOT NULL, checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, latest TEXT, first_seen INTEGER NOT NULL, notified_latest TEXT, updated_at INTEGER NOT NULL
);
-- silences (reason required, end date or no end), admin sessions, action log, update
-- decisions taken from the UI or the bot
CREATE TABLE IF NOT EXISTS silences (
  id INTEGER PRIMARY KEY, matcher TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL,
  source TEXT NOT NULL, created_at INTEGER NOT NULL, ends_at INTEGER, ended_at INTEGER, ended_by TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT, source TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT, detail TEXT, ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit(at);
-- security fixes pending under automatic updates (unattended-upgrades); first_seen = first
-- observation WITH AUTOMATIC UPDATES ENABLED (age of the "stuck" state of security_updates)
CREATE TABLE IF NOT EXISTS apt_security_pending (
  host TEXT NOT NULL, name TEXT NOT NULL, version TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (host, name)
);
-- agent v8 memory: posture (already seen compliant, accepted deviation) and listening ports
CREATE TABLE IF NOT EXISTS host_posture (
  host TEXT NOT NULL, criterion TEXT NOT NULL, first_ok INTEGER, last_ok INTEGER,
  accepted_at INTEGER, accepted_by TEXT, accepted_reason TEXT,
  PRIMARY KEY (host, criterion)
);
CREATE TABLE IF NOT EXISTS host_ports (
  host TEXT NOT NULL, proto TEXT NOT NULL, port INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  closed_at INTEGER, known_at INTEGER, known_by TEXT, known_reason TEXT,
  PRIMARY KEY (host, proto, port)
);
CREATE TABLE IF NOT EXISTS update_decisions (
  id INTEGER PRIMARY KEY, comp_id TEXT NOT NULL, version TEXT, until TEXT, pin TEXT, reason TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT
);
`

// columns added later (existing databases): ack on incidents,
// incident and Telegram message on the send queue (bot buttons)
const COLUMNS = [
  ['incidents', 'ack_by', 'TEXT'], ['incidents', 'ack_reason', 'TEXT'], ['incidents', 'ack_at', 'INTEGER'],
  ['outbox', 'incident_id', 'INTEGER'],
]

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'dashboard.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;')
  db.exec(SCHEMA)
  for (const [table, col, type] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
  const getKv = db.prepare('SELECT v FROM kv WHERE k = ?')
  const setKv = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
  return {
    db,
    kv: {
      get: k => getKv.get(k)?.v ?? null,
      set: (k, v) => setKv.run(k, String(v)),
    },
    // nightly purge: incidents 400 d, send queue 30 d, HTTP cache 30 d
    purge(now = Date.now()) {
      db.prepare('DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?').run(now - 400 * 86400_000)
      db.prepare('DELETE FROM outbox WHERE (sent_at IS NOT NULL OR dropped IS NOT NULL) AND created_at < ?').run(now - 30 * 86400_000)
      db.prepare('DELETE FROM outbox_delivery WHERE outbox_id NOT IN (SELECT id FROM outbox)').run()
      // upstream responses no longer read (repository removed from the config) and vanished components
      db.prepare('DELETE FROM http_cache WHERE checked_at < ?').run(now - 30 * 86400_000)
      db.prepare('DELETE FROM versions WHERE updated_at < ?').run(now - 90 * 86400_000)
      // expired sessions, silences lifted for 90 d, audit log 400 d
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
      db.prepare('DELETE FROM silences WHERE COALESCE(ended_at, ends_at) < ?').run(now - 90 * 86400_000)
      db.prepare('DELETE FROM audit WHERE at < ?').run(now - 400 * 86400_000)
    },
  }
}

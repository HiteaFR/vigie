// Tables of the network module, created by the module at startup. Additive migrations
// only: CREATE … IF NOT EXISTS, then columns added afterwards through COLUMNS (same
// mechanism as db.js). Full schema from the start: net_sessions, net_presence_1h,
// net_mac_rules, net_links (except the link imported from NetAlertX) and net_ports start
// empty.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS net_devices (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'new',
  review INTEGER NOT NULL DEFAULT 0,
  name TEXT, type TEXT, icon TEXT, location TEXT, notes TEXT,
  profile TEXT,
  expected_ip TEXT,
  alert_down INTEGER NOT NULL DEFAULT 0,
  alert_severity TEXT,
  host_id TEXT, host_src TEXT,
  primary_mac TEXT, last_ip TEXT, vendor TEXT, disp_name TEXT, disp_type TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  last_dhcp INTEGER,
  online INTEGER,
  online_since INTEGER,
  acked_by TEXT, acked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
  origin TEXT
);
CREATE INDEX IF NOT EXISTS ix_nd_state ON net_devices(state);
CREATE INDEX IF NOT EXISTS ix_nd_host ON net_devices(host_id);
CREATE TABLE IF NOT EXISTS net_macs (
  mac TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  grade TEXT NOT NULL,
  random INTEGER NOT NULL DEFAULT 0,
  oui_vendor TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, last_ip TEXT
);
CREATE INDEX IF NOT EXISTS ix_nm_dev ON net_macs(device_id);
CREATE TABLE IF NOT EXISTS net_seen (
  mac TEXT NOT NULL, source TEXT NOT NULL, last_seen INTEGER NOT NULL, last_ip TEXT,
  PRIMARY KEY (mac, source)
);
CREATE TABLE IF NOT EXISTS net_addresses (
  mac TEXT NOT NULL, ip TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (mac, ip)
);
CREATE INDEX IF NOT EXISTS ix_na_ip ON net_addresses(ip, last_seen);
CREATE TABLE IF NOT EXISTS net_attrs (
  device_id INTEGER NOT NULL, attr TEXT NOT NULL, source TEXT NOT NULL,
  value TEXT NOT NULL, rank INTEGER NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, attr, source)
);
CREATE TABLE IF NOT EXISTS net_sessions (
  id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER, ip TEXT,
  origin TEXT NOT NULL DEFAULT 'scan'
);
CREATE INDEX IF NOT EXISTS ix_ns_dev ON net_sessions(device_id, start);
CREATE INDEX IF NOT EXISTS ix_ns_open ON net_sessions(end) WHERE end IS NULL;
CREATE TABLE IF NOT EXISTS net_presence_1h (
  hour INTEGER NOT NULL, device_id INTEGER NOT NULL, scans INTEGER NOT NULL, seen INTEGER NOT NULL,
  PRIMARY KEY (device_id, hour)
);
CREATE INDEX IF NOT EXISTS ix_np_hour ON net_presence_1h(hour);
CREATE TABLE IF NOT EXISTS net_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, device_id INTEGER, type TEXT NOT NULL,
  detail TEXT, actor TEXT
);
CREATE INDEX IF NOT EXISTS ix_ne_ts ON net_events(ts);
CREATE INDEX IF NOT EXISTS ix_ne_dev ON net_events(device_id, ts);
CREATE TABLE IF NOT EXISTS net_links (
  id INTEGER PRIMARY KEY,
  child TEXT NOT NULL, parent TEXT NOT NULL,
  kind TEXT NOT NULL,
  port TEXT, note TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER, removed_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nl_uplink ON net_links(child) WHERE removed_at IS NULL AND kind IN ('uplink','wifi','ethernet');
CREATE TABLE IF NOT EXISTS net_mac_rules (
  id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL,
  action TEXT NOT NULL,
  device_id INTEGER,
  reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  removed_at INTEGER, removed_by TEXT
);
CREATE TABLE IF NOT EXISTS net_runs (
  ts INTEGER NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER, n INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS ix_nr ON net_runs(source, ts);
CREATE TABLE IF NOT EXISTS net_tombstones (
  mac TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, device_id INTEGER, reason TEXT NOT NULL, deleted_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS net_ports (
  device_id INTEGER NOT NULL, proto TEXT NOT NULL, port INTEGER NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, closed_at INTEGER,
  service TEXT, confidence TEXT, cfg_service TEXT,
  PRIMARY KEY (device_id, proto, port)
);
`

// [table, column, type] added after the first version of the tables
const COLUMNS = [
  // provenance of a MAC attachment (name, ip, rule, pve, config, merge, detached; NULL = the
  // MAC created its record, or predates attachment tracking) and human confirmation
  ['net_macs', 'attach', 'TEXT'],
  ['net_macs', 'confirmed_by', 'TEXT'],
  ['net_macs', 'confirmed_at', 'INTEGER'],
  // DHCP name required by a MAC family (NULL = prefix alone)
  ['net_mac_rules', 'name', 'TEXT'],
  // last presence observation in the probe's sense (arp, neigh REACHABLE, self); last_seen
  // remains the freshness (Pi-hole included)
  ['net_devices', 'last_present', 'INTEGER'],
]

// tombstones of the deleted MACs. They only serve to DATE the deletion: a MAC is only
// recreated on a later presence observation (never a disguised "ignore"); one row per MAC,
// the last deletion

export function ensureSchema(db) {
  db.exec(SCHEMA)
  for (const [table, col, type] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
}

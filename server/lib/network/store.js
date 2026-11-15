// Persistence of the network module: prepared statements, loading of the snapshot,
// application of the writes computed by merge and by presence (one transaction per poll,
// like history.flush), reading of a record and of the history, purge.
// Cascading deletion with tombstones, id assigned explicitly (never reused), only the new
// and known states accepted, links entered on the map.
import { ensureSchema } from './schema.js'

const DAY = 86400_000
const HOUR = 3600_000

// net_devices columns an op can write (the names never come from an HTTP request)
const DEVICE_COLS = new Set([
  'state', 'review', 'name', 'type', 'icon', 'location', 'notes', 'profile', 'expected_ip', 'alert_down',
  'alert_severity', 'host_id', 'host_src', 'primary_mac', 'last_ip', 'vendor', 'disp_name', 'disp_type',
  'first_seen', 'last_seen', 'last_present', 'last_dhcp', 'online', 'online_since', 'acked_by', 'acked_at', 'created_at',
  'updated_at', 'updated_by', 'origin',
])
// no ignored or archived state; any other value is refused on write
const DEVICE_STATES = new Set(['new', 'known'])
const checkState = fields => {
  if ('state' in fields && !DEVICE_STATES.has(fields.state)) throw new Error(`device state refused: ${String(fields.state).slice(0, 20)}`)
}

export function createNetStore(store) {
  const { db, kv } = store
  ensureSchema(db)
  const q = {
    devices: db.prepare('SELECT * FROM net_devices'),
    device: db.prepare('SELECT * FROM net_devices WHERE id = ?'),
    macs: db.prepare('SELECT * FROM net_macs'),
    seen: db.prepare('SELECT * FROM net_seen'),
    attrs: db.prepare('SELECT * FROM net_attrs'),
    addresses: db.prepare('SELECT * FROM net_addresses'),
    // attach: set at creation (or by a write), never cleared by a poll
    upsertMac: db.prepare(`INSERT INTO net_macs (mac, device_id, grade, random, oui_vendor, first_seen, last_seen, last_ip, attach, confirmed_by, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mac) DO UPDATE SET device_id = excluded.device_id, grade = excluded.grade, random = excluded.random,
        oui_vendor = COALESCE(excluded.oui_vendor, oui_vendor), first_seen = MIN(first_seen, excluded.first_seen),
        last_seen = MAX(last_seen, excluded.last_seen), last_ip = COALESCE(excluded.last_ip, last_ip),
        attach = COALESCE(excluded.attach, attach),
        confirmed_by = COALESCE(confirmed_by, excluded.confirmed_by), confirmed_at = COALESCE(confirmed_at, excluded.confirmed_at)`),
    // last session of each device (the most recent by start)
    lastSessions: db.prepare(`SELECT s.* FROM net_sessions s
      JOIN (SELECT device_id, MAX(start) m FROM net_sessions GROUP BY device_id) x ON x.device_id = s.device_id AND x.m = s.start`),
    openSession: db.prepare('INSERT INTO net_sessions (device_id, start, end, ip, origin) VALUES (?, ?, NULL, ?, ?)'),
    hasSession: db.prepare('SELECT 1 FROM net_sessions WHERE device_id = ? AND start = ?'),
    closeSession: db.prepare('UPDATE net_sessions SET end = ? WHERE id = ? AND end IS NULL'),
    reopenSession: db.prepare('UPDATE net_sessions SET end = NULL WHERE id = ?'),
    rollup: db.prepare(`INSERT INTO net_presence_1h (hour, device_id, scans, seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, hour) DO UPDATE SET scans = scans + excluded.scans, seen = seen + excluded.seen`),
    bandRows: db.prepare('SELECT device_id, hour, scans, seen FROM net_presence_1h WHERE hour >= ?'),
    // CAST: node:sqlite binds JS numbers as REAL, the division would not be an integer one
    dailyOne: db.prepare(`SELECT CAST((hour - ?) / ? AS INTEGER) AS b, SUM(scans) scans, SUM(seen) seen
      FROM net_presence_1h WHERE device_id = ? AND hour >= ? GROUP BY b`),
    history: db.prepare(`SELECT hour, SUM(seen > 0) online, COUNT(*) known FROM net_presence_1h
      WHERE hour >= ? GROUP BY hour ORDER BY hour`),
    sessionsOf: db.prepare(`SELECT * FROM net_sessions WHERE device_id = ? AND (end IS NULL OR end >= ?)
      ORDER BY start DESC LIMIT 200`),
    // successful ARP sweeps (refRunsSince), reloaded at startup
    arpRuns: db.prepare("SELECT ts FROM net_runs WHERE source = 'arp' AND ok = 1 ORDER BY ts DESC LIMIT ?"),
    rules: db.prepare('SELECT * FROM net_mac_rules WHERE removed_at IS NULL ORDER BY id'),
    rule: db.prepare('SELECT * FROM net_mac_rules WHERE id = ?'),
    insertRule: db.prepare('INSERT INTO net_mac_rules (prefix, action, device_id, name, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    removeRule: db.prepare('UPDATE net_mac_rules SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL'),
    eventsSince: db.prepare('SELECT * FROM net_events WHERE type = ? AND ts >= ? ORDER BY ts'),
    // ports observed by the service probe (existing net_ports table)
    upsertPort: db.prepare(`INSERT INTO net_ports (device_id, proto, port, first_seen, last_seen, closed_at, service, confidence, cfg_service)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(device_id, proto, port) DO UPDATE SET last_seen = excluded.last_seen, closed_at = NULL,
        service = excluded.service, confidence = excluded.confidence, cfg_service = excluded.cfg_service`),
    closePort: db.prepare('UPDATE net_ports SET closed_at = ? WHERE device_id = ? AND proto = ? AND port = ? AND closed_at IS NULL'),
    portsOf: db.prepare('SELECT * FROM net_ports WHERE device_id = ? ORDER BY proto, port'),
    lastEvent: db.prepare('SELECT * FROM net_events WHERE device_id = ? AND type = ? ORDER BY ts DESC, id DESC LIMIT 1'),
    upsertSeen: db.prepare(`INSERT INTO net_seen (mac, source, last_seen, last_ip) VALUES (?, ?, ?, ?)
      ON CONFLICT(mac, source) DO UPDATE SET last_seen = excluded.last_seen, last_ip = excluded.last_ip`),
    upsertAddress: db.prepare(`INSERT INTO net_addresses (mac, ip, first_seen, last_seen, source) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mac, ip) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen),
        last_seen = MAX(last_seen, excluded.last_seen), source = excluded.source`),
    upsertAttr: db.prepare(`INSERT INTO net_attrs (device_id, attr, source, value, rank, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, attr, source) DO UPDATE SET value = excluded.value, rank = excluded.rank, seen_at = excluded.seen_at`),
    event: db.prepare('INSERT INTO net_events (ts, device_id, type, detail, actor) VALUES (?, ?, ?, ?, ?)'),
    // link entered by hand (NetAlertX import): a single active link per child, never replaced here
    hasLink: db.prepare('SELECT 1 FROM net_links WHERE child = ? AND removed_at IS NULL'),
    links: db.prepare('SELECT * FROM net_links WHERE removed_at IS NULL ORDER BY id'),
    linkById: db.prepare('SELECT * FROM net_links WHERE id = ?'),
    tombstones: db.prepare('SELECT * FROM net_tombstones'),
    tombstone: db.prepare(`INSERT INTO net_tombstones (mac, deleted_at, device_id, reason, deleted_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mac) DO UPDATE SET deleted_at = excluded.deleted_at, device_id = excluded.device_id, reason = excluded.reason, deleted_by = excluded.deleted_by`),
    untomb: db.prepare('DELETE FROM net_tombstones WHERE mac = ?'),
    maxId: db.prepare('SELECT MAX(id) m FROM net_devices'),
    link: db.prepare('INSERT INTO net_links (child, parent, kind, port, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    run: db.prepare('INSERT INTO net_runs (ts, source, ok, ms, n, error) VALUES (?, ?, ?, ?, ?, ?)'),
    runsSince: db.prepare('SELECT ts, source, ok, ms, n, error FROM net_runs WHERE ts >= ? ORDER BY ts'),
    // record
    macsOf: db.prepare('SELECT * FROM net_macs WHERE device_id = ? ORDER BY last_seen DESC'),
    addressesOf: db.prepare(`SELECT a.* FROM net_addresses a JOIN net_macs m ON m.mac = a.mac
      WHERE m.device_id = ? ORDER BY a.last_seen DESC LIMIT 50`),
    seenOf: db.prepare(`SELECT s.* FROM net_seen s JOIN net_macs m ON m.mac = s.mac WHERE m.device_id = ? ORDER BY s.last_seen DESC`),
    attrsOf: db.prepare('SELECT * FROM net_attrs WHERE device_id = ? ORDER BY attr, rank DESC, seen_at DESC'),
    deleteAttr: db.prepare('DELETE FROM net_attrs WHERE device_id = ? AND attr = ? AND source = ?'), // informative mDNS name removal
    eventsOf: db.prepare('SELECT * FROM net_events WHERE device_id = ? ORDER BY ts DESC, id DESC LIMIT 50'),
  }

  // one transaction at a time; a nested call joins the current transaction.
  // IMMEDIATE: the write lock is taken right away (busy_timeout from db.js), which avoids a
  // SQLITE_BUSY in the middle of the batch when the import and the service write together
  let depth = 0
  function transaction(fn) {
    if (depth) return fn()
    db.exec('BEGIN IMMEDIATE')
    depth++
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    } finally {
      depth--
    }
  }

  const deviceUpdates = new Map() // prepared statement per set of columns
  function updateDevice(id, fields) {
    checkState(fields)
    const cols = Object.keys(fields).filter(c => DEVICE_COLS.has(c)).sort()
    if (!cols.length) return
    const key = cols.join(',')
    if (!deviceUpdates.has(key)) deviceUpdates.set(key, db.prepare(`UPDATE net_devices SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`))
    deviceUpdates.get(key).run(...cols.map(c => fields[c] ?? null), id)
  }
  // explicit id: max(kv network.lastDeviceId, MAX(id)) + 1, key updated in the same
  // transaction; without AUTOINCREMENT, SQLite would reuse the id of a deleted record
  function insertDevice(fields) {
    checkState(fields)
    const id = Math.max(Number(kv.get('network.lastDeviceId')) || 0, Number(q.maxId.get().m) || 0) + 1
    const cols = Object.keys(fields).filter(c => DEVICE_COLS.has(c))
    db.prepare(`INSERT INTO net_devices (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(id, ...cols.map(c => fields[c] ?? null))
    kv.set('network.lastDeviceId', String(id))
    return id
  }

  // ops from merge and from the import, in one transaction (all or nothing);
  // "new:N" → id of the device inserted by a previous op of the same batch
  function applyOps(ops = []) {
    return transaction(() => {
      const refs = new Map()
      const dev = v => {
        if (typeof v !== 'string') return v
        if (!refs.has(v)) throw new Error(`unknown reference: ${v}`)
        return refs.get(v)
      }
      for (const o of ops) {
        switch (o.op) {
          case 'insertDevice': refs.set(o.ref, insertDevice(o.fields)); break
          case 'updateDevice': updateDevice(dev(o.device), o.fields); break
          case 'upsertMac': q.upsertMac.run(o.mac, dev(o.device), o.grade, o.random ? 1 : 0, o.oui_vendor ?? null, o.first_seen, o.last_seen, o.last_ip ?? null, o.attach ?? null, o.confirmed_by ?? null, o.confirmed_at ?? null); break
          case 'upsertSeen': q.upsertSeen.run(o.mac, o.source, o.last_seen, o.last_ip ?? null); break
          case 'upsertAddress': q.upsertAddress.run(o.mac, o.ip, o.first_seen ?? o.ts, o.ts, o.source); break
          case 'upsertAttr': q.upsertAttr.run(dev(o.device), o.attr, o.source, o.value, o.rank, o.seen_at); break
          case 'deleteAttr': q.deleteAttr.run(dev(o.device), o.attr, o.source); break
          case 'insertEvent': q.event.run(o.ts, o.device == null ? null : dev(o.device), o.type, o.detail ?? null, o.actor ?? null); break
          case 'insertLink': {
            const child = `dev:${dev(o.device)}`
            const parent = o.parentDevice != null ? `dev:${dev(o.parentDevice)}` : o.parent
            if (!q.hasLink.get(child)) q.link.run(child, parent, o.kind, o.port ?? null, o.note ?? null, o.by, o.ts)
            break
          }
          case 'run': q.run.run(o.ts, o.source, o.ok ? 1 : 0, o.ms ?? null, o.n ?? null, o.error ?? null); break
          // presence: one session per start, never duplicated
          case 'openSession': if (!q.hasSession.get(dev(o.device), o.start)) q.openSession.run(dev(o.device), o.start, o.ip ?? null, o.origin ?? 'scan'); break
          case 'closeSession': q.closeSession.run(o.end, o.id); break
          case 'reopenSession': q.reopenSession.run(o.id); break
          case 'rollup': q.rollup.run(o.hour, dev(o.device), o.scans ?? 1, o.seen); break
          // MAC back after a deletion (observation later than deleted_at)
          case 'removeTombstone': q.untomb.run(o.mac); break
          case 'upsertPort': q.upsertPort.run(dev(o.device), o.proto, o.port, o.ts, o.ts, o.service ?? null, o.confidence ?? null, o.cfg_service ?? null); break
          case 'closePort': q.closePort.run(o.ts, dev(o.device), o.proto, o.port); break
          default: throw new Error(`unknown op: ${o.op}`)
        }
      }
      return refs
    })
  }

  // full snapshot (a few hundred rows): basis of merge and of the view
  function load() {
    const attrs = new Map()
    for (const a of q.attrs.all()) {
      if (!attrs.has(a.device_id)) attrs.set(a.device_id, [])
      attrs.get(a.device_id).push(a)
    }
    return {
      devices: new Map(q.devices.all().map(d => [d.id, d])),
      macs: new Map(q.macs.all().map(m => [m.mac, m])),
      seen: new Map(q.seen.all().map(s => [`${s.mac}|${s.source}`, s])),
      attrs,
      addresses: new Map(q.addresses.all().map(a => [`${a.mac}|${a.ip}`, a])),
      rules: q.rules.all(),
      sessions: new Map(q.lastSessions.all().map(s => [s.device_id, s])),
      tombstones: new Map(q.tombstones.all().map(t => [t.mac, t])),
      links: q.links.all(),
    }
  }

  // presence bands: 24 one-hour cells (all records), or N days (one record);
  // cell: { scans, seen } or null (no sweep)
  function bands24h(now = Date.now()) {
    const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR
    const per = new Map()
    for (const r of q.bandRows.all(start)) {
      if (!per.has(r.device_id)) per.set(r.device_id, Array(24).fill(null))
      const i = Math.round((r.hour - start) / HOUR)
      if (i >= 0 && i < 24) per.get(r.device_id)[i] = r
    }
    return { start, size: HOUR, count: 24, per }
  }
  function daily(deviceId, days, now = Date.now()) {
    const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY
    const cells = Array(days).fill(null)
    for (const r of q.dailyOne.all(start, DAY, deviceId, start)) if (r.b >= 0 && r.b < days) cells[r.b] = r
    return { start, size: DAY, count: days, cells }
  }

  // --- human writes (lib/network/writes.js validates, this applies) --------------
  // each one within the caller's transaction (writes.js opens one per write)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const event = (device, type, detail, actor, ts) => q.event.run(ts, device, type, detail ?? null, actor ?? null)

  function setState(id, fields, { type, detail, actor, ts }) {
    updateDevice(id, { ...fields, updated_at: ts, updated_by: actor })
    if (type) event(id, type, detail, actor, ts)
  }
  function confirmMac(mac, { actor, ts }) {
    run('UPDATE net_macs SET confirmed_by = ?, confirmed_at = ? WHERE mac = ?', actor, ts, mac)
  }
  // MAC taken out of its record: new "new" record (origin detach), views and addresses follow the MAC
  function detachMac(mac, { actor, ts, fields }) {
    const id = insertDevice({ state: 'new', review: 0, origin: 'detach', created_at: ts, updated_at: ts, updated_by: actor, ...fields })
    run("UPDATE net_macs SET device_id = ?, attach = 'detached', confirmed_by = ?, confirmed_at = ? WHERE mac = ?", id, actor, ts, mac)
    event(id, 'detached', mac, actor, ts)
    return id
  }
  // merge: MACs (with their views and addresses), attributes missing from the target, events,
  // links, sessions, rollup and ports move to into; from is deleted.
  // "Already probed" marker (kv network.probed, set of record ids, see probe.js), reduced on
  // deletion and merge, within the caller's transaction
  function dropProbed(id) {
    let v
    try {
      v = JSON.parse(kv.get('network.probed') || '[]')
    } catch {
      v = []
    }
    if (Array.isArray(v) && v.includes(id)) kv.set('network.probed', JSON.stringify(v.filter(x => x !== id)))
  }
  function mergeDevice(into, from, { actor, ts }) {
    run("UPDATE net_macs SET device_id = ?, attach = 'merge', confirmed_by = ?, confirmed_at = ? WHERE device_id = ?", into, actor, ts, from)
    // the informative mdns_name of the absorbed record is not carried over
    run(`INSERT OR IGNORE INTO net_attrs (device_id, attr, source, value, rank, seen_at)
      SELECT ?, attr, source, value, rank, seen_at FROM net_attrs WHERE device_id = ? AND attr <> 'mdns_name'`, into, from)
    run('DELETE FROM net_attrs WHERE device_id = ?', from)
    for (const t of ['net_events', 'net_sessions']) run(`UPDATE ${t} SET device_id = ? WHERE device_id = ?`, into, from)
    run('INSERT OR IGNORE INTO net_presence_1h (hour, device_id, scans, seen) SELECT hour, ?, scans, seen FROM net_presence_1h WHERE device_id = ?', into, from)
    // port common to both records → first_seen = min, last_seen = max, closed_at (and service)
    // of the most recent row; a port only on the absorbed record moves to the target
    run(`UPDATE net_ports AS t SET first_seen = MIN(t.first_seen, s.first_seen), last_seen = MAX(t.last_seen, s.last_seen),
        closed_at = CASE WHEN s.last_seen > t.last_seen THEN s.closed_at ELSE t.closed_at END,
        service = CASE WHEN s.last_seen > t.last_seen THEN s.service ELSE t.service END,
        confidence = CASE WHEN s.last_seen > t.last_seen THEN s.confidence ELSE t.confidence END,
        cfg_service = CASE WHEN s.last_seen > t.last_seen THEN s.cfg_service ELSE t.cfg_service END
      FROM net_ports AS s WHERE t.device_id = ? AND s.device_id = ? AND s.proto = t.proto AND s.port = t.port`, into, from)
    run('INSERT OR IGNORE INTO net_ports SELECT ?, proto, port, first_seen, last_seen, closed_at, service, confidence, cfg_service FROM net_ports WHERE device_id = ?', into, from)
    for (const t of ['net_presence_1h', 'net_ports']) run(`DELETE FROM ${t} WHERE device_id = ?`, from)
    // a single active link per child: writes.merge refuses (409) if both records have one
    run('UPDATE net_links SET child = ? WHERE child = ?', `dev:${into}`, `dev:${from}`)
    run('UPDATE net_links SET parent = ? WHERE parent = ?', `dev:${into}`, `dev:${from}`)
    run('UPDATE net_mac_rules SET device_id = ? WHERE device_id = ?', into, from)
    dropProbed(from)
    run('DELETE FROM net_devices WHERE id = ?', from)
  }
  // deletion of a record, within the caller's transaction: cascade on what depends on it,
  // tombstone per MAC, events kept without a record (device_id NULL) plus a deleted event;
  // → { summary, macs }
  function deleteDevice(id, { actor, ts, reason }) {
    const d = q.device.get(id)
    if (!d) return null
    const macs = db.prepare('SELECT mac FROM net_macs WHERE device_id = ?').all(id).map(r => r.mac)
    const summary = `dev:${id} · ${d.disp_name ?? d.name ?? '?'} · ${d.primary_mac ?? '?'} · ${d.last_ip ?? '—'} · ${d.state}`
    for (const mac of macs) {
      run('DELETE FROM net_seen WHERE mac = ?', mac)
      run('DELETE FROM net_addresses WHERE mac = ?', mac)
      q.tombstone.run(mac, ts, id, reason, actor)
    }
    for (const t of ['net_macs', 'net_attrs', 'net_sessions', 'net_presence_1h', 'net_ports']) run(`DELETE FROM ${t} WHERE device_id = ?`, id)
    run('UPDATE net_events SET device_id = NULL WHERE device_id = ?', id)
    event(null, 'deleted', `${summary} — ${reason}`, actor, ts)
    run('DELETE FROM net_links WHERE child = ? OR parent = ?', `dev:${id}`, `dev:${id}`)
    run('DELETE FROM net_mac_rules WHERE device_id = ?', id)
    // lists of ids in kv
    const found = JSON.parse(kv.get('network.arpDiscovered') || '[]')
    if (found.includes(id)) kv.set('network.arpDiscovered', JSON.stringify(found.filter(x => x !== id)))
    dropProbed(id)
    run('DELETE FROM net_devices WHERE id = ?', id)
    return { summary, macs }
  }

  // clean rollback, attributes of a source deleted (mdns disabled at startup) → ids of the
  // affected records (their displayed names must be recomputed)
  function deleteAttrsBySource(source) {
    return transaction(() => {
      const ids = db.prepare('SELECT DISTINCT device_id FROM net_attrs WHERE source = ?').all(source).map(r => r.device_id)
      run('DELETE FROM net_attrs WHERE source = ?', source)
      return ids
    })
  }

  // links entered on the map, within the caller's transaction
  function insertLink({ child, parent, kind, port = null, note = null }, { actor, ts }) {
    return Number(q.link.run(child, parent, kind, port, note, actor, ts).lastInsertRowid)
  }
  const removeLink = (id, { actor, ts }) => run('UPDATE net_links SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL', ts, actor, id).changes > 0

  function insertRule(r, { actor, ts }) {
    return Number(q.insertRule.run(r.prefix, r.action, r.device_id ?? null, r.name ?? null, r.reason, actor, ts).lastInsertRowid)
  }
  const removeRule = (id, { actor, ts }) => q.removeRule.run(ts, actor, id).changes > 0

  function detail(id, now = Date.now()) {
    const d = q.device.get(id)
    if (!d) return null
    return {
      device: d,
      macs: q.macsOf.all(id),
      seen: q.seenOf.all(id),
      addresses: q.addressesOf.all(id),
      attrs: q.attrsOf.all(id),
      events: q.eventsOf.all(id),
      sessions: q.sessionsOf.all(id, now - 30 * DAY),
    }
  }

  // retention, in one transaction; tables that started empty already have their rule
  function purge(now = Date.now()) {
    const old = now - 400 * DAY
    const run = (sql, ...args) => db.prepare(sql).run(...args)
    transaction(() => {
      // tombstones older than 400 days (there is no archived record any more)
      run('DELETE FROM net_tombstones WHERE deleted_at < ?', old)
      // MAC silent for 400 days, except the last one of its record
      // (ties broken by rowid: two silent MACs do not validate each other)
      run(`DELETE FROM net_macs WHERE last_seen < ? AND EXISTS (
        SELECT 1 FROM net_macs o WHERE o.device_id = net_macs.device_id
          AND (o.last_seen > net_macs.last_seen OR (o.last_seen = net_macs.last_seen AND o.rowid > net_macs.rowid)))`, old)
      run('DELETE FROM net_seen WHERE last_seen < ? OR mac NOT IN (SELECT mac FROM net_macs)', old)
      run('DELETE FROM net_addresses WHERE last_seen < ?', old)
      run('DELETE FROM net_attrs WHERE seen_at < ?', old)
      run('DELETE FROM net_events WHERE ts < ?', old)
      run('DELETE FROM net_runs WHERE ts < ?', now - 7 * DAY)
      run('DELETE FROM net_sessions WHERE end IS NOT NULL AND end < ?', old)
      run('DELETE FROM net_presence_1h WHERE hour < ?', now - 90 * DAY)
      run('DELETE FROM net_ports WHERE closed_at IS NOT NULL AND closed_at < ?', now - 90 * DAY)
      run('DELETE FROM net_mac_rules WHERE removed_at IS NOT NULL AND removed_at < ?', old)
      run('DELETE FROM net_links WHERE removed_at IS NOT NULL AND removed_at < ?', old)
    })
  }

  return {
    db, load, applyOps, transaction, purge, detail, bands24h, daily,
    history: since => q.history.all(since),
    arpRuns: (n = 200) => q.arpRuns.all(n).map(r => r.ts).reverse(),
    setState, confirmMac, detachMac, mergeDevice, insertRule, removeRule, event, deleteDevice, insertLink, removeLink, deleteAttrsBySource,
    rule: id => q.rule.get(id) ?? null,
    link: id => q.linkById.get(id) ?? null,
    activeLink: id => db.prepare('SELECT * FROM net_links WHERE child = ? AND removed_at IS NULL').get(`dev:${id}`) ?? null,
    eventsSince: (type, since) => q.eventsSince.all(type, since),
    portsOf: id => q.portsOf.all(id),
    lastEvent: (id, type) => q.lastEvent.get(id, type) ?? null,
    runsSince: since => q.runsSince.all(since),
    device: id => q.device.get(id) ?? null,
  }
}

// Probe history: each result is written raw (8 days) and aggregated
// per hour (400 days) in the same transaction. Writes are batched
// every 15 s to limit fsyncs. Reading: uptime bars (slots of
// 30 min over 24 h, or of one day over 30/90 d), percentages and latencies.
const RAW_DAYS = 8
const ROLLUP_DAYS = 400
const HOUR = 3600_000

export function createHistory(store, monitor) {
  const { db } = store
  db.exec(`
    CREATE TABLE IF NOT EXISTS check_results (
      ts INTEGER NOT NULL, check_id TEXT NOT NULL, state TEXT NOT NULL,
      latency_ms INTEGER, code TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_cr ON check_results(check_id, ts);
    CREATE INDEX IF NOT EXISTS ix_cr_ts ON check_results(ts);
    CREATE TABLE IF NOT EXISTS check_rollup_1h (
      hour INTEGER NOT NULL, check_id TEXT NOT NULL, n INTEGER NOT NULL, n_fail INTEGER NOT NULL,
      n_warn INTEGER NOT NULL, lat_sum INTEGER NOT NULL, lat_n INTEGER NOT NULL, lat_max INTEGER,
      PRIMARY KEY (check_id, hour)
    );
  `)
  const q = {
    raw: db.prepare('INSERT INTO check_results (ts, check_id, state, latency_ms, code, error) VALUES (?, ?, ?, ?, ?, ?)'),
    rollup: db.prepare(`INSERT INTO check_rollup_1h (hour, check_id, n, n_fail, n_warn, lat_sum, lat_n, lat_max)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, hour) DO UPDATE SET n = n + 1, n_fail = n_fail + excluded.n_fail,
        n_warn = n_warn + excluded.n_warn, lat_sum = lat_sum + excluded.lat_sum, lat_n = lat_n + excluded.lat_n,
        lat_max = MAX(COALESCE(lat_max, 0), COALESCE(excluded.lat_max, 0))`),
    // 30-min slots over 24 h, all probes combined
    // CAST: node:sqlite binds JS numbers as REAL, the division would not be an integer one
    buckets: db.prepare(`SELECT check_id, CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(*) n,
        SUM(state = 'crit') n_fail, SUM(state = 'warn') n_warn
      FROM check_results WHERE ts >= ? GROUP BY check_id, b`),
    daily: db.prepare(`SELECT check_id, CAST((hour - ?) / ? AS INTEGER) AS b, SUM(n) n, SUM(n_fail) n_fail, SUM(n_warn) n_warn
      FROM check_rollup_1h WHERE hour >= ? GROUP BY check_id, b`),
    rawOne: db.prepare(`SELECT ts, state, latency_ms, code, error FROM check_results
      WHERE check_id = ? AND ts >= ? ORDER BY ts`),
    rollOne: db.prepare(`SELECT hour, n, n_fail, n_warn, lat_sum, lat_n, lat_max FROM check_rollup_1h
      WHERE check_id = ? AND hour >= ? ORDER BY hour`),
    purgeRaw: db.prepare('DELETE FROM check_results WHERE ts < ?'),
    purgeRoll: db.prepare('DELETE FROM check_rollup_1h WHERE hour < ?'),
    oldest: db.prepare('SELECT MIN(hour) t FROM check_rollup_1h'),
  }

  const pending = []
  monitor.onResult((check, r) => {
    pending.push([Date.parse(r.checkedAt), check.id, r.state, r.latencyMs ?? null, r.code == null ? null : String(r.code), r.error ?? null])
  })

  function flush() {
    if (!pending.length) return
    const rows = pending.splice(0)
    db.exec('BEGIN')
    try {
      for (const [ts, id, state, lat, code, err] of rows) {
        q.raw.run(ts, id, state, lat, code, err)
        const ok = state !== 'crit' && state !== 'unknown'
        q.rollup.run(Math.floor(ts / HOUR) * HOUR, id, state === 'crit' ? 1 : 0, state === 'warn' ? 1 : 0,
          ok && lat != null ? lat : 0, ok && lat != null ? 1 : 0, ok ? lat : null)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  function purge(now = Date.now()) {
    q.purgeRaw.run(now - RAW_DAYS * 86400_000)
    q.purgeRoll.run(now - ROLLUP_DAYS * 86400_000)
  }

  // state of a slot: '-' no measurement, 'o' all good, 'w' degraded or partial
  // failures, 'c' all failed
  const cell = (n, fail, warn) => (!n ? '-' : fail === n ? 'c' : fail || warn ? 'w' : 'o')

  // bars of all probes: 24 h (48 × 30 min) or N days (one-day slots)
  let bandCache = { key: null, t: 0, v: null }
  function bands(range = '24h', now = Date.now()) {
    const key = range
    if (bandCache.key === key && now - bandCache.t < 60_000) return bandCache.v
    let size, count, start, rows
    if (range === '24h') {
      size = 30 * 60_000
      count = 48
      start = Math.floor(now / size) * size - (count - 1) * size
      rows = q.buckets.all(start, size, start)
    } else {
      const days = range === '90d' ? 90 : range === '7d' ? 7 : 30
      size = 86400_000
      count = days
      // days aligned on UTC midnight: enough for a bar of 30/90 slots
      start = Math.floor(now / size) * size - (count - 1) * size
      rows = q.daily.all(start, size, start)
    }
    const per = new Map()
    for (const r of rows) {
      if (!per.has(r.check_id)) per.set(r.check_id, { cells: Array(count).fill(null), n: 0, fail: 0 })
      const p = per.get(r.check_id)
      if (r.b >= 0 && r.b < count) p.cells[r.b] = r
      p.n += r.n
      p.fail += r.n_fail
    }
    const out = {}
    for (const [id, p] of per) {
      out[id] = {
        band: p.cells.map(c => (c ? cell(c.n, c.n_fail, c.n_warn) : '-')).join(''),
        uptime: p.n ? Math.round((1 - p.fail / p.n) * 10000) / 100 : null,
        samples: p.n,
      }
    }
    const v = { range, start, size, count, checks: out }
    bandCache = { key, t: now, v }
    return v
  }

  // detail of a probe: raw points (24 h) or hourly ones (7/30/90 d)
  function series(checkId, range = '24h', now = Date.now()) {
    if (range === '24h') {
      const rows = q.rawOne.all(checkId, now - 24 * HOUR)
      // reduced to 10-min slots for a readable curve
      const size = 10 * 60_000
      const map = new Map()
      for (const r of rows) {
        const b = Math.floor(r.ts / size) * size
        const m = map.get(b) || { t: b, n: 0, fail: 0, latSum: 0, latN: 0, latMax: 0 }
        m.n++
        if (r.state === 'crit') m.fail++
        else if (r.latency_ms != null) {
          m.latSum += r.latency_ms
          m.latN++
          m.latMax = Math.max(m.latMax, r.latency_ms)
        }
        map.set(b, m)
      }
      const last = rows.filter(r => r.state === 'crit').slice(-5).reverse()
      return {
        points: [...map.values()].map(m => ({ t: m.t, up: 1 - m.fail / m.n, lat: m.latN ? Math.round(m.latSum / m.latN) : null, latMax: m.latN ? m.latMax : null })),
        failures: last.map(r => ({ t: r.ts, code: r.code, error: r.error })),
      }
    }
    const days = range === '90d' ? 90 : range === '7d' ? 7 : 30
    const rows = q.rollOne.all(checkId, now - days * 86400_000)
    return {
      points: rows.map(r => ({ t: r.hour, up: 1 - r.n_fail / r.n, lat: r.lat_n ? Math.round(r.lat_sum / r.lat_n) : null, latMax: r.lat_max })),
      failures: [],
    }
  }

  return {
    flush,
    purge,
    bands,
    series,
    since: () => q.oldest.get()?.t ?? null,
  }
}

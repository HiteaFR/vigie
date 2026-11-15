// A single "time ago" function (ago, client/src/lib/format.js). The
// outputs are those of the three functions from BEFORE the merge (recorded on 35c8ec7 with the same clock):
// TimeAgo.since (seconds format), format.ago (default), agent.since (bare format, plus its "—" guard).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ago } from '../../client/src/lib/format.js'
import { since as agentSince } from '../../client/src/lib/agent.js'
import { loadLocale } from '../../client/src/i18n/index.js'

// fr catalogue loaded before the client labels (in the browser: main.jsx, before rendering)
await loadLocale('fr')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = f => fs.readFileSync(path.join(ROOT, 'client/src', f), 'utf8')
const NOW = Date.parse('2026-10-28T12:00:00.000Z')
// [offset in ms, TimeAgo.since, format.ago(iso), format.ago(ms), agent.since(iso)] recorded before the merge
const TABLE = [[-5000, "à l'instant", "à l'instant", "à l'instant", '1 min'], [0, "à l'instant", "à l'instant", "à l'instant", '1 min'], [3000, "à l'instant", "à l'instant", "à l'instant", '1 min'], [4400, "à l'instant", "à l'instant", "à l'instant", '1 min'], [4600, 'il y a 5 s', "à l'instant", "à l'instant", '1 min'], [30000, 'il y a 30 s', "à l'instant", "à l'instant", '1 min'], [59400, 'il y a 59 s', "à l'instant", "à l'instant", '1 min'], [59600, 'il y a 1 min', "à l'instant", "à l'instant", '1 min'], [60000, 'il y a 1 min', 'il y a 1 min', 'il y a 1 min', '1 min'], [61000, 'il y a 1 min', 'il y a 1 min', 'il y a 1 min', '1 min'], [119400, 'il y a 1 min', 'il y a 1 min', 'il y a 1 min', '1 min'], [119600, 'il y a 2 min', 'il y a 1 min', 'il y a 1 min', '1 min'], [120000, 'il y a 2 min', 'il y a 2 min', 'il y a 2 min', '2 min'], [3599000, 'il y a 59 min', 'il y a 59 min', 'il y a 59 min', '59 min'], [3599600, 'il y a 1 h', 'il y a 59 min', 'il y a 59 min', '59 min'], [3600000, 'il y a 1 h', 'il y a 1 h', 'il y a 1 h', '1 h'], [7199000, 'il y a 1 h', 'il y a 1 h', 'il y a 1 h', '1 h'], [86399000, 'il y a 23 h', 'il y a 23 h', 'il y a 23 h', '23 h'], [86399600, 'il y a 1 j', 'il y a 23 h', 'il y a 23 h', '23 h'], [86400000, 'il y a 1 j', 'il y a 1 j', 'il y a 1 j', '1 j'], [259205000, 'il y a 3 j', 'il y a 3 j', 'il y a 3 j', '3 j']]

function withClock(fn) {
  const real = Date.now
  Date.now = () => NOW
  try {
    fn()
  } finally {
    Date.now = real
  }
}

test('ago: each former format, identical, over 21 offsets (rounding boundaries included)', () => withClock(() => {
  for (const [off, timeAgo, agoIso, agoMs, agent] of TABLE) {
    const t = NOW - off
    assert.equal(ago(t, { seconds: true }), timeAgo, `seconds ${off}`)
    assert.equal(ago(new Date(t).toISOString()), agoIso, `default iso ${off}`)
    assert.equal(ago(t), agoMs, `default ms ${off}`)
    assert.equal(agentSince(new Date(t).toISOString()), agent, `agent ${off}`)
    assert.equal(ago(t, { bare: true }), agent, `bare ${off}`)
  }
}))

test('ago: empty and invalid cases as before (default → "", agent → "—", seconds without guard)', () => withClock(() => {
  for (const v of ['', null, undefined, 0]) assert.equal(ago(v), '', String(v))
  for (const v of ['', '1999-12-31T23:59:59Z', 'pas une date', '0001-01-01T00:00:00Z']) assert.equal(agentSince(v), '—', v)
  // TimeAgo.since had no guard (the component never calls it without a date): same computation
  assert.equal(ago(NaN, { seconds: true }), 'il y a NaN j')
}))

test('static: a single "time ago" function (lib/format.js), used by lib/agent.js, ui/TimeAgo.jsx and lib/deviceTypes.js; components renamed', () => {
  const all = fs.readdirSync(path.join(ROOT, 'client/src'), { recursive: true }).filter(f => /\.(jsx?|mjs)$/.test(f))
  // "il y a" (time ago) from the catalogue (time.ago_*), read by lib/format.js only
  const withIlYa = all.filter(f => /`il y a \$\{|`\$\{pre\}\$\{|time\.ago_/.test(SRC(f)))
  assert.deepEqual(withIlYa, [path.join('lib', 'format.js')])
  assert.doesNotMatch(SRC('lib/format.js').replace(/\/\/[^\n]*/g, ''), /il y a/, 'format.js: "ago" through the catalog')
  assert.match(SRC('lib/agent.js'), /^import \{ ago \} from '\.\/format\.js'$/m)
  assert.match(SRC('lib/agent.js'), /return ago\(t, \{ bare: true \}\)/)
  assert.match(SRC('ui/TimeAgo.jsx'), /\{ago\(ts, \{ seconds: true \}\)\}/)
  assert.doesNotMatch(SRC('ui/TimeAgo.jsx'), /export function since/)
  assert.equal((SRC('lib/deviceTypes.js').match(/ago\(Date\.parse\(d\.last(Seen|Present)\), \{ seconds: true \}\)/g) || []).length, 2)
  for (const [f, g] of [['components/InfraGrid.jsx', 'views/Infra.jsx'], ['components/BackupsGrid.jsx', 'views/Backups.jsx']]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'client/src', f)), f)
    assert.match(SRC(g), new RegExp(`from '\\.\\./${f.replace('.', '\\.')}'`))
  }
  for (const f of ['components/Infra.jsx', 'components/Backups.jsx']) assert.equal(fs.existsSync(path.join(ROOT, 'client/src', f)), false, f)
})

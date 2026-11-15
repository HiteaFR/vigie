// Local time (Europe/Paris by default) for quiet hours, business
// hours, the digest and maintenance windows. The container may run in UTC:
// the system time zone is never trusted.
// MACHINE format (local time split into fields, weekday read through WEEKDAY), fixed and
// independent of the instance language: a digest date kept in the database (digest.last) or a
// quiet hours window must not change with the locale
import { t as tr } from './i18n.js'
const MACHINE_LOCALE = 'en-US'
const formatters = new Map()
function parts(ts, tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat(MACHINE_LOCALE, {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }))
  }
  const o = {}
  for (const p of formatters.get(tz).formatToParts(new Date(ts))) o[p.type] = p.value
  return o
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const toMin = hhmm => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function createClock(tz = 'Europe/Paris') {
  const local = ts => {
    const p = parts(ts, tz)
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      dm: `${p.day}/${p.month}`,
      hm: `${p.hour}:${p.minute}`,
      minutes: Number(p.hour) * 60 + Number(p.minute),
      weekday: WEEKDAY[p.weekday] ?? 0,
    }
  }
  // window [start, end[ in local time, which may cross midnight (23:00 → 07:30)
  const inWindow = (ts, { start, end, days }) => {
    const l = local(ts)
    const s = toMin(start), e = toMin(end)
    const inside = s <= e ? l.minutes >= s && l.minutes < e : l.minutes >= s || l.minutes < e
    if (!inside) return false
    if (!days?.length) return true
    // a window that crosses midnight belongs to the day it starts
    const day = s > e && l.minutes < e ? ((l.weekday + 5) % 7) + 1 : l.weekday
    return days.includes(day)
  }
  return { local, inWindow, hm: ts => local(ts).hm, tz }
}

// units in the instance locale (catalog: time.*)
export const fmtDuration = ms => {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return tr('time.minutes', { n: m })
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? tr('time.hours_minutes', { h, mm: String(m % 60).padStart(2, '0') }) : tr('time.hours', { h })
  return tr('time.days', { d: Math.floor(h / 24) })
}

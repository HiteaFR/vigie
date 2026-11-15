// Weather (lib/weather.js) with a FAKE fetch and a manual timer: no request to
// Open-Meteo. Request parameters, data read, WMO label, errors (HTTP, network) that keep the
// last data, 2 s then 15 min rhythm; inert module without config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWeather } from '../lib/weather.js'

const T = Date.parse('2026-10-28T10:00:00Z')
const CONF = { label: 'Ville factice', lat: 48.85, lon: 2.35 }
const BODY = {
  current: { temperature_2m: 12.3, apparent_temperature: 10.1, weather_code: 61, wind_speed_10m: 14.5, is_day: 1 },
  daily: { temperature_2m_max: [15.2], temperature_2m_min: [8.4], precipitation_probability_max: [70] },
}
function bench(replies) {
  const calls = []
  const timers = []
  let now = T
  const fetch = async (url, init) => {
    calls.push({ url: String(url), signal: init.signal })
    const r = replies.shift()
    if (r instanceof Error) throw r
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 })
  }
  const w = createWeather(CONF, { fetch, setTimer: (fn, ms) => timers.push({ fn, ms }), now: () => now })
  const fire = async () => {
    const t = timers.shift()
    await t.fn()
    return t.ms
  }
  return { w, calls, timers, fire, tick: ms => { now += ms } }
}

test('weather without config: get() → null, start() schedules nothing', () => {
  const w = createWeather(undefined, { setTimer: () => assert.fail('no timer'), fetch: () => assert.fail('no request') })
  assert.equal(w.get(), null)
  w.start()
})

test('weather: first reading 2 s after start, complete Open-Meteo request, data and WMO label; then every 15 min', async () => {
  const b = bench([{ json: BODY }, { json: { ...BODY, current: { ...BODY.current, weather_code: 999, is_day: 0 } } }])
  assert.deepEqual(b.w.get(), { data: null, error: null, at: null })
  b.w.start()
  assert.equal(b.calls.length, 0)
  assert.equal(await b.fire(), 2000)
  const u = new URL(b.calls[0].url)
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast')
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    latitude: '48.85', longitude: '2.35', timezone: 'Europe/Paris',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max', forecast_days: '1',
  })
  assert.ok(b.calls[0].signal instanceof AbortSignal)
  assert.deepEqual(b.w.get(), {
    data: { label: 'Ville factice', temp: 12.3, feels: 10.1, code: 61, text: 'Pluie faible', isDay: true, wind: 14.5, min: 8.4, max: 15.2, rain: 70 },
    error: null, at: T,
  })
  assert.deepEqual(b.timers.map(t => t.ms), [15 * 60_000])
  b.tick(15 * 60_000)
  await b.fire()
  assert.deepEqual([b.w.get().data.code, b.w.get().data.text, b.w.get().data.isDay, b.w.get().at], [999, null, false, T + 15 * 60_000])
  assert.deepEqual(b.timers.map(t => t.ms), [15 * 60_000])
})

test('weather errors: HTTP 503 or network → error set, last data kept, next reading scheduled; partial response → fields set to null', async () => {
  const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  const b = bench([{ json: BODY }, { status: 503 }, net, { json: {} }])
  b.w.start()
  await b.fire()
  const data = b.w.get().data
  b.tick(1000)
  await b.fire()
  assert.deepEqual(b.w.get(), { data, error: 'Open-Meteo 503', at: T + 1000 })
  await b.fire()
  assert.deepEqual([b.w.get().data, b.w.get().error], [data, 'ENOTFOUND'])
  assert.equal(b.timers.length, 1, 'always a poll scheduled')
  await b.fire()
  assert.deepEqual(b.w.get().data, { label: 'Ville factice', temp: null, feels: null, code: null, text: null, isDay: false, wind: null, min: null, max: null, rain: null })
  assert.equal(b.w.get().error, null)
})

test('weather: timezone from the config passed on', async () => {
  const calls = []
  const timers = []
  const w = createWeather({ ...CONF, timezone: 'America/Montreal' }, { fetch: async u => { calls.push(String(u)); return new Response('{}') }, setTimer: fn => timers.push(fn) })
  w.start()
  await timers.shift()()
  assert.equal(new URL(calls[0]).searchParams.get('timezone'), 'America/Montreal')
})

// Weather (inspired by the Open-Meteo widget of Homepage, no code reused): public API without key,
// queried every 15 min on the server side; the browser never goes out.
import { fetch as uFetch } from 'undici'
import { withUserAgent } from './http.js'
import { t as tr } from './i18n.js'

// WMO codes → short label (catalog weather.wmo.<code>)
const WMO = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99])

// fetch, timer and clock injectable (tests); production defaults
export function createWeather(conf, { fetch = uFetch, setTimer = setTimeout, now = () => Date.now() } = {}) {
  let state = { data: null, error: null, at: null }
  if (!conf) return { get: () => null, start() {} }
  async function run() {
    try {
      const u = new URL('https://api.open-meteo.com/v1/forecast')
      u.search = new URLSearchParams({
        latitude: conf.lat, longitude: conf.lon, timezone: conf.timezone ?? 'Europe/Paris',
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        forecast_days: '1',
      })
      const r = await fetch(u, { headers: withUserAgent(), signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`)
      const j = await r.json()
      state = {
        data: {
          label: conf.label,
          temp: j.current?.temperature_2m ?? null,
          feels: j.current?.apparent_temperature ?? null,
          code: j.current?.weather_code ?? null,
          text: WMO.has(j.current?.weather_code) ? tr(`weather.wmo.${j.current.weather_code}`) : null,
          isDay: !!j.current?.is_day,
          wind: j.current?.wind_speed_10m ?? null,
          min: j.daily?.temperature_2m_min?.[0] ?? null,
          max: j.daily?.temperature_2m_max?.[0] ?? null,
          rain: j.daily?.precipitation_probability_max?.[0] ?? null,
        },
        error: null,
        at: now(),
      }
    } catch (e) {
      state = { ...state, error: String(e?.cause?.code || e.message || e), at: now() }
    } finally {
      setTimer(run, 15 * 60_000)
    }
  }
  return { get: () => state, start: () => setTimer(run, 2000) }
}

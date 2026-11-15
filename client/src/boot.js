// Client startup, without React or DOM (run as is by the tests).
// 1. /api/config, bounded by CONFIG_TIMEOUT_MS: the answer gives the instance locale and serves
//    as the cache of useSource('config'); failure, timeout or unreadable answer: default locale.
// 2. Catalog of the locale (separate chunk); if it does not load, or if /api/config did not answer,
//    the last locale this browser knew, then the product default locale (en), then, as a last
//    resort, a minimal message instead of a blank page.
// 3. First render only with a loaded catalog (no screen full of keys).
import { DEFAULT_LOCALE, LOCALES } from './i18n/index.js'

// Last instance locale seen by this browser, written on every successful /api/config, read only
// as a fallback (transient outage: a French instance stays in French). Storage missing, blocked
// or in private mode: every access is guarded, and we fall back to the default locale
export const LOCALE_KEY = 'vigie.locale'
function remember(storage, l) {
  try {
    storage?.setItem(LOCALE_KEY, l)
  } catch { /* storage unavailable */ }
}
function remembered(storage) {
  try {
    const l = storage?.getItem(LOCALE_KEY)
    return LOCALES.includes(l) ? l : null // unknown value (older version, manual edit): ignored
  } catch {
    return null
  }
}
const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // the access itself may throw (cookies blocked)
  }
}

export const CONFIG_TIMEOUT_MS = 4000
// last resort, without a catalog (it could not load): bilingual, hard-coded, a named exception of
// the client guard (i18n-client-guard.test.js)
export const FATAL_TEXT = 'Impossible de charger l\'interface : rechargez la page. · The interface could not be loaded: reload the page.'

async function readConfig(fetchImpl, timeoutMs) {
  try {
    const r = await fetchImpl('/api/config', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const config = await r.json()
    return config && typeof config === 'object' ? config : null
  } catch {
    return null
  }
}

// i18n: { loadLocale, loadedLocales }; onConfig(config): cache of the config read; render(): first
// render; fail(): last-resort message. Never rejects. → 'rendered' or 'failed'
// storage: the browser's localStorage (replaceable by a test)
export async function boot({ fetchImpl, i18n, onConfig = () => {}, render, fail, timeoutMs = CONFIG_TIMEOUT_MS, storage = defaultStorage() }) {
  const config = await readConfig(fetchImpl, timeoutMs)
  if (config) onConfig(config)
  const own = LOCALES.includes(config?.locale) ? config.locale : null
  if (own) remember(storage, own)
  // config locale; only as a fallback (no answer from /api/config, or its locale's catalog not
  // found) the last one this browser knew, read at that moment; then the default locale.
  // A config that answers without a known locale means the default locale: the memory plays no part
  const candidates = function* () {
    if (own) yield own
    if (!config || own) {
      const last = remembered(storage)
      if (last) yield last
    }
    yield DEFAULT_LOCALE
  }
  const tried = new Set()
  for (const l of candidates()) {
    if (tried.has(l)) continue
    tried.add(l)
    try {
      await i18n.loadLocale(l)
    } catch {
      continue // chunk not found (new version deployed, network): next locale
    }
    if (i18n.loadedLocales().includes(l)) {
      try {
        render()
        return 'rendered'
      } catch {
        break // render impossible: the last-resort message rather than a blank page
      }
    }
  }
  fail()
  return 'failed'
}

// last-resort message in the root element (no framework: nothing else could load)
export function showFatal(root) {
  root.setAttribute('role', 'alert')
  root.textContent = FATAL_TEXT
}

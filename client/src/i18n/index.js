// Translation and formats in the INSTANCE locale, client side (same catalog format as the
// server: flat keys, {name}, plural { one, other }). The locale comes from /api/config (setLocale,
// App.jsx); default en (product locale) until the answer arrives, or if it never does. Formats
// read the instance locale, not the browser's (consistent with Telegram and the widgets,
// formatted server side). Missing key: falls back to English, then to the key; strict (tests,
// setStrict): error.
// Each catalog is a separate chunk (no text in the main bundle: texts of lazy views do not
// bubble up into it), loaded before the first render (main.jsx: loadLocale after /api/config;
// tests: client-render.js). Plugin catalogs (registerCatalog) are added under their id:
// "<id>.<key>".

export const LOCALES = Object.freeze(['fr', 'en'])
export const DEFAULT_LOCALE = 'en'
const TAGS = { fr: 'fr-FR', en: 'en-GB' }
const LOADERS = {
  fr: () => import('./fr.json', { with: { type: 'json' } }),
  en: () => import('./en.json', { with: { type: 'json' } }),
}
const CATALOGS = {}
const PLUGIN_CATALOGS = []

let current = DEFAULT_LOCALE
// strict: key missing from the current locale → error; on by default under node --test (like the
// server), never in the browser (process does not exist there)
let strict = !!globalThis.process?.env?.NODE_TEST_CONTEXT
// loaded locale only: a locale whose catalog is not there is not taken (no screen full of keys)
export function setLocale(l) {
  if (LOCALES.includes(l) && CATALOGS[l]) current = l
}
// loaders: the chunk imports (replaceable by a test that simulates a missing chunk); a failure
// rejects without registering anything (a new attempt reloads)
export async function loadLocale(l, loaders = LOADERS) {
  if (!LOCALES.includes(l)) return current
  if (!CATALOGS[l]) {
    const mod = await loaders[l]()
    CATALOGS[l] = { ...(mod.default ?? mod) }
    for (const [id, locales] of PLUGIN_CATALOGS) mergePlugin(l, id, locales)
  }
  current = l
  return current
}
const mergePlugin = (l, id, locales) => {
  for (const [k, v] of Object.entries(locales?.[l] ?? {})) CATALOGS[l][`${id}.${k}`] = v
}
// catalog of a client plugin ({ fr, en } catalogs), under its id; locales already loaded and future ones
export function registerCatalog(id, locales) {
  PLUGIN_CATALOGS.push([id, locales])
  for (const l of Object.keys(CATALOGS)) mergePlugin(l, id, locales)
}
export const loadedLocales = () => Object.keys(CATALOGS)
export const setStrict = v => { strict = !!v }
export const locale = () => current
export const localeTag = (l = current) => TAGS[l] ?? TAGS[DEFAULT_LOCALE]

// lazy number formatter, using the instance locale at call time (a module-level formatter would
// freeze the locale at load time); used like Intl.NumberFormat: .format(v)
const nfCache = new Map()
export function numberFormat(opts = {}) {
  return {
    format(v) {
      const key = `${localeTag()}|${JSON.stringify(opts)}`
      if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat(localeTag(), opts))
      return nfCache.get(key).format(v)
    },
  }
}

const rules = new Map()
const pluralOf = (l, n) => {
  if (!rules.has(l)) rules.set(l, new Intl.PluralRules(localeTag(l)))
  return rules.get(l).select(n)
}

export function t(key, params) {
  const own = CATALOGS[current]?.[key]
  const hit = own ?? CATALOGS.en?.[key]
  // strict: the key must exist in the current locale (no silent fallback to English)
  if (strict && own == null) throw new Error(`i18n: missing key: ${key} (${current})`) // like the server
  if (hit == null) return key
  let s = hit
  if (hit && typeof hit === 'object') {
    const n = Number(params?.count)
    s = (n === 0 && hit.zero) || hit[pluralOf(own != null ? current : 'en', n)] || hit.other
  }
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (params && Object.hasOwn(params, k) ? String(params[k]) : m))
}

// label table read at RENDER time (never at module load, before loadLocale):
// tLabels('theme', ['auto', 'light']) → { auto, light } where each value is t('theme.<id>')
export const tLabels = (prefix, ids) => Object.defineProperties({}, Object.fromEntries(ids.map(id => [id, { enumerable: true, get: () => t(`${prefix}.${id}`) }])))

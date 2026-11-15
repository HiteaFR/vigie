// Translation and formats in the locale of the INSTANCE (locale key of the config; default en).
// One instance = one process: the locale is set once at startup
// (setLocale, index.js), and the formats (dates, numbers) read it. Tests set it themselves.
//
// t(key, params): catalogs server/locales/<locale>.json, flat dotted keys.
// - interpolation {name};
// - plural: an entry { one, other } (zero optional) chosen by Intl.PluralRules on params.count;
// - missing key: falls back to English, then to the key itself; in tests (strict), a missing key
//   THROWS, so that no string goes through untranslated.
// HTML escaping for Telegram: not here (this module knows nothing about rendering); the Telegram layer
// has tHtml (lib/notify/format.js), which escapes each parameter, never the template.
import fs from 'node:fs'

export const LOCALES = Object.freeze(['fr', 'en'])
export const DEFAULT_LOCALE = 'en'
// format tag: en-GB for English (24-hour clock, day before month, like the French
// instance); fr-FR for French (byte-identical to the original French rendering)
const TAGS = { fr: 'fr-FR', en: 'en-GB' }

let current = DEFAULT_LOCALE
export function setLocale(l) {
  if (!LOCALES.includes(l)) throw new Error(`unknown locale: ${String(l).slice(0, 20)} (${LOCALES.join(', ')})`)
  current = l
}
export const locale = () => current
export const localeTag = (l = current) => TAGS[l] ?? TAGS[DEFAULT_LOCALE]

// lazy number formatter, using the instance locale at call time (a module-level formatter
// would freeze the locale at load time); same usage as Intl.NumberFormat: .format(v)
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

const readCatalog = l => JSON.parse(fs.readFileSync(new URL(`../locales/${l}.json`, import.meta.url), 'utf8'))
export const CATALOGS = Object.freeze(Object.fromEntries(LOCALES.map(l => [l, Object.freeze(readCatalog(l))])))

const pluralRules = new Map()
const pluralOf = (l, n) => {
  if (!pluralRules.has(l)) pluralRules.set(l, new Intl.PluralRules(localeTag(l)))
  return pluralRules.get(l).select(n)
}
function render(entry, params, l) {
  let s = entry
  if (entry && typeof entry === 'object') {
    const n = Number(params?.count)
    s = (n === 0 && entry.zero) || entry[pluralOf(l, n)] || entry.other
  }
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (params && Object.hasOwn(params, k) ? String(params[k]) : m))
}

// strict: missing key → error (tests); default: under node --test
export function createI18n({ catalogs = CATALOGS, getLocale = locale, strict = !!process.env.NODE_TEST_CONTEXT } = {}) {
  return function t(key, params) {
    const l = getLocale()
    const hit = catalogs[l]?.[key] ?? catalogs.en?.[key]
    // in strict mode, the key must exist in the current locale (no silent fallback to English)
    if (strict && catalogs[l]?.[key] == null) throw new Error(`i18n: missing key: ${key} (${l})`)
    if (hit == null) return key
    return render(hit, params, catalogs[l]?.[key] != null ? l : 'en')
  }
}
export const t = createI18n()

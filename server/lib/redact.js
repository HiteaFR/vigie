// Masking of secrets in an error message coming from a module or a plugin, before it
// leaves the process (/api/plugins, detail of plugin_error hence /api/alerts, digest and Telegram,
// log). Known values first (declared secrets, case-insensitive), then recognizable
// forms: URL credentials (//user:pass@), query parameter values, Authorization,
// Bearer, Basic and "token" headers followed by a value that looks like a secret, secret
// name=value pairs, and anything that looks like a token (JWT, base64, long run of letters and
// digits). Nothing is masked without reason: an ordinary message ("Gitea 502", "timed
// out", "token expired", "Basic authentication failed", a URL path) stays readable.
// Intended limits (no over-masking): a run of letters WITHOUT digits is not masked (it
// could be a word; declared secrets remain covered); UUIDs are masked (they also serve
// as keys).
import { t as tr } from './i18n.js'

export const MASK = '***'
const MIN_SECRET = 4 // shorter known value: not masked as is (too many false positives)

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMES = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|session(?:id)?|sid|auth|cookie|signature|sig)'

const classes = m => [/[A-Z]/, /[a-z]/, /[0-9]/].filter(r => r.test(m)).length

// base64: length multiple of 4, upper case, lower case and digits; with "/", only if it
// ends with padding (=) or if none of its segments is a lower-case word (URL path)
function isBase64(m) {
  if (m.length % 4 !== 0 || !/[A-Z]/.test(m) || !/[a-z]/.test(m) || !/[0-9]/.test(m)) return false
  if (!m.includes('/') || m.endsWith('=')) return true
  return !m.startsWith('/') && !m.includes('//') && !m.split('/').some(seg => /^[a-z]{3,}$/.test(seg))
}

// message of an error (or of a text): one line, masked, then cut to max characters
export const redactError = (e, secrets = [], max = 200) => redact(String(e?.message ?? e ?? tr('errors.generic')).replace(/\s+/g, ' '), secrets).slice(0, max)

export function redact(text, secrets = []) {
  let s = String(text ?? '')
  // known values (longest first: one value may contain another)
  // case-insensitive (a message may put the value in upper case)
  for (const v of [...new Set(secrets)].filter(x => typeof x === 'string' && x.length >= MIN_SECRET).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(esc(v), 'gi'), MASK)
    // URL-encoded form
    const enc = encodeURIComponent(v)
    if (enc !== v) s = s.replace(new RegExp(esc(enc), 'gi'), MASK)
  }
  return s
    // credentials in a URL: scheme://user:pass@ or scheme://token@
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, `$1${MASK}@`)
    // query parameter values
    .replace(/([?&][^\s=&#?]+=)[^\s&#]*/g, `$1${MASK}`)
    // authentication headers and schemes
    .replace(/\b(authorization|proxy-authorization|x-[a-z0-9-]*(?:token|key|secret|auth)[a-z0-9-]*)(\s*[:=]\s*)("?)(?:(?:bearer|basic|token|digest)\s+)?[^\s",;]+/gi, `$1$2$3${MASK}`)
    // scheme followed by a value that looks like a secret (a digit, or at least 16 characters):
    // "token expired" and "Basic authentication failed" stay readable
    .replace(/\b(bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{6,})/gi, (m, k, v) => (/\d/.test(v) || v.length >= 16 ? `${k} ${MASK}` : m))
    // name=value or name: value pairs of a secret
    .replace(new RegExp(`\\b(${NAMES})(["']?\\s*[:=]\\s*["']?)[^\\s"',;&]+`, 'gi'), `$1$2${MASK}`)
    // JWT
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g, MASK)
    // recognized base64, "/" included (see isBase64); a URL path is not
    .replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g, m => (isBase64(m) ? MASK : m))
    // any long run of letters AND digits, "/" excluded (tokens, keys, fingerprints)
    .replace(/[A-Za-z0-9_+=-]{24,}/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? MASK : m))
    // short padded base64 (Basic credentials of a short password, "YWI6Y2Q="): at least 8
    // characters, multiple of 4, two classes out of three (upper case, lower case, digits), ends
    // with = or == (a lower-case parameter name, "content=", is not one)
    .replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{6,}={1,2}(?![A-Za-z0-9+/=*])/g, m => (m.length >= 8 && m.length % 4 === 0 && classes(m) >= 2 ? MASK : m))
}

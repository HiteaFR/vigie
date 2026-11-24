// Rendering of Telegram messages (parse_mode HTML). Bot chats are not
// end-to-end encrypted: never a secret, and no IP address (masked even if
// it slips into an error message).
import { fmtDuration } from '../clock.js'
import { t as tr } from '../i18n.js'
import { RULE_LABEL } from '../alerts/rules.js'

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// any IPv4 (port included), even stuck to a letter or a symbol ("J192.0.2.66");
// only neighboring digits delimit ("1.2.3.4.5" is not an IP), a trailing dot
// too; a version "v1.2.3.4" (v at the start of a word) is not masked
export const scrub = s => String(s ?? '').replace(/(?<!\d|\d\.|(?:^|[^A-Za-z])[vV])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?!\.?\d)/g, '‹ip›')
export const t = s => esc(scrub(s))
// translated text for Telegram (HTML): the catalog template carries the markup (<b>, <i>), each
// PARAMETER is escaped and its IPs masked (t above), count included (the plural reads Number(count),
// unchanged by escaping a number). Done here, not by the caller: a caller cannot forget to
// escape a value coming from a device, a service or a plugin. translate: tests
// ALREADY SAFE parameter (catalog text, or nested tHtml): passed as is, never escaped
// a second time (markup intended by the translator stays markup); everything else is escaped
class SafeHtml {
  constructor(html) { this.html = String(html) }
  toString() { return this.html }
}
export const safe = html => new SafeHtml(html)
export const tHtml = (key, params = {}, translate = tr) => translate(key, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v instanceof SafeHtml ? v.html : t(v)])))

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' }
// the title already contains the rule label, as whole words, whatever the case
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const says = (title, label) => !!label && new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(String(label))}($|[^\\p{L}\\p{N}])`, 'iu').test(String(title ?? ''))

export function createFormatter({ dashboardUrl, clock }) {
  const link = (path, label = tr('notify.link.open')) => (dashboardUrl
    ? `<a href="${esc(dashboardUrl.replace(/\/$/, '') + (path || '/alerts'))}">${label}</a>`
    : '')
  const envTag = st => (st.env === 'dev' ? ' <i>(dev)</i>' : '')
  const head = (icon, st, what) => `${icon} <b>${t(st.title)}</b>${what ? ` — ${what}` : ''}${envTag(st)}`
  const lines = (...xs) => xs.filter(Boolean).join('\n')

  function impactLine(st) {
    const x = st.extra
    if (!x || (!x.guests && !x.services?.length)) return null
    const names = x.services.slice(0, 8).join(', ') + (x.services.length > 8 ? '…' : '')
    return tHtml('notify.impact', { guests: x.guests, services: x.services.length })
      + (names ? `\n${t(names)}` : '')
  }

  return {
    render(kind, st, now, extra = {}) {
      const rule = RULE_LABEL[st.rule] || st.rule
      switch (kind) {
        case 'open':
          return lines(
            // rule label left out when the title already says it ("cert-6 — certificate")
            head(ICON[st.severity], st, says(st.title, rule) ? null : t(rule.toLowerCase())),
            st.detail && t(st.detail),
            st.host && tHtml('notify.host', { host: st.host }),
            st.rule === 'pve_unreachable' && impactLine(st),
            `${tHtml('notify.since', { time: clock.hm(st.since) })} · ${link(st.link)}`,
          )
        case 'escalate':
          return lines(head('🔴', st, tr('notify.escalate')), st.detail && t(st.detail), link(st.link))
        case 'remind':
          return lines(
            head('⏰', st, tHtml('notify.remind', { duration: fmtDuration(extra.duration) })),
            st.detail && t(st.detail),
            link(st.link),
          )
        case 'resolve':
          return head('🟢', st, tHtml('notify.resolve', { duration: fmtDuration(extra.duration), from: clock.hm(st.since), to: clock.hm(now) }))
        case 'flap':
          return lines(
            head('🔀', st, tr('notify.flap')),
            tHtml('notify.flap_detail', { rule }),
            link(st.link),
          )
        case 'stable':
          return st.state === 'firing'
            ? lines(head(ICON[st.severity], st, tr('notify.stable_down')), st.detail && t(st.detail), link(st.link))
            : head('🟢', st, tr('notify.stable_up'))
        default:
          return t(String(kind))
      }
    },
    link,
  }
}

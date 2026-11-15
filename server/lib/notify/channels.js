// Notification channels. A channel receives a list of items from the send queue (HTML text
// already rendered by the formatter, type, severity, silent, incident) and delivers them in one message.
//
//   { id, label, configured, limits: { maxBatch, maxLen }, send(list), classify(error) →
//     { permanent, retryAfter } }
//
// The policy (what, when: immediate, digest, quiet hours, HOLD_MS grouping, expiry,
// retry) stays in the notifier, shared by all channels. Rendering and whatever is specific to
// the service (HTML, bot buttons, plain-text fallback, size limits) stay in the channel.
import { TelegramError } from './telegram.js'
import { t as tr } from '../i18n.js'

// plain-text fallback if Telegram refuses the HTML: a degraded message beats a lost one
export const plain = html => html.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// "Silence 1 h" / "Ack" buttons: only on an opening, an escalation
// or a reminder still in progress, and if the bot is listening
const BUTTON_KINDS = new Set(['open', 'escalate', 'remind'])
const shortTitle = s => (String(s).length > 22 ? `${String(s).slice(0, 21)}…` : String(s))

// button set by rule (key prefix); ASCII callback_data, ≤ 64 bytes
export function buttonsFor(r, title) {
  // no "🔕 Ignore" (i:) on net_new, and no "Delete" instead: it would bring a present
  // device back as "new", with a second notification
  const dev = /^net_new:(\d{1,10})$/.exec(r.key || '')
  if (dev) return [{ text: tr('buttons.known', { title }), callback_data: `n:${dev[1]}` }]
  const mac = /^net_mac_added:([0-9a-f]{2}(?::[0-9a-f]{2}){5})$/.exec(r.key || '')
  if (mac) {
    const hex = mac[1].replace(/:/g, '')
    return [{ text: tr('buttons.same_device', { title }), callback_data: `c:${hex}` }, { text: tr('buttons.detach'), callback_data: `d:${hex}` }]
  }
  return [
    { text: tr('buttons.mute', { title }), callback_data: `s:${r.incident_id}` },
    { text: tr('buttons.ack'), callback_data: `a:${r.incident_id}` },
  ]
}

// Telegram: one message for the list, joined text (4000 characters at most), sound if at least one
// item asks for it, one row of buttons per alert still to handle if the bot is listening (buttons),
// HTML refused ("parse entities") → plain text. Used for the whole batch and for one-by-one sending
export function telegramChannel({ telegram, buttons = false, log = console }) {
  async function send(list) {
    const text = list.map(r => r.text).join('\n\n').slice(0, 4000)
    const silent = list.every(r => r.silent)
    // one row of buttons per alert still to handle (data ≤ 64 bytes: "a:<incident>")
    const keyboard = buttons
      ? list.filter(r => BUTTON_KINDS.has(r.kind) && r.incident_id && r.severity !== 'info')
        .filter((r, i, all) => all.findIndex(x => x.incident_id === r.incident_id) === i)
        .slice(0, 8)
        .map(r => buttonsFor(r, shortTitle(plain(r.text).split('\n')[0].replace(/^\S+\s/, '').split(' — ')[0])))
      : []
    const replyMarkup = keyboard.length ? { inline_keyboard: keyboard } : null
    try {
      await telegram.send(text, { silent, replyMarkup })
    } catch (e) {
      if (!(e instanceof TelegramError && /parse entities/.test(e.message))) throw e
      log.error(`telegram: HTML refused (${e.message}), sending plain text`)
      await telegram.send(plain(text), { silent, html: false, replyMarkup })
    }
  }
  return {
    id: 'telegram',
    label: 'Telegram',
    configured: !!telegram.configured,
    // Telegram limit: 4096 characters
    limits: { maxBatch: 12, maxLen: 3800 },
    send,
    classify: e => ({ permanent: e instanceof TelegramError && !!e.permanent, retryAfter: e?.retryAfter ?? null }),
  }
}

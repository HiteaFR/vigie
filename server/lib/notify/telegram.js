// Minimal client for the Telegram Bot API (send, long-polling, buttons). The token never
// leaves this module: it appears neither in errors nor in logs.
import { fetch as uFetch } from 'undici'
import { withUserAgent } from '../http.js'
import { t as tr } from '../i18n.js'

export class TelegramError extends Error {
  constructor(message, { retryAfter = null, permanent = false } = {}) {
    super(message)
    this.retryAfter = retryAfter
    this.permanent = permanent
  }
}

// injectable fetch (tests, fake fetch); undici by default
export function createTelegram({ token, chatId, fetch = uFetch }) {
  const configured = !!(token && chatId)
  async function call(method, body, timeoutMs = 15_000) {
    let r
    try {
      r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: withUserAgent({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      // undici message without the URL (which contains the token)
      throw new TelegramError(tr('errors.telegram.network', { code: e?.cause?.code || e?.name || tr('errors.telegram.error') }))
    }
    const j = await r.json().catch(() => ({}))
    if (j.ok) return j.result
    const desc = String(j.description || `HTTP ${r.status}`)
    if (r.status === 429) throw new TelegramError(desc, { retryAfter: j.parameters?.retry_after ?? 30 })
    // 409: another process is already reading this bot's updates (dev instance?)
    if (r.status === 409) throw new TelegramError(desc, { retryAfter: 60 })
    // 400 (malformed message), 401 (token revoked), 403 (bot blocked): retrying is useless
    throw new TelegramError(desc, { permanent: r.status === 400 })
  }
  return {
    configured,
    chatId: chatId ? String(chatId) : null,
    send: (text, { silent = false, html = true, replyMarkup = null, replyTo = null } = {}) => call('sendMessage', {
      chat_id: chatId,
      text,
      ...(html ? { parse_mode: 'HTML' } : {}),
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }),
    // long-polling: the request stays open for up to `timeout` seconds
    getUpdates: (params = {}) => call('getUpdates', params, ((params.timeout ?? 0) + 15) * 1000),
    answerCallback: (id, text = '') => call('answerCallbackQuery', { callback_query_id: id, text: String(text).slice(0, 190) }),
    setCommands: commands => call('setMyCommands', { commands, scope: { type: 'chat', chat_id: chatId } }),
    clearButtons: messageId => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  }
}

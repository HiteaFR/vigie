// Telegram setup helper: lists the chats that wrote to the bot (chat.id = TELEGRAM_CHAT_ID,
// from.id = TELEGRAM_ALLOWED_USER_IDS). Reads the updates without acknowledging them. The token
// is never shown.
//   set -a; . /etc/vigie/vigie.env; set +a; node scripts/telegram-chatid.js
import { createTelegram } from '../lib/notify/telegram.js'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN missing from the environment')
  process.exit(1)
}
const tg = createTelegram({ token, chatId: 'n/a' })
console.log('Send a message to the bot in Telegram… (waiting 50 s at most)')
const updates = await tg.getUpdates({ timeout: 50 })
if (!updates.length) {
  console.log('No message received. Check the bot name (BotFather) and try again.')
  process.exit(2)
}
const seen = new Set()
for (const u of updates) {
  const m = u.message || u.my_chat_member || u.channel_post
  if (!m?.chat || seen.has(m.chat.id)) continue
  seen.add(m.chat.id)
  console.log(`chat.id=${m.chat.id} (${m.chat.type}${m.chat.title ? ` "${m.chat.title}"` : ''})  from.id=${m.from?.id ?? '?'} ${m.from?.first_name ?? ''}`)
}

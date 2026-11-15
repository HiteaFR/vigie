// Sends a test message on Telegram with the config of the service (same client, same format). Run
// it on the Vigie machine, with the environment file and the config of the service, for example:
//   set -a; . /etc/vigie/vigie.env; set +a; CONFIG_PATH=/etc/vigie/config.json node scripts/notify-test.js
// Config: CONFIG_PATH, otherwise <root>/config.json (like the server).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { createTelegram } from '../lib/notify/telegram.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { config: cfg, errors } = loadConfig(process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(root, 'config.json'))
if (errors) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID })
if (!tg.configured) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required')
  process.exit(1)
}
const url = cfg.alerts.dashboardUrl
try {
  await tg.send([
    '🧪 <b>Notification test</b> — Vigie',
    `Quiet hours ${cfg.alerts.quietHours.start}–${cfg.alerts.quietHours.end} · digest ${cfg.alerts.digestAt}`,
    url ? `<a href="${url}/alerts">Open the alerts</a>` : null,
  ].filter(Boolean).join('\n'), { silent: process.argv.includes('--silent') })
  console.log('message sent')
} catch (e) {
  console.error(`failed: ${e.message}`)
  process.exit(1)
}

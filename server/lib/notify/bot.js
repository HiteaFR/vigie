// Interactive Telegram bot, using long-polling (getUpdates): nothing is
// exposed on the Internet. Only obeys the configured chat (TELEGRAM_CHAT_ID) AND
// the listed accounts (TELEGRAM_ALLOWED_USER_IDS); any other message is ignored,
// without a reply, and logged. A reason is mandatory for an ack or a
// silence: the alert buttons ask for the reason as a reply.
//
//   /status /down /silences /digest /refresh /help
//   /ack <#incident|key> <reason>
//   /mute <target> <duration> <reason>      target: #incident, host, service, rule, key
//   /unmute <silence no.>
//   /network  /device <text>  /known <id> <reason>      (network module)
import { t, tHtml, safe } from './format.js'
import { RULE_LABEL } from '../alerts/rules.js'
import { describeMatcher } from '../alerts/silences.js'
import { NETWORK_TODO } from './digest.js'
import { fmtDuration } from '../clock.js'
import { plain } from '../network/merge.js'
import { localeTag, t as tr } from '../i18n.js'
import { AUDIT, AUDIT_DETAIL, NET_VERB, netAction, silenceDetail } from '../codes.js'

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' }
const PROMPT_MS = 10 * 60_000
// /down: alerts listed (beyond: "+N on the cockpit")
const MAX_DOWN = 25
const MAX_MUTE_MS = 30 * 86400_000

export function parseDuration(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(\d{1,4})\s*(m|min|h|j|d)$/)
  if (!m) return null
  const n = Number(m[1]) * { m: 60_000, min: 60_000, h: 3600_000, j: 86400_000, d: 86400_000 }[m[2]]
  return n > 0 && n <= MAX_MUTE_MS ? n : null
}

// "/" menu of the Telegram app (limited to the allowed chat); descriptions from the instance
// locale (bot.cmd.<command>), computed when the bot starts
// English names in the menu; the old French names remain accepted, permanently (same
// arguments, same reply: they are translated before dispatch)
export const COMMAND_NAMES = ['status', 'down', 'ack', 'mute', 'unmute', 'silences', 'digest', 'refresh', 'network', 'device', 'known', 'help']
export const COMMAND_ALIASES = Object.freeze({ reseau: 'network', appareil: 'device', connu: 'known' })
const commands = () => COMMAND_NAMES.map(command => ({ command, description: tr(`bot.cmd.${command}`) }))

// help text from the instance locale (bot.help)
const helpText = () => tr('bot.help')

// network buttons: n = Known (record id); c = Same device, d = Detach (MAC);
// i (Ignore) was removed: an old button replies "Action removed", without writing anything
const CALLBACK = /^(?:([as]):(\d{1,10})|([ni]):(\d{1,10})|([cd]):([0-9a-f]{12}))$/
// verb: audit log label (persisted code); prompt and done: bot.net.<action>.*
const NET_ACTION = {
  n: { verb: NET_VERB.KNOWN },
  c: { verb: NET_VERB.SAME_DEVICE },
  d: { verb: NET_VERB.DETACH },
}
const FRESH = { active: 'bot.fresh.active', dhcp: 'bot.fresh.dhcp', stale: 'bot.fresh.stale' }

export function createBot({ telegram, store, cfg, engine, silences, refresher, audit, clock, texts, allowedIds, network = null, log = console, now = () => Date.now() }) {
  const allowed = new Set(String(allowedIds || '').split(',').map(s => s.trim()).filter(Boolean))
  const chatId = telegram.chatId
  const pending = new Map() // id of the "reason?" message → pending action
  let running = false
  let lastError = null
  let lastUpdateAt = null

  const hostIds = new Set(cfg.hosts.map(h => h.id))
  const serviceIds = new Set(cfg.services.map(s => s.id))
  const who = from => `tg:${from.username || from.first_name || from.id}`
  const reply = (text, opts = {}) => telegram.send(text, { silent: true, ...opts })
  const when = ms => (ms - now() < 20 * 3600_000 ? clock.hm(ms) : new Date(ms).toLocaleString(localeTag(), { timeZone: cfg.alerts.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))

  // "#12", "12" or an alert key → key; null if unknown
  function alertKey(ref) {
    const n = String(ref || '').replace(/^#/, '')
    if (/^\d+$/.test(n)) return engine.byIncident(Number(n))?.key ?? null
    return engine.get(ref)?.state === 'firing' ? ref : null
  }

  function matcherOf(target) {
    const s = String(target || '')
    if (/^#?\d+$/.test(s)) {
      const k = alertKey(s)
      return k ? { key: k } : null
    }
    if (hostIds.has(s)) return { host: s }
    if (serviceIds.has(s)) return { service: s }
    if (RULE_LABEL[s]) return { rule: s }
    if (s.includes(':')) return { key: s }
    return null
  }

  function downText() {
    // new devices and MACs to confirm: /network (they would drown the failures)
    const list = engine.active().filter(a => a.state === 'firing' && !NETWORK_TODO.has(a.rule))
    if (!list.length) return tr('bot.no_alerts')
    // one section per severity (title and count), one line per alert: number, title in bold, detail
    const shown = list.slice(0, MAX_DOWN)
    const sections = [tr('bot.alerts', { count: list.length })]
    for (const sev of ['critical', 'warning', 'info']) {
      const of = shown.filter(a => a.severity === sev)
      if (!of.length) continue
      sections.push([`${tr(`bot.sev.${sev}`)} · ${of.length}`, ...of.map(a => {
        const flags = [a.ack ? tHtml('bot.acked_flag', { reason: a.ack.reason }) : null, a.suppressed ? `🔕 ${t(a.suppressed)}` : null].filter(Boolean)
        return `#${a.incidentId} <b>${t(a.title)}</b>${a.detail ? ` — ${t(a.detail)}` : ''}${flags.length ? `\n   <i>${flags.join(' · ')}</i>` : ''}`
      })].join('\n'))
    }
    if (list.length > shown.length) sections.push(tr('digest.more', { count: list.length - shown.length }))
    return sections.join('\n\n')
  }

  function silencesText() {
    const list = silences.active()
    if (!list.length) return tr('bot.no_silences')
    return [tr('bot.silences_title', { count: list.length }), ...list.map(s =>
      tHtml('bot.silence_line', { id: s.id, target: describeMatcher(s.matcher), reason: s.reason, until: s.endsAt ? safe(tHtml('bot.until', { time: when(s.endsAt) })) : safe(tr('bot.forever')), by: s.createdBy }))].join('\n\n')
  }

  function doAck(key, reason, from) {
    const a = engine.ack(key, { by: who(from), reason })
    audit.log({ actor: who(from), source: 'telegram', action: AUDIT.ACK, target: key, detail: reason })
    return tHtml('bot.ack_done', { title: a.title, reason })
  }

  function doMute(matcher, ms, reason, from) {
    const s = silences.create({ matcher, reason, by: who(from), source: 'telegram', endsAt: now() + ms })
    audit.log({ actor: who(from), source: 'telegram', action: AUDIT.SILENCE, target: describeMatcher(matcher), detail: silenceDetail(reason, s.endsAt) })
    return tHtml('bot.mute_done', { id: s.id, target: describeMatcher(matcher), time: when(s.endsAt), reason })
  }

  // --- network module -----------------------------------------------------------
  const devName = d => plain(d.name || d.vendor || d.mac || tr('bot.device_n', { id: d.id }))
  const freshText = d => (d.freshness === 'idle' && d.lastSeen ? tr('bot.seen_ago', { duration: fmtDuration(now() - Date.parse(d.lastSeen)) }) : FRESH[d.freshness] ? tr(FRESH[d.freshness]) : '?')
  // presence: "online" only with the ARP probe, otherwise the freshness
  const stateText = (d, mode) => (mode !== 'arp' ? freshText(d)
    : d.online === 1 ? tr('bot.online')
      : d.online === 0 ? `${tr('bot.offline')}${d.lastPresent ? ` (${tr('bot.seen_ago', { duration: fmtDuration(now() - Date.parse(d.lastPresent)) })})` : ''}` : tr('bot.presence_unknown'))

  function networkText() {
    if (!network?.enabled) return tr('bot.net_off')
    const v = network.view()
    const c = v.counts
    // ARP probe not installed yet (no sweep): not a failing source
    const down = Object.entries(v.sources).filter(([n, x]) => !(n === 'arp' && x.ok === null && !v.presenceSince) && (!x.ok || x.stale))
    const presence = v.presence === 'arp' ? tr('bot.net.presence_arp', { online: c.online, offline: c.offline }) : tr('bot.net.presence_active', { active: c.active })
    const out = [tr('bot.net.header', { total: c.total, presence, news: tr('bot.net.news', { count: c.new }), review: c.review, sources: tr(down.length ? 'bot.net.sources_error' : 'bot.net.sources_ok') })]
    const fresh = v.devices.filter(d => d.state === 'new')
    // sections separated by a blank line: figures, new devices, MACs to confirm, failing sources
    if (fresh.length) out.push([tr('bot.net.new_title'), ...fresh.slice(0, 10).map(d => `#${d.id} ${t(devName(d))} · ${stateText(d, v.presence)}`), ...(fresh.length > 10 ? [tr('bot.and_more', { count: fresh.length - 10 })] : [])].join('\n'))
    const pend = v.devices.filter(d => d.pending)
    if (pend.length) out.push([tr('bot.net.pending_title'), ...pend.slice(0, 10).map(d => tHtml('bot.net.pending_line', { id: d.id, name: devName(d), count: d.pending })), ...(pend.length > 10 ? [tr('bot.and_more', { count: pend.length - 10 })] : [])].join('\n'))
    if (down.length) out.push(down.map(([n, x]) => tHtml('bot.net.source_down', { source: n, error: x.error || safe(tr('bot.net.source_stale')) })).join('\n'))
    return out.join('\n\n')
  }

  function deviceText(q) {
    if (!network?.enabled) return tr('bot.net_off')
    const text = String(q || '').trim().slice(0, 64)
    if (!text) return tr('bot.dev.usage')
    const found = network.search(text)
    if (!found.length) return tr('bot.dev.none')
    const mode = network.view().presence
    if (found.length > 1) {
      return [tr(found.length > 10 ? 'bot.dev.many_first' : 'bot.dev.many', { count: found.length }),
        ...found.slice(0, 10).map(d => `#${d.id} ${t(devName(d))} · ${t(d.ip || '—')} · ${stateText(d, mode)}`)].join('\n')
    }
    const d = found[0]
    return [
      `<b>#${d.id} ${t(devName(d))}</b>${d.state === 'new' ? tr('bot.dev.new') : d.review ? tr('bot.dev.review') : ''}`,
      `${stateText(d, mode)} · IP ${t(d.ip || '—')}`,
      `MAC ${t(d.mac)}${d.macs > 1 ? ` (+${d.macs - 1})` : ''}${d.pending ? tr('bot.dev.to_confirm', { count: d.pending }) : ''}`,
      d.vendor ? tHtml('bot.dev.vendor', { vendor: plain(d.vendor) }) : null,
      d.hostId ? tHtml('notify.host', { host: d.hostId }) : null,
    ].filter(Boolean).join('\n')
  }

  // network write from Telegram: same function as the UI; already handled → an audit line
  function netAct(action, ref, reason, from) {
    const who_ = { by: who(from), source: 'telegram' }
    const r = network?.bot?.act(action, ref, reason, who_)
    if (!r) {
      audit.log({ actor: who_.by, source: 'telegram', action: netAction(NET_ACTION[action].verb), target: String(ref).slice(0, 20), detail: AUDIT_DETAIL.ALREADY, ok: false })
      return null
    }
    return r
  }

  async function command(cmd, args, from) {
    switch (cmd) {
      case 'network':
        return networkText()
      case 'device':
        return deviceText(args)
      case 'known': {
        const m = /^#?(\d{1,10})\s+([\s\S]+)$/.exec(args)
        if (!m) return tr('bot.known.usage')
        const reason = m[2].trim()
        if (reason.length < 3) return tr('bot.reason_required')
        if (!network?.writes) return tr('bot.net_off')
        const r = network.writes.ack({ ids: [Number(m[1])], reason }, { by: who(from), source: 'telegram' })
        if (!r.done.length) {
          audit.log({ actor: who(from), source: 'telegram', action: netAction(NET_VERB.KNOWN), target: `dev:${m[1]}`, detail: AUDIT_DETAIL.ALREADY, ok: false })
          return tr('bot.already')
        }
        return tHtml('bot.known.done', { id: m[1], reason })
      }
      case 'start':
      case 'help':
        return helpText()
      case 'status':
        return texts.status()
      case 'down':
        return downText()
      case 'silences':
        return silencesText()
      case 'digest':
        return texts.digest()
      case 'ack': {
        const [ref, ...rest] = args.split(/\s+/)
        const key = alertKey(ref)
        if (!key) return tr('bot.alert_not_found')
        const reason = rest.join(' ').trim()
        if (reason.length < 3) return tr('bot.ack.reason_required')
        return doAck(key, reason, from)
      }
      case 'unack': {
        const key = alertKey(args.trim())
        if (!key || !engine.unack(key)) return tr('bot.unack.not_found')
        audit.log({ actor: who(from), source: 'telegram', action: AUDIT.UNACK, target: key })
        return tr('bot.unack.done')
      }
      case 'mute': {
        const [target, dur, ...rest] = args.split(/\s+/)
        const matcher = matcherOf(target)
        if (!matcher) return tr('bot.mute.target_unknown')
        const ms = parseDuration(dur)
        if (!ms) return tr('bot.mute.duration_invalid')
        const reason = rest.join(' ').trim()
        if (reason.length < 3) return tr('bot.mute.reason_required')
        return doMute(matcher, ms, reason, from)
      }
      case 'unmute': {
        const id = Number(String(args).trim().replace(/^n°\s*/, ''))
        const s = Number.isInteger(id) ? silences.end(id, who(from)) : null
        if (!s) return tr('bot.unmute.not_found')
        audit.log({ actor: who(from), source: 'telegram', action: AUDIT.SILENCE_END, target: s.target })
        return tHtml('bot.unmute.done', { id: s.id, target: s.target })
      }
      case 'refresh': {
        const r = refresher.run(who(from))
        if (r.cooldownSec) return tr('bot.refresh.cooldown', { s: r.cooldownSec })
        audit.log({ actor: who(from), source: 'telegram', action: AUDIT.REFRESH })
        r.done.then(last => reply(`${tr('bot.refresh.done', { s: Math.round((last.finishedAt - last.startedAt) / 1000) })}\n${downText()}`))
          .catch(e => log.error(`bot: refresh: ${e.message}`))
        return r.started ? tr('bot.refresh.started') : tr('bot.refresh.running')
      }
      default:
        return tr('bot.unknown_command')
    }
  }

  async function handle(u) {
    const msg = u.message
    const cb = u.callback_query
    const from = msg?.from ?? cb?.from
    const chat = msg?.chat ?? cb?.message?.chat
    if (!from || !chat) return
    const ok = String(chat.id) === chatId && allowed.has(String(from.id))
    if (!ok) {
      // never reply: a stranger learns nothing about the bot
      // aggregated by account and by reason (the received text is not a key)
      audit.refused({ actor: `tg:${from.id}${from.username ? `@${from.username}` : ''}`, source: 'telegram', action: AUDIT.REFUSED, target: `chat ${chat.id}`, detail: AUDIT_DETAIL.UNAUTHORIZED })
      log.warn(`bot: message ignored (account ${from.id}, chat ${chat.id})`)
      if (cb) await telegram.answerCallback(cb.id).catch(() => {})
      return
    }

    if (cb) {
      const m = CALLBACK.exec(String(cb.data || ''))
      if (m && (m[3] || m[5])) {
        // network: the state is checked again now (replay, forged data, already handled)
        const action = m[3] || m[5]
        const ref = m[4] || m[6]
        if (action === 'i') {
          audit.log({ actor: who(from), source: 'telegram', action: netAction(NET_VERB.IGNORE), target: ref, detail: AUDIT_DETAIL.RETIRED_R4, ok: false })
          return telegram.answerCallback(cb.id, tr('bot.cb.removed'))
        }
        const c = network?.bot?.check(action, ref)
        if (!c) {
          audit.log({ actor: who(from), source: 'telegram', action: netAction(NET_ACTION[action].verb), target: ref, detail: AUDIT_DETAIL.ALREADY, ok: false })
          return telegram.answerCallback(cb.id, tr('bot.cb.already'))
        }
        await telegram.answerCallback(cb.id)
        const prompt = await reply(tHtml('bot.prompt', { action: safe(tr(`bot.net.${action}.prompt`)), title: c.title }), {
          replyMarkup: { force_reply: true, selective: true, input_field_placeholder: tr('bot.prompt.placeholder') },
        })
        pending.set(prompt.message_id, { net: action, ref, message: cb.message?.message_id ?? null, expires: now() + PROMPT_MS })
        return
      }
      const a = m && m[1] ? engine.byIncident(Number(m[2])) : null
      if (!a) return telegram.answerCallback(cb.id, tr('bot.cb.gone'))
      await telegram.answerCallback(cb.id)
      const action = m[1] === 'a' ? 'ack' : 'silence'
      const prompt = await reply(tHtml('bot.prompt', { action: safe(tr(action === 'ack' ? 'bot.prompt.ack' : 'bot.prompt.mute')), title: a.title }), {
        replyMarkup: { force_reply: true, selective: true, input_field_placeholder: tr('bot.prompt.placeholder') },
      })
      pending.set(prompt.message_id, { action, key: a.key, expires: now() + PROMPT_MS })
      return
    }

    const text = String(msg.text || '').trim()
    if (!text) return
    const p = msg.reply_to_message && pending.get(msg.reply_to_message.message_id)
    if (p) {
      pending.delete(msg.reply_to_message.message_id)
      if (p.expires < now()) return reply(tr('bot.expired'))
      if (text.length < 3) return reply(tr('bot.too_short'))
      if (p.net) {
        const r = netAct(p.net, p.ref, text, from)
        if (!r) return reply(tr('bot.already'))
        if (p.message) await telegram.clearButtons?.(p.message).catch(() => {})
        // icon: first word of the catalog prompt, passed as an ordinary parameter (escaped,
        // no effect on an emoji): safe() only marks a whole tr(…) or tHtml(…) call
        return reply(tHtml('bot.net.done_line', { icon: tr(`bot.net.${p.net}.prompt`).split(' ')[0], done: safe(tr(`bot.net.${p.net}.done`)), reason: text }))
      }
      if (engine.get(p.key)?.state !== 'firing') return reply(tr('bot.already_recovered'))
      return reply(p.action === 'ack' ? doAck(p.key, text, from) : doMute({ key: p.key }, 3600_000, text, from))
    }
    const c = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
    if (!c) return reply(tr('bot.command_expected'))
    const name = c[1].toLowerCase()
    return reply(await command(COMMAND_ALIASES[name] ?? name, (c[2] || '').trim(), from))
  }

  // command errors: short message to the user, details in the log
  async function safeHandle(u) {
    try {
      await handle(u)
    } catch (e) {
      log.error(`bot: ${e.message}`)
      if (e.status) await reply(`⚠️ ${t(e.message)}`).catch(() => {})
    }
  }

  async function loop() {
    let offset = Number(store.kv.get('bot.offset') || 0)
    // very first start: skip the backlog (old messages to the bot) without replying
    while (running && !offset) {
      try {
        const old = await telegram.getUpdates({ offset: -1, timeout: 0 })
        offset = old.length ? old.at(-1).update_id + 1 : 1
        store.kv.set('bot.offset', offset)
      } catch (e) {
        log.error(`bot: ${e.message}`)
        await new Promise(r => setTimeout(r, 10_000))
      }
    }
    while (running) {
      try {
        const updates = await telegram.getUpdates({ offset, timeout: 50, allowed_updates: ['message', 'callback_query'] })
        lastError = null
        for (const u of updates) {
          offset = u.update_id + 1
          store.kv.set('bot.offset', offset)
          lastUpdateAt = now()
          await safeHandle(u)
        }
        for (const [id, p] of pending) if (p.expires < now()) pending.delete(id)
      } catch (e) {
        lastError = { at: now(), message: String(e.message || e) }
        log.error(`bot: ${lastError.message}`)
        await new Promise(r => setTimeout(r, (e.retryAfter ?? 10) * 1000))
      }
    }
  }

  return {
    enabled: allowed.size > 0 && !!chatId,
    handle: safeHandle,
    start() {
      if (running || !allowed.size || !chatId) return
      running = true
      telegram.setCommands?.(commands()).catch(e => log.error(`bot: command menu: ${e.message}`))
      loop()
    },
    stop() {
      running = false
    },
    status: () => ({ running, allowedUsers: allowed.size, lastUpdateAt, lastError }),
  }
}

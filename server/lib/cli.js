// Terminal input, shared by scripts/admin-password.js and scripts/init.js, without
// dependency (no readline, no masking package). A single read queue on the input stream:
//   - ordinary question: one line;
//   - secret: in a terminal (TTY), raw mode, nothing is displayed (neither the input nor stars),
//     backspace, Ctrl-C (interrupt) and Ctrl-D (closed input) handled, escape sequences
//     (arrows…) ignored; outside a terminal (scripted stdin, tests), a line read as
//     is, never echoed to the output.
// The secret is never written to the output nor in an error message.
import { hashPassword } from './auth.js'

export const ADMIN_MIN_LENGTH = 12

export class InputClosed extends Error {
  constructor() {
    super('input closed before the end of the questions')
  }
}
export class Aborted extends Error {
  constructor() {
    super('interrompu (Ctrl-C)')
  }
}

// input: readable stream (process.stdin or PassThrough); output: writable stream; tty: raw mode
// possible (input.setRawMode)
export function createPrompter({ input = process.stdin, output = process.stdout, tty = !!input.isTTY } = {}) {
  let buf = ''
  let ended = false
  const waiting = [] // { raw, resolve, reject, acc }

  function pump() {
    while (waiting.length) {
      const w = waiting[0]
      if (w.raw) {
        // secret in raw mode: character by character
        let done = false
        while (buf.length && !done) {
          const ch = buf[0]
          buf = buf.slice(1)
          if (w.esc) {
            // escape sequence (ESC [ … letter or ~): ignored entirely
            if (/[A-Za-z~]/.test(ch) && !(w.esc === 1 && (ch === '[' || ch === 'O'))) w.esc = 0
            else w.esc++
            continue
          }
          if (ch === '\r' || ch === '\n') done = true
          else if (ch === '\u0003' || ch === '\u0004') {
            finishRaw()
            waiting.shift()
            output.write('\n')
            return w.reject(ch === '\u0003' ? new Aborted() : new InputClosed())
          } else if (ch === '\u001b') w.esc = 1
          else if (ch === '\u007f' || ch === '\b') w.acc = w.acc.slice(0, -1)
          else if (ch >= ' ') w.acc += ch
        }
        if (!done) break
        finishRaw()
        waiting.shift()
        output.write('\n')
        w.resolve(w.acc)
      } else {
        const i = buf.indexOf('\n')
        if (i < 0) break
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        waiting.shift()
        w.resolve(line)
      }
    }
    if (ended) {
      for (const w of waiting.splice(0)) w.reject(new InputClosed())
    }
  }
  const onData = d => {
    buf += d.toString('utf8')
    pump()
  }
  const onEnd = () => {
    ended = true
    // last line without a final newline
    if (buf.length && waiting.length && !waiting[0].raw) buf += '\n'
    pump()
  }
  input.on('data', onData)
  input.on('end', onEnd)
  let rawOn = false
  function startRaw() {
    if (tty && typeof input.setRawMode === 'function') {
      input.setRawMode(true)
      rawOn = true
    }
  }
  function finishRaw() {
    if (rawOn) {
      input.setRawMode(false)
      rawOn = false
    }
  }
  const read = raw => new Promise((resolve, reject) => {
    waiting.push({ raw, resolve, reject, acc: '' })
    if (raw) startRaw()
    input.resume?.()
    pump()
  })

  return {
    tty,
    say: (text = '') => output.write(`${text}\n`),
    // question with the default shown in brackets; empty answer → default
    async line(question, def = '') {
      output.write(def !== '' ? `${question} [${def}] : ` : `${question} : `)
      const v = (await read(false)).trim()
      return v === '' ? def : v
    },
    // secret: never displayed; in a terminal, raw mode; otherwise one line (scripted stdin)
    async secret(question) {
      output.write(`${question} : `)
      const v = await read(tty)
      if (!tty) output.write('\n')
      return v
    },
    // yes/no; default given; "o", "oui", "y", "yes" / "n", "non", "no"
    async yesno(question, def = false) {
      for (;;) {
        const v = (await this.line(`${question} (y/n)`, def ? 'y' : 'n')).toLowerCase()
        if (['o', 'oui', 'y', 'yes'].includes(v)) return true
        if (['n', 'non', 'no'].includes(v)) return false
        output.write('Answer "y" or "n".\n')
      }
    },
    // choice among keys; displayed "label (key)"
    async choose(question, choices, def) {
      const keys = choices.map(c => c.key)
      for (;;) {
        output.write(`${question}\n${choices.map(c => `  ${c.key}) ${c.label}`).join('\n')}\n`)
        const v = await this.line('Choice', def)
        if (keys.includes(v)) return v
        output.write(`Expected choice: ${keys.join(', ')}.\n`)
      }
    },
    close() {
      finishRaw()
      input.off('data', onData)
      input.off('end', onEnd)
      input.pause?.()
    },
  }
}

// new admin password: typed twice, minimum length → scrypt hash (lib/auth.js);
// repeated attempts in interactive mode (attempts); the password is never displayed
export async function askAdminPassword(p, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const pw = await p.secret('Admin password')
    const why = adminPasswordProblem(pw)
    if (why) {
      p.say(why)
      continue
    }
    if (await p.secret('Confirm') !== pw) {
      p.say('The two entries differ.')
      continue
    }
    return { password: pw, hash: await hashPassword(pw) }
  }
  throw new Error('admin password not set (too many attempts)')
}
export function adminPasswordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < ADMIN_MIN_LENGTH) return `${ADMIN_MIN_LENGTH} characters at least.`
  if (/[\u0000-\u001f\u007f]/.test(pw)) return 'control characters refused.'
  return null
}

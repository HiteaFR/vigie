// Clean process shutdown, on SIGTERM or SIGINT. Each step (function,
// synchronous or asynchronous) is guarded: an error is logged and prevents neither the following
// steps nor the end. The steps, in order, are bounded together to timeoutMs (2 s). The
// finalizers (audit summaries, closing the database, hence flushing the WAL) ALWAYS run
// afterwards; an error there is silenced (database already closed by a second signal, for example).
export async function shutdown({ steps = [], finalize = [], log = console, timeoutMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const guarded = async () => {
    for (const [name, fn] of steps) {
      await Promise.resolve().then(fn).catch(e => log.error(`shutdown: ${name}: ${e?.message || e}`))
    }
  }
  let timer
  const late = new Promise(resolve => { timer = setTimer(() => resolve(log.error(`shutdown: steps not finished in ${timeoutMs} ms`)), timeoutMs) })
  await Promise.race([guarded(), late])
  clearTimer(timer)
  for (const fn of finalize) {
    try {
      fn()
    } catch { /* already done or database already closed */ }
  }
}

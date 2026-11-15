// HTTP and process errors: a final JSON handler that never returns the stack nor a path, a
// wrapper for async routes (Express 4 does not pass a rejected promise to next), and logging of
// unhandled rejections (Node 22 would stop the process).
import { t as tr } from './i18n.js'

// message of each status from the catalog (api.http.<status>)
const message = status => tr(`api.http.${status}`)

// final handler, declared after all routes and the static service; log: server log
// (stack and path without query, for 500s only)
export function errorHandler(log = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err)
    const s = err?.status ?? err?.statusCode
    const status = s === 400 || s === 413 || s === 415 ? s : 500
    if (status === 500) log.error(`internal error: ${req.method} ${req.path}\n${err?.stack || err}`)
    res.status(status).json({ error: message(status) })
  }
}

// async route (or one that returns a promise): a rejection goes to the final handler
export const wrap = fn => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next)
  } catch (e) {
    next(e)
  }
}

// an unhandled rejection is logged and the process keeps running (background tasks
// already guard against overlaps) → unsubscribe function
export function installProcessHandlers(log = console, proc = process) {
  const onRejection = e => log.error(`unhandled rejection: ${e?.stack || e}`)
  proc.on('unhandledRejection', onRejection)
  return () => proc.off('unhandledRejection', onRejection)
}

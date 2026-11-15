// Preload (node --import) of the route table walk. Express is the same
// module as index.js's: its listen method is replaced to listen on 127.0.0.1, free
// port, and write the route table to standard output (nested routers included,
// route-walk.js), without changing anything else in the server. Guards are MEASURED by the test
// (requests without a session, with a same-host Origin, then with a test admin session).
// Maximum delay: the server stops by itself after GOLDEN_DEADLINE_MS (default 60 s), even if the
// test that started it is killed without being able to stop it.
import express from 'express'
import { collectRoutes } from './route-walk.js'

setTimeout(() => process.exit(3), Number(process.env.GOLDEN_DEADLINE_MS) || 60_000).unref()
const listen = express.application.listen
express.application.listen = function () {
  const routes = collectRoutes(this._router)
  const server = listen.call(this, 0, '127.0.0.1', () => {
    process.stdout.write(`GOLDEN-ROUTES ${JSON.stringify({ port: server.address().port, routes })}\n`)
  })
  return server
}

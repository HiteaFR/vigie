#!/usr/bin/env node
// Demo server of the README screenshots: serves the built client (client/dist) and answers the
// read routes of /api from the made-up world of demo-data.mjs. No config, no database, no
// outbound call; writes are refused (read-only demo).
//
//   node scripts/screenshots/demo-server.mjs [--port 8099] [--now 2026-11-12T09:42:00Z]
//
// Build the client first (client/node_modules/.bin/vite build, from client/). Without --now, the
// data is computed from the current time; capture.mjs pins it, so the screenshots do not move.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoApi, rrd, history } from './demo-data.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DIST = path.join(ROOT, 'client', 'dist')
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

// now(): the demo clock (ms)
export function createDemoServer({ now = () => Date.now(), dist = DIST } = {}) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`${dist}/index.html missing: build the client first (vite build in client/)`)
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://demo.invalid')
    const p = url.pathname
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 403, { error: 'read-only demo' })
      const t = now()
      const m = /^\/api\/rrd\/([^/]+)\/([^/]+)$/.exec(p)
      if (m && m[2] !== 'guest') return send(res, 200, rrd(t, decodeURIComponent(m[2])))
      if (p === '/api/network/history') return send(res, 200, history(t, Number(url.searchParams.get('days')) || 7))
      const body = demoApi(t)[p]
      return body === undefined ? send(res, 404, { error: 'not part of the demo' }) : send(res, 200, body)
    }
    // no vendored icon in the demo: the client shows its monograms
    if (p.startsWith('/icons/')) return send(res, 404, 'no icon in the demo', 'text/plain')
    // static file of the build, otherwise index.html (client-side routing)
    const file = path.normalize(path.join(dist, decodeURIComponent(p)))
    const inside = file.startsWith(dist + path.sep)
    const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html')
    send(res, 200, fs.readFileSync(target), TYPES[path.extname(target)] ?? 'application/octet-stream')
  })
}

// command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const port = Number(arg('port') ?? 8099)
  const fixed = arg('now') ? Date.parse(arg('now')) : null
  if (fixed != null && !Number.isFinite(fixed)) {
    console.error(`--now: unreadable date ${arg('now')}`)
    process.exit(2)
  }
  const server = createDemoServer({ now: () => fixed ?? Date.now() })
  server.listen(port, '127.0.0.1', () => console.log(`demo: http://127.0.0.1:${port}/ (Ctrl C to stop)`))
}

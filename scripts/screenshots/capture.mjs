#!/usr/bin/env node
// README screenshots (docs/screenshots/*.png), taken on the made-up demo world of demo-data.mjs:
// builds the client, starts the demo server on a free local port, opens each view in Chromium
// through Playwright (English interface, dark theme, pinned clock) and writes the PNGs.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node scripts/screenshots/capture.mjs [--no-build] [--only cockpit,wall]
//
// Playwright is NOT a dependency of the project: PLAYWRIGHT points at an installed copy of the
// package (its folder), whose Chromium is already downloaded (playwright install chromium). The
// client is built with client/node_modules/.bin/vite (npm ci in client/ first).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDemoServer } from './demo-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUT = path.join(ROOT, 'docs', 'screenshots')
// demo clock: data and browser agree on "now", so every "ago" and the header clock stay put
const NOW = Date.parse('2026-11-12T09:42:00Z')

// desktop shots: 1440 × 900 at device scale 2; wall mode: a 1080p screen
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
const WALL = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
const SHOTS = [
  { name: 'cockpit', path: '/', ready: 'text=Service health', ...DESKTOP },
  { name: 'network', path: '/network?sort=name', ready: 'text=Front door camera', ...DESKTOP },
  { name: 'updates', path: '/updates', ready: 'text=Proxmox VE', ...DESKTOP },
  { name: 'alerts', path: '/alerts', ready: 'text=History (7 days)', ...DESKTOP },
  { name: 'wall', path: '/wall', ready: 'text=Active alerts', ...WALL },
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null

async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT
  if (!dir) throw new Error('PLAYWRIGHT is not set: point it at the folder of an installed playwright package')
  const entry = path.join(path.resolve(dir), 'index.mjs')
  if (!fs.existsSync(entry)) throw new Error(`${entry} not found: PLAYWRIGHT must be the folder of the playwright package`)
  return import(pathToFileURL(entry).href)
}

async function main() {
  const { chromium } = await loadPlaywright()
  if (!args.includes('--no-build')) {
    execFileSync(path.join(ROOT, 'client', 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'warn'], { cwd: path.join(ROOT, 'client'), stdio: 'inherit' })
  }
  const server = createDemoServer({ now: () => NOW })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const shot of SHOTS.filter(s => !only || only.includes(s.name))) {
      const context = await browser.newContext({
        viewport: shot.viewport, deviceScaleFactor: shot.deviceScaleFactor,
        colorScheme: 'dark', locale: 'en-GB', timezoneId: 'UTC', reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      await page.clock.setFixedTime(NOW)
      // dark theme chosen explicitly (not only through the system preference)
      await page.addInitScript(() => {
        try { localStorage.setItem('vigie.theme', 'dark') } catch { /* private mode */ }
      })
      await page.goto(base + shot.path, { waitUntil: 'networkidle' })
      await page.locator(shot.ready).first().waitFor()
      // fonts, lazy chunks and the last query answers
      await page.evaluate(() => document.fonts.ready)
      await page.waitForLoadState('networkidle')
      await page.mouse.move(0, 0)
      // Chromium's PNG encoder already compresses well here (150 to 350 KB, a flat dark UI):
      // a zlib level 9 re-encode gained nothing, so the file is written as is
      const file = path.join(OUT, `${shot.name}.png`)
      const png = await page.screenshot({ path: file, type: 'png', animations: 'disabled', caret: 'hide' })
      console.log(`${path.relative(ROOT, file)}: ${Math.round(png.length / 1024)} KB`)
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch(e => {
  console.error(e.message || e)
  process.exit(1)
})

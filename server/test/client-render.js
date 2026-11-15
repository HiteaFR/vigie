// Real rendering of client components in the tests: the client's esbuild and
// react-dom/server, like alert-bell.test.js. Skipped only if the client is not installed
// (the CI guard forbids it). entry: lines of a module that exports the render functions.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmpdir.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cache = new Map()
export async function clientBundle(t, name, entry) {
  const esb = path.join(ROOT, 'client/node_modules/esbuild/lib/main.js')
  if (!fs.existsSync(esb)) {
    t.skip('client not installed (npm ci in client/)')
    return null
  }
  if (cache.has(name)) return cache.get(name)
  const { build } = await import(esb)
  const r = await build({
    // default locale catalog preloaded (in the browser: main.jsx, before rendering)
    stdin: { contents: [...entry, "export { loadLocale as __loadLocale } from './src/i18n/index.js'"].join('\n'), resolveDir: path.join(ROOT, 'client'), loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic', logLevel: 'error',
    loader: { '.js': 'jsx', '.css': 'empty', '.svg': 'empty' },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  const file = path.join(tmpDir(`dash-${name}-`), `${name}.mjs`)
  fs.writeFileSync(file, r.outputFiles[0].text)
  const mod = await import(file)
  await mod.__loadLocale('fr')
  cache.set(name, mod)
  return mod
}

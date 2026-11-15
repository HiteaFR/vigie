import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the client uses no environment variable: no .env file is read (envDir: false, Vite looks for
  // neither .env, .env.local nor .env.<mode>, at build time, in development and in the tests)
  envDir: false,
  // manifest (dist/.vite/manifest.json) read by deploy/prune-assets.mjs; never served
  // (express.static ignores dot files)
  build: { outDir: 'dist', emptyOutDir: true, manifest: true },
  server: {
    // development: proxies the API and the icons (served by the server from ICONS_DIR) to the local
    // Node server
    proxy: { '/api': 'http://localhost:8088', '/icons': 'http://localhost:8088' },
  },
})

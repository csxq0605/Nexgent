/**
 * The renderer build (W6): `index.html` → `dist/renderer/`, which the main
 * process serves from `app://nexgent/`. Relative asset URLs, no inline
 * scripts (the page CSP is `script-src 'self'`). Vitest reads the same file;
 * the renderer's component tests opt into jsdom per file.
 */
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome140',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
})

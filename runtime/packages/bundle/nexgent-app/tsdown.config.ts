import { defineConfig } from 'tsdown'

/** The application owns both the request observer and the native trial consumer. */
export default defineConfig({
  entry: ['lib/types/{index,architecture-trials}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

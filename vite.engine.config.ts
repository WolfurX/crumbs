import { defineConfig } from 'vite'
// Builds scripts/engine-test.ts for Node so the live test runs the real src/lib code.
export default defineConfig({
  build: { ssr: process.env.ENGINE_ENTRY ?? 'scripts/engine-test.ts', outDir: process.env.ENGINE_OUT ?? 'dist-engine', emptyOutDir: true, target: 'node22', rollupOptions: { output: { entryFileNames: '[name].mjs' } } },
  ssr: { noExternal: [] },
})

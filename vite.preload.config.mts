import { defineConfig } from 'vite';

/** Bundle the preload entry into one CommonJS file.
 *
 * Electron sandboxed renderers cannot `require()` local preload modules, so
 * the domain modules under `electron/preload-*.ts` must be inlined into
 * `dist-electron/preload.js` even though the main process modules stay
 * separate.
 */
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: 'electron/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});

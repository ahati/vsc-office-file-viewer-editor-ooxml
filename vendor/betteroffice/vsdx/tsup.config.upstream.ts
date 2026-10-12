/**
 * REFERENCE ONLY — upstream tsup config for `@betteroffice/vsdx`, kept verbatim below this header.
 *
 * Upstream path: `packages/vsdx/tsup.config.ts` @ openooxml/betteroffice 57fc1984 (2026-10-13).
 * We do NOT use tsup: the vendored vsdx core is bundled with esbuild (DESIGN §5, scripts/build.mjs),
 * and tsup is not a dependency of this repo. Do not wire this file into any build.
 * It is kept for re-sync diffing only: it records upstream's bundler expectations
 * (entry `src/index.ts`, ESM output, dts, tree-shaken/minified, and the post-build copy of
 * `src/wasm/generated/vsdx_wasm_bg.wasm` next to the emitted JS).
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' }, format: ['esm'], dts: true, splitting: true,
  sourcemap: false, clean: true, treeshake: true, minify: true,
  onSuccess: async () => {
    await mkdir('dist/generated', { recursive: true });
    await copyFile('src/wasm/generated/vsdx_wasm_bg.wasm', 'dist/generated/vsdx_wasm_bg.wasm');
  },
});

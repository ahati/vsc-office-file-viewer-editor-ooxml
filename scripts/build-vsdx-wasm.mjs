#!/usr/bin/env node
/**
 * Builds `vsdx_wasm_bg.wasm` plus the wasm-bindgen glue from the vendored Rust closure and
 * vendors both into `vendor/betteroffice/vsdx/src/wasm/generated/`.
 *
 * This is a Node ESM port of the upstream build for the single `vsdx-wasm` module:
 *   - openooxml/betteroffice@57fc1984 `scripts/build-vsdx-wasm.ts`
 *   - openooxml/betteroffice@57fc1984 `scripts/wasm.ts` (`buildWasmModules`)
 * Reference copies of both live in `vendor/betteroffice/rust/upstream-scripts/`. The upstream
 * fingerprint/stamp caching is intentionally not ported: CI caches `target/wasm-pack` and
 * `target/cargo` instead, and a local rebuild is the safe default after touching the vendored
 * crates. Everything else — the exact wasm-pack version assertion, the wasm-opt requirement,
 * the glue fallback rewrite and the artifact copies — is reproduced 1:1.
 *
 * Usage: `npm run build:vsdx-wasm` (or `node scripts/build-vsdx-wasm.mjs`).
 *
 * Prerequisites (installed out of band; this script never installs anything and never touches
 * the network beyond cargo's own registry access):
 *   - cargo (rustup toolchain pinned by ./rust-toolchain.toml, target wasm32-unknown-unknown)
 *   - wasm-pack, exactly 0.15.0
 *   - wasm-opt (binaryen) on PATH — wasm-pack would otherwise download a ~91 MB binaryen
 *     release mid-build, which is what upstream `requireWasmOpt()` exists to prevent.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Upstream asserts this exact version; 0.15.0 is the version the vendored .d.ts were generated with. */
const WASM_PACK_VERSION = '0.15.0';
/** `WasmModule` descriptor from upstream scripts/wasm.ts, for the vsdx module only. */
const CRATE = 'vsdx-wasm';
const NAME = 'vsdx_wasm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustRoot = resolve(root, 'vendor/betteroffice/rust');
const cratePath = resolve(rustRoot, 'crates', CRATE);
const outDir = resolve(root, 'target/wasm-pack', CRATE);
const generatedDir = resolve(root, 'vendor/betteroffice/vsdx/src/wasm/generated');

/** `<tool> --version`; returns null when the tool is not on PATH. */
function toolVersion(tool) {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  const code = result.error && typeof result.error === 'object' && 'code' in result.error ? result.error.code : undefined;
  if (code === 'ENOENT') return null;
  if (result.status !== 0) {
    console.error(`[vsdx-wasm] \`${tool} --version\` failed with status ${result.status}`);
    console.error(result.stderr?.trim() ?? '');
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function requireTools() {
  const missing = [];
  const cargo = toolVersion('cargo');
  if (!cargo) missing.push('cargo — install the Rust toolchain (rustup; see ./rust-toolchain.toml)');
  const wasmPack = toolVersion('wasm-pack');
  if (!wasmPack) {
    missing.push(`wasm-pack ${WASM_PACK_VERSION} — cargo install wasm-pack --version ${WASM_PACK_VERSION} --locked`);
  } else if (wasmPack !== `wasm-pack ${WASM_PACK_VERSION}`) {
    missing.push(`wasm-pack ${WASM_PACK_VERSION} — found "${wasmPack}"`);
  }
  const wasmOpt = toolVersion('wasm-opt');
  if (!wasmOpt) {
    missing.push(
      'wasm-opt (binaryen) — brew install binaryen, apt-get install binaryen, or https://github.com/WebAssembly/binaryen/releases'
    );
  }
  if (missing.length > 0) {
    console.error('[vsdx-wasm] missing prerequisites:');
    for (const item of missing) console.error(`  - ${item}`);
    console.error('[vsdx-wasm] nothing was built.');
    process.exit(1);
  }
  return { cargo, wasmPack, wasmOpt };
}

/**
 * Sorts the raw wasm exports a wasm-bindgen declaration file lists, exactly like upstream
 * scripts/wasm.ts `sortWasmExportDeclarations` (symbol order shifts between toolchains).
 * Used only to compare freshly generated declarations against the vendored ones.
 */
function sortWasmExportDeclarations(text) {
  const EXPORT_DECLARATION = /^\s*(?:readonly|export const) ([\w$]+): .*;$/;
  const lines = text.split('\n');
  const open = lines.indexOf('export interface InitOutput {');
  const start = open >= 0 ? open + 1 : lines.findIndex((line) => EXPORT_DECLARATION.test(line));
  let end = Math.max(start, 0);
  while (end < lines.length && EXPORT_DECLARATION.test(lines[end])) end += 1;
  const rest = lines.slice(end);
  if (start < 0 || end === start || (open >= 0 ? rest[0] !== '}' : rest.some((line) => EXPORT_DECLARATION.test(line)))) {
    throw new Error('unexpected wasm-bindgen declaration layout');
  }
  const name = (line) => EXPORT_DECLARATION.exec(line)?.[1] ?? '';
  const sorted = lines.slice(start, end).sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  return [...lines.slice(0, start), ...sorted, ...rest].join('\n');
}

const tools = requireTools();
console.log(`[vsdx-wasm] cargo: ${tools.cargo}`);
console.log(`[vsdx-wasm] ${tools.wasmPack}`);
console.log(`[vsdx-wasm] ${tools.wasmOpt}`);

// Same invocation as upstream (`wasm-pack build <crate> --release --target web --out-dir <out> --locked`).
// Upstream runs it from the monorepo root and sets no environment variables; we pin cwd to the repo root
// (so rustup finds ./rust-toolchain.toml) and redirect cargo's target dir to <repo>/target/cargo so the
// read-only vendored tree stays clean. `--locked` keeps vendor/betteroffice/rust/Cargo.lock authoritative.
const build = spawnSync(
  'wasm-pack',
  ['build', cratePath, '--release', '--target', 'web', '--out-dir', outDir, '--locked'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: resolve(root, 'target/cargo') },
  }
);
if (build.status !== 0) {
  console.error(`[vsdx-wasm] wasm-pack failed with status ${build.status}`);
  process.exit(build.status ?? 1);
}

// Post-processing, mirroring upstream scripts/wasm.ts `buildWasmModules`.
await mkdir(generatedDir, { recursive: true });
const glue = await readFile(join(outDir, `${NAME}.js`), 'utf8');
const fallback = `module_or_path = new URL('${NAME}_bg.wasm', import.meta.url);`;
if (!glue.includes(fallback)) {
  throw new Error(`[vsdx-wasm] wasm-pack glue fallback changed (${NAME}); wasm-pack output is incompatible with this script`);
}
await writeFile(
  join(generatedDir, `${NAME}.js`),
  glue.replace(fallback, `throw new Error('${CRATE} requires an explicit module or URL');`)
);
await copyFile(join(outDir, `${NAME}_bg.wasm`), join(generatedDir, `${NAME}_bg.wasm`));

// The two .d.ts files are tracked in git and kept as-is (unlike upstream, which rewrites them on
// every build): they are the checked-in API contract our TypeScript compiles against. A mismatch
// means the installed wasm-bindgen emits a different surface, i.e. the vendored declarations are
// stale — loud warning, not a hard failure, so a build never stalls on a formatting-only diff.
let declarationsDrift = false;
for (const file of [`${NAME}.d.ts`, `${NAME}_bg.wasm.d.ts`]) {
  const fresh = sortWasmExportDeclarations(await readFile(join(outDir, file), 'utf8'));
  const tracked = await readFile(join(generatedDir, file), 'utf8');
  if (fresh !== tracked) {
    declarationsDrift = true;
    console.error(`[vsdx-wasm] WARNING: vendored ${file} differs from the freshly generated wasm-bindgen output.`);
    console.error(`[vsdx-wasm]          Re-vendor it from ${join(outDir, file)} (upstream sorts the export declarations).`);
  }
}

const size = (await stat(join(generatedDir, `${NAME}_bg.wasm`))).size;
console.log(`[vsdx-wasm] vendored ${NAME}.js + ${NAME}_bg.wasm (${(size / 1024 / 1024).toFixed(2)} MiB) into vendor/betteroffice/vsdx/src/wasm/generated`);
if (declarationsDrift) console.log(`[vsdx-wasm] declared API drift detected — see warnings above`);

# Vendored BetterOffice sources

Everything under `vendor/betteroffice/` is a **read-only snapshot of upstream sources**, not code we
own. Local changes are allowed only where this document records them; anything else must be fixed
upstream or re-applied on the next sync.

## Provenance

| | |
|---|---|
| Upstream | [openooxml/betteroffice](https://github.com/openooxml/betteroffice) (BetterOffice — Copyright 2026 Elia Hilse, The OpenOOXML Project) |
| Revision | `57fc1984`, snapshot date 2026-10-13 |
| License | Apache-2.0 (upstream `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.md`) |
| Why vendored | `@betteroffice/vsdx` is `private: true` and unpublished (SCOPING §5); there is no npm package to depend on |

The snapshot is source-only: no `dist/` output, no `node_modules`, no `target/`.

## What was copied, and from where

| Vendored path | Upstream path | Notes |
|---|---|---|
| `vsdx/src/**` | `packages/vsdx/src/**` | **all `*.test.ts` excluded** (we run our own shell tests); `render/`, `wasm/`, `collaboration/`, `index.ts`, `shapeData.ts`, `types.ts` keep their directory structure |
| `vsdx/src/wasm/generated/vsdx_wasm.d.ts` | same | tracked upstream; the API contract the vendored TS compiles against |
| `vsdx/src/wasm/generated/vsdx_wasm_bg.wasm.d.ts` | same | tracked upstream (raw wasm export surface) |
| `vsdx/tsup.config.upstream.ts` | `packages/vsdx/tsup.config.ts` | **reference only**, header comment prepended; we bundle with esbuild, tsup is not wired |
| `shared/collaboration-limits.ts` | `shared/collaboration-limits.ts` | repo-level shared module the vsdx core imports; easy to miss on a re-sync (SCOPING R10) |
| `rust/crates/vsdx-wasm` | `crates/vsdx-wasm` | the wasm-bindgen boundary crate |
| `rust/crates/vsdx-{edit,parse,eval,resolve,render,raster,formula,validate}` | `crates/*` | full transitive Rust closure of `vsdx-wasm`, verified from the `Cargo.toml` files; `vsdx-raster/assets/` is the re-rooted `xlsx-raster/assets/` (modification 2) |
| `rust/crates/ooxml-{opc,drawingml,text}` | `crates/*` | shared OOXML crates in that closure |
| `rust/Cargo.toml` | `Cargo.toml` (repo root) | **byte-identical**, unmodified: workspace members/globs, `[workspace.package]`, `[workspace.dependencies]`, release profiles (`opt-level = "s"`, `lto = true`, per-package `opt-level = 3` for `ooxml-text`/`yrs`) |
| `rust/Cargo.lock` | `Cargo.lock` (repo root) | **pruned**, see below |
| `rust/upstream-scripts/build-vsdx-wasm.ts`, `rust/upstream-scripts/wasm.ts` | `scripts/*.ts` | reference copies; our Node port is `scripts/build-vsdx-wasm.mjs` |

Each copied crate keeps its `README.md` (referenced by `readme = "README.md"` in its manifest) and its
`tests/` tree, because `vsdx-edit`/`vsdx-wasm` unit tests `include_bytes!` fixtures from
`crates/vsdx-parse/tests/fixtures/` through relative paths (`../../vsdx-parse/tests/fixtures/...`) that
must stay resolvable. Rust `tests/`/`#[cfg(test)]` code is never compiled for the release wasm build.

## Local modifications (Apache-2.0 §4(b) — "modified files must carry prominent notices")

1. **`vsdx/src/collaboration/protocol.ts`** — one import rewritten:

   ```diff
   -import { MAX_COLLABORATION_FRAME_BYTES } from '../../../../shared/collaboration-limits';
   +import { MAX_COLLABORATION_FRAME_BYTES } from '../../../shared/collaboration-limits';
   ```

   Upstream's monorepo-relative path (`<root>/shared/...`) does not exist inside the vendored tree;
   the vendored path resolves to `vendor/betteroffice/shared/collaboration-limits.ts`. A prominent
   comment at the top of the file records the edit. This is the **only** source edit in the snapshot
   (verified: `grep -rn "\.\./\.\./\.\." vendor/betteroffice/**/*.ts` matches nothing else).

2. **`rust/crates/vsdx-raster/src/lib.rs`** — one `include_bytes!` path rewritten, plus its asset:

   ```diff
   -const FONT_BYTES: &[u8] = include_bytes!("../../xlsx-raster/assets/Carlito-Regular.ttf");
   +const FONT_BYTES: &[u8] = include_bytes!("../assets/Carlito-Regular.ttf");
   ```

   `crates/vsdx-raster` embeds Carlito Regular at compile time, but upstream keeps the file in
   `crates/xlsx-raster/assets/` — a crate outside the vendored closure. Copying `crates/xlsx-raster`
   whole is not an option: `members = ["crates/*"]` would pick it up as a workspace member and drag
   in the un-vendored xlsx dependency closure (and break `Cargo.lock` under `--locked`). The three
   upstream files (`Carlito-Regular.ttf` — byte-identical, sha256
   `f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595`, `OFL.txt`, `README.md`) were
   therefore re-rooted at `rust/crates/vsdx-raster/assets/` and only the included path changed. A
   comment in the file records the edit. Without it the release wasm build fails with
   `couldn't read crates/vsdx-raster/src/../../xlsx-raster/assets/Carlito-Regular.ttf`.

3. **`rust/Cargo.lock`** — pruned, not hand-edited: 245 locked packages → 158, because the vendored
   workspace only declares the 12 crates in the closure. The root `Cargo.toml` was *not* edited
   (`members = ["crates/*"]` already selects exactly the vendored crates); the lock was regenerated by
   running `cargo metadata --manifest-path vendor/betteroffice/rust/Cargo.toml` once. No dependency
   version changed (no added/changed `version =` lines; additions are only dependency-name edges over
   the same pinned versions), and `cargo metadata --locked` passes against the pruned file — which is
   what the build script relies on.

3. **`vsdx/tsup.config.upstream.ts`** — header comment only (never executed).
4. **`rust/crates/vsdx-raster/assets/{Carlito-Regular.ttf,OFL.txt,README.md}`** — added files from
   upstream `crates/xlsx-raster/assets/`; see modification 2.

Nothing else was reformatted. Upstream carries **no per-file license headers** at this revision (0 of
13 vendored TS files, 0 of 97 Rust files contain `Apache`/`Copyright`/`SPDX`): attribution is
repo-level only, which is why the root `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md` copies matter.

## License obligations

- Apache-2.0. Keep upstream's `LICENSE` + `NOTICE` ("BetterOffice, Copyright 2026 Elia Hilse, The
  OpenOOXML Project") + `THIRD-PARTY-NOTICES.md` (the docx engine derives from eigenpal/docx-editor,
  also Apache-2.0) in the repo root and in the packaged VSIX — SCOPING §7.
- Mark modified vendored files as modified (done: `protocol.ts` comment; `vsdx-raster/src/lib.rs`
  comment; this file).
- Do not add per-file license headers to vendored files during a sync — it would turn every re-sync
  into an unreadable diff.

## Building the vendored wasm

```bash
npm run build:vsdx-wasm     # -> scripts/build-vsdx-wasm.mjs
```

Prerequisites are installed out of band (the script never installs anything; `~/.local/bin` is not on
PATH by default, so prepend it or symlink the two binaries):

```bash
# wasm-pack 0.15.0 (static musl binary)
curl -fsSL -o /tmp/wasm-pack.tar.gz \
  https://github.com/rustwasm/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-x86_64-unknown-linux-musl.tar.gz
tar -xzf /tmp/wasm-pack.tar.gz -C /tmp && cp /tmp/wasm-pack-v0.15.0-x86_64-unknown-linux-musl/wasm-pack ~/.local/bin/

# binaryen version_132 — the exact release + sha256 upstream CI pins (.github/actions/wasm-toolchain)
curl -fsSL -o /tmp/binaryen.tar.gz \
  https://github.com/WebAssembly/binaryen/releases/download/version_132/binaryen-version_132-x86_64-linux.tar.gz
echo "195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572  /tmp/binaryen.tar.gz" | sha256sum -c -
tar -xzf /tmp/binaryen.tar.gz -C /tmp --strip-components=1 && cp /tmp/bin/* ~/.local/bin/

rustup target add wasm32-unknown-unknown   # also pinned in ./rust-toolchain.toml
```

It asserts `wasm-pack 0.15.0` + `wasm-opt` on PATH, runs
`wasm-pack build vendor/betteroffice/rust/crates/vsdx-wasm --release --target web --out-dir target/wasm-pack/vsdx-wasm --locked`
(Rust pinned by `./rust-toolchain.toml`, cargo target dir redirected to `target/cargo` so the vendored
tree stays clean, no other env changes — upstream sets none), then reproduces upstream
`scripts/wasm.ts` post-processing: the wasm-bindgen glue fallback
`module_or_path = new URL('vsdx_wasm_bg.wasm', import.meta.url);` is replaced with
`throw new Error('vsdx-wasm requires an explicit module or URL');` (the webview always passes wasm
bytes, DESIGN §4), and `<name>_bg.wasm` + the rewritten `<name>.js` are copied into
`vsdx/src/wasm/generated/`. Unlike upstream we do **not** rewrite the tracked `.d.ts` files; the script
compares the fresh wasm-bindgen declarations (upstream sort applied) against them and warns on drift.

## Re-sync procedure

1. `git -C <upstream> fetch --depth 1 origin <rev>` and re-record the revision above.
2. Diff the file lists: `packages/vsdx/src/**`, the 12 `crates/*` manifests' dependency sections
   (the closure is not guaranteed stable — re-derive it from `Cargo.toml`), `shared/`, root
   `Cargo.toml`/`Cargo.lock`, `scripts/{build-vsdx-wasm,wasm}.ts`.
3. Re-apply the single import fix in `vsdx/src/collaboration/protocol.ts` (and fix any *new* import
   that reaches outside `packages/vsdx`, i.e. `grep -rn "\.\./\.\./\.\." vendor/betteroffice --include='*.ts'`),
   and re-apply the `vsdx-raster` font `include_bytes!` path fix (modification 2, `grep -rn 'xlsx-raster' vendor/betteroffice/rust`).
4. Re-prune `rust/Cargo.lock` by running `cargo metadata --manifest-path vendor/betteroffice/rust/Cargo.toml --locked`
   (drop `--locked` the first time) and confirm it settles.
5. Rebuild: `npm run build:vsdx-wasm`; check the size delta and the `.d.ts` drift warning.
6. `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck vendor/betteroffice/vsdx/src/index.ts`
   must stay clean — it is the vendoring checklist's type-level guard (SCOPING R10).

Exit ramp: if `@betteroffice/vsdx` is ever published to npm, replace this directory with the package
dependency (the extension reaches the engine only through `webview/mounts/*` adapters, DESIGN §3.6).

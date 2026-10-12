# Design — BetterOffice Viewer

Technical design for the requirements in [`docs/PRD.md`](./PRD.md). Upstream analysis and evidence:
[`docs/SCOPING.md`](./SCOPING.md). Upstream pin under study: `openooxml/betteroffice@57fc1984`.

---

## 1. Overview

A VS Code extension contributing **custom editors** for `docx/docm`, `xlsx/xlsm`, `pptx/pptm`, `vsdx`. Each editor is
a webview running a BetterOffice engine. The engines are Rust compiled to WASM; docx/xlsx/pptx run their session in a
dedicated **Web Worker**; vsdx runs on the webview main thread. The extension host stays thin: file I/O, lifecycle,
settings, diagnostics, save/backup orchestration.

```
┌──────────────────────────── extension host (Node) ────────────────────────────┐
│ CustomEditorProvider (per format)                                             │
│  openCustomDocument → read bytes via vscode.workspace.fs                      │
│  resolveCustomEditor  → build HTML (CSP/nonce), wire postMessage protocol     │
│  save/backup/revert   → engine save bytes written through workspace.fs        │
│  FileSystemWatcher    → reload / conflict policy (PRD V5, E4)                 │
│  OutputChannel + diagnostics ring (PRD W4)                                    │
└───────────────┬───────────────────────────────────────────────┬───────────────┘
                │ postMessage (structured clone / transfer)     │ asWebviewUri resources
┌───────────────▼────────────────── webview (iframe) ──────────▼───────────────┐
│ entry-{format}.js (IIFE, nonce)                                               │
│  assetBootstrap: fetch worker/wasm/font assets → blob URLs / ArrayBuffers     │
│  React mount: DocxEditor | XlsxEditor | PptxEditor (readOnly|editable)        │
│  vsdx: own canvas shell (initWasm → openDiagram → layoutPage → paintPage)     │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ new Worker(blobUrl, {type:'module'})
┌───────────────▼────────────────── engine worker ──────────────────────────────┐
│ residentEngineWorker (docx, 4 wasm modules)                                   │
│ xlsxSessionWorker / pptxSessionWorker (1 wasm each)                           │
│  · wasm supplied as bytes via injected fetch shim (§4) — never fetched itself │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Key constraints** (all verified in SCOPING):
- Workers must be created from `blob:`/`data:` URIs, and module workers importing webview-resource URIs are broken
  since VS Code 1.119 (microsoft/vscode#315494, open) → **workers are fully self-contained bundles; all resources are
  fetched on the webview main thread and injected** (§4).
- Engines have **no override knobs** for asset locations: wasm/worker URLs are `new URL(…, import.meta.url)`
  literals; the only documented wasm override is `initWasm(bytes | WebAssembly.Module)` → **we rewrite at bundle
  time** (§5).
- Webview MIME is extension-derived: `.wasm → application/wasm`, `.mjs/.js → application/javascript`; emitted asset
  names must keep those suffixes (§5.3).

## 2. Repository layout

```
/
├─ docs/                      PRD.md, DESIGN.md, SCOPING.md
├─ src/                       extension host (TypeScript, CJS, bundled by esbuild)
│  ├─ extension.ts            activation, provider registration, commands
│  ├─ providers/
│  │  ├─ officeProvider.ts    shared custom-editor provider (docx/xlsx/pptx)
│  │  ├─ vsdxProvider.ts      vsdx provider (read-only v1; editing P2)
│  │  └─ document.ts          OfficeDocument: bytes, format, dirty, backup
│  ├─ protocol.ts             message types shared with webview (mirrored copy)
│  ├─ config.ts, links.ts, diagnostics.ts, util.ts
│  └─ test-integration/       @vscode/test-electron suite
├─ webview/                   webview-side sources (ESM, bundled per entry)
│  ├─ entries/{docx,xlsx,pptx,vsdx}.ts
│  ├─ bootstrap/
│  │  ├─ assetBootstrap.ts    manifest-driven fetch of workers/wasm/fonts → blobs/bytes
│  │  └─ workerFetchShim.ts   preamble injected into worker bundles (§4.2)
│  ├─ mounts/{docx,xlsx,pptx}.tsx   React mount + toolbar/chrome wiring
│  ├─ vsdx/                   viewer shell (page tabs, zoom, layers, pan)
│  ├─ chrome/                 find bar, zoom controls, status strip, error panel
│  └─ fonts.ts                per-format font loading (SCOPING §6)
├─ vendor/betteroffice/
│  ├─ vsdx/                   snapshot of packages/vsdx/src (+ tracked .d.ts, tsup config)
│  ├─ shared/collaboration-limits.ts
│  ├─ rust/                   crates closure + root Cargo.toml/Cargo.lock + upstream scripts/wasm.ts
│  └─ README.md               provenance: upstream SHA, paths, sync procedure, license notes
├─ media/                     icon.png, marketplace assets
├─ scripts/                   build-vsdx-wasm.ts, build.mjs (esbuild), run-tests.mjs, package-vsix.mjs
├─ esbuild.mjs                4 webview entries + 3 worker entries + host + vendor build
├─ package.json, tsconfig*.json, .vscodeignore, LICENSE, NOTICE
```

## 3. Extension-host design

### 3.1 Providers

One provider class parameterized by format; one `viewType` per format family
(`betterofficeViewer.docx|docm|xlsx|xlsm|pptx|pptm|vsdx`), each with `priority: "default"`.
`supportsMultipleEditorsPerDocument: false` (one engine per document; memory bound, SCOPING R7).

- **M1:** `CustomReadonlyEditorProvider` for all formats (viewer-only, matches PRD M1).
- **M2 (editing):** docx/xlsx/pptx switch to `CustomEditorProvider` with full
  `CustomDocument` lifecycle (`save`, `saveAs`, `backup`, `revert`, `onDidChangeCustomDocument`). vsdx stays
  read-only until E7.

### 3.2 Document model

```
OfficeDocument implements vscode.CustomDocument {
  uri, format, bytes: Uint8Array
  dirty: boolean                // set via 'contentChanged' messages (M2)
  lastSnapshot?: Uint8Array     // debounced engine snapshots for backup (§3.4)
  onDidDispose / onDidChange (edit events for undo integration, M2)
}
```

Files are read through `vscode.workspace.fs` only (Remote/WSL/Codespaces-safe, PRD W1). Bytes are transferred to the
webview as `ArrayBuffer` (transferred, zero-copy where possible).

### 3.3 Webview lifecycle & reload

Ports the proven predecessor flow (SCOPING): webview posts `ready` → host sends `init {format, bytes, config,
fileName, fontsManifest}` → webview posts `loaded`/`load-error`. A `FileSystemWatcher` on the document re-reads and
pushes `fileChanged {bytes}`; while dirty (M2) the watcher instead triggers the conflict prompt (E4). Panels dispose →
host logs, webview terminates worker (`worker.terminate()`) and drops wasm handles.

### 3.4 Save & backup (M2)

```
Ctrl+S → provider.save(doc):
  1. post 'requestSave' → webview calls engine api.save() → posts 'saved {bytes}'
  2. host writes via workspace.fs (atomic temp+rename), clears dirty
Auto-save: identical path, throttled.
backup(): if lastSnapshot younger than 800ms use it, else request fresh snapshot;
  returns {id, delete} — VS Code restores by re-opening and injecting backup bytes.
Undo/redo: webview owns engine undo; host mirrors edits as CustomDocumentEditEvent
  {label, undo(): post 'undo', redo(): post 'redo'} for the VS Code edit history.
```

Failure mode: engine `save()` refuses (e.g. xlsx `XlsxSaveRefusedError`) → host surfaces the refusal text in a
non-blocking message and leaves the document dirty.

### 3.5 Diagnostics

Static ring buffer (200 lines, predecessor pattern) mirrored to an `OutputChannel`
("BetterOffice Viewer") and exposed via the `betterofficeViewer.getDiagnostics` command. Engine error events
(`onError`, `DocxWorkerError` stages, pptx chunk-load errors) are captured with format, phase, and timing
(`init → wasmReady → sessionReady → firstFrame`), powering the N1 latency and support workflows.

### 3.6 Upstream adapter layer

Each format gets a thin adapter module (`webview/mounts/*`) owning: engine imports, prop construction, event
normalization. Upstream API churn (`@experimental` markers, pptx viewer-prop deprecations) is absorbed here — the rest
of the codebase never imports `@betteroffice/*` directly except through adapters.

## 4. Worker & WASM strategy (the core mechanism)

### 4.1 Why

The engines hard-code `new Worker(new URL('./x.mjs', import.meta.url), {type:'module'})` and fetch their wasm
relative to `import.meta.url`. In webviews: (a) workers must be blob/data URIs, (b) worker-context fetch/import of
webview resources is broken on VS Code ≥ 1.119 (#315494), (c) wasm URLs have no override except `initWasm(bytes)`
(xlsx/pptx/vsdx) and docx's worker-protocol host-module message (`ResidentEngineWorkerHostModule`).

### 4.2 Design: self-contained workers + injected assets

1. **Worker bundling.** esbuild produces one self-contained IIFE per engine worker
   (`out/media/workers/{residentEngine,xlsxSession,pptxSession}.js`): the worker entry imports the upstream worker
   module; all chunk imports are inlined; `new URL('*.wasm', import.meta.url)` expressions inside are rewritten to
   lookups in an injected manifest (§5.2).
2. **Bootstrap preamble.** Our worker entries begin with `workerFetchShim.ts`: the worker waits for a first
   `{type:'bo-assets', assets: Record<name, ArrayBuffer>}` postMessage, installs a `fetch`/`Request` shim that serves
   those bytes for the manifest URLs, then continues with engine code. Consequence: the worker never performs a
   network/service-worker request — the entire #315494 class is avoided **without patching engine sources**.
3. **Webview main-thread fetch.** `assetBootstrap.ts` (runs before mounting) fetches, via `webview.asWebviewUri`
   (main-thread fetch of webview resources is the supported path): worker bundles → `blob:` URLs; wasm files →
   `ArrayBuffer`s; then posts the wasm byte map into the worker (shim) and/or calls `initWasm(bytes)` for vsdx.
4. **docx preferred path (spike S1).** The docx worker protocol already carries a host-module message type. If it
   accepts wasm `ArrayBuffer`s (expected), we skip the fetch shim for docx and supply modules through the protocol;
   the shim remains the universal fallback.
5. **vsdx** runs on the main thread: `initWasm(bytes)` → `openDiagram(bytes, {fonts})`; no worker involved.

Instantiate with `instantiateStreaming` when `Content-Type: application/wasm` is present, fallback to
`instantiate(bytes)`; both compile with CSP `script-src 'wasm-unsafe-eval'` (no `unsafe-eval` anywhere).

### 4.3 Failure handling

Bootstrap failures (asset fetch, worker spawn, wasm compile) surface the structured error panel (V6) with the phase
name and a "Copy diagnostics" action. A single retry with a fresh blob is attempted once (guards against transient
service-worker state, microsoft/vscode#318660).

## 5. Asset pipeline (esbuild)

`scripts/build.mjs` supersedes the predecessor `esbuild.mjs`, extending its proven
`new URL(..., import.meta.url)` rewrite plugin (SCOPING, predecessor esbuild.mjs):

| Build target | Entries | Output | Notes |
|---|---|---|---|
| host | `src/extension.ts` | `out/extension.js` (CJS, external: vscode) | |
| webview | `webview/entries/{docx,xlsx,pptx,vsdx}.ts` | `out/media/webview-{format}.js` (IIFE, es2020) | React 19 + engine adapters inlined; docx also imports `@betteroffice/docx-react/styles.css` → emitted `webview-docx.css` |
| workers | upstream worker modules via `webview/entries/worker-{...}.ts` wrappers | `out/media/workers/*.js` (IIFE, single file) | chunk-inlined, no dynamic imports remain |
| vendored vsdx | `vendor/betteroffice/vsdx` via tsup config mirrored from upstream | `out/media/vendor/vsdx/index.js` + copied `vsdx_wasm_bg.wasm` | §7 |

**Plugins:**
1. `asset-import-rewrite` — rewrites `new URL('<file>.wasm|ttf', import.meta.url).href` → static ESM import of the
   asset (esbuild emits it under `out/media/assets/[name]-[hash]`, loader `file`), and rewrites
   `new URL('<name>.mjs', import.meta.url)` inside worker/bundle code → `__BO_ASSET__['<name>']` lookups resolved from
   the injected manifest (`define: {__BO_ASSET_MANIFEST__: …}` generated at build end from emitted assets).
2. `worker-entry-marker` — marks worker wrappers so the manifest generator classifies them as *fetched-as-blob*
   (not hot-linked).
3. `vendor-guard` — asserts vendored vsdx files retain Apache-2.0 headers and that `shared/collaboration-limits.ts`
   is present (SCOPING R10).

**Naming constraints:** emitted wasm keeps the `.wasm` suffix (MIME), worker bundles keep `.js`; no hash-only names.

## 6. Security model (PRD S1–S5)

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  base-uri ${cspSource};
  img-src ${cspSource} data: blob:;
  media-src ${cspSource} blob:;
  font-src ${cspSource} [+ cdn.jsdelivr.net when cjkFonts=cdn];
  script-src 'nonce-{nonce}' 'wasm-unsafe-eval' [+ cdn origin when enabled];
  style-src 'unsafe-inline' [+ cdn origin when enabled];
  worker-src data: blob:;
  connect-src ${cspSource} data: blob: [+ cdn origin when enabled];">
```

- Nonce on entry script only; worker loads from blob (covered by `worker-src`, which must be explicit — an unset
  `worker-src` falls back to `script-src`'s nonce-only list and blocks blob workers, microsoft/vscode#331633).
- `localResourceRoots: [extensionUri]`; no Node in webview; no `eval` (wasm keyword only).
- Links: allowlist `http/https/mailto/tel` → `env.openExternal` (ported from predecessor).
- Network audit test (S1): instrumented `fetch`/`XMLHttpRequest`/`WebSocket` counters + CSP violation listener during
  the full sample-corpus run must report **zero** off-`cspSource` requests when CJK CDN is off.
- Macros/OLE: engines parse package parts only; no activation path exists — asserted by the S4 sandbox test.

## 7. VSDX subsystem

### 7.1 Vendoring

Snapshot (per SCOPING §5 decision): `packages/vsdx/src/**` + tracked `src/wasm/generated/*.d.ts` + `tsup.config.ts`
(adapted, upstream recorded) + `shared/collaboration-limits.ts` into `vendor/betteroffice/`. Rust closure
(`crates/vsdx-*`, `crates/ooxml-{opc,drawingml,text}`, root `Cargo.toml`/`Cargo.lock`, upstream `scripts/wasm.ts` +
`build-vsdx-wasm.ts`) under `vendor/betteroffice/rust/`. `vendor/README.md` records the upstream SHA, file list, sync
procedure (`git diff` review against upstream), and license obligations (headers, LICENSE, NOTICE copies).

### 7.2 Build

`scripts/build-vsdx-wasm.ts` (Node port of the upstream bun wrapper):
`wasm-pack build rust/vsdx-wasm --release --target web --out-dir … --locked` with **wasm-pack == 0.15.0** (asserted),
`wasm-opt -O3` (binaryen; CI pins `version_132`), Rust pinned in our repo (`rust-toolchain.toml` — upstream doesn't
pin; we do, SCOPING R3), target `wasm32-unknown-unknown`. CI caches `target/wasm-pack` keyed on the fingerprint
inputs (crate tree + rustc version + binaryen version). Artifact ~5–6 MB expected → `out/media/assets/vsdx_wasm_bg.wasm`.

### 7.3 Viewer shell (M1)

Custom, no React (upstream `vsdx-react` is edit-oriented and would drag in i18n + boundary scripts):
`initWasm(bytes)` → `openDiagram(bytes, {fonts})` → `snapshot()` renders page list; `layoutPage(i)` +
`paintPage(ctx, …)`/`sizeCanvasForPage`/`effectiveDprForSurface` per visible page (virtualized, DPR-aware);
page tab strip, layer visibility via `pageLayers`/`setLayerVisible`, zoom/fit/pan via `canvasPointToModel` mapping,
shape-text find over `snapshot()`, hit-test omitted (read-only). Export commands (X1–X2) call
`exportPng(page, scale)`/`exportSvg()`/`exportPdf()`. Editing (E7, P2) maps context-menu actions to
`moveShape`/`setShapeText`/`resizeShape` + `save()`.

## 8. Fonts (SCOPING §6)

- Build bundles the Latin core TTFs as assets (from `@betteroffice/fonts`, emitted under `out/media/assets/`,
  referenced by the generated manifest).
- **docx:** `configureDefaultFonts({ fonts: bundledFontModule })` once per webview (import path
  `@betteroffice/docx/layout`), `setGoogleFontsEnabled(false)`.
- **pptx/vsdx:** `loadBundledFontBytes(resolveMetricCompatFace('Arial', b, i) ?? resolveLastResortFace(...))` for the
  4 style variants → `fonts` props (`PptxFontFace[]` / `VsdxFontFace[]`) — exact upstream-demo pattern.
- **xlsx:** no font API (SCOPING R8) — engine-internal metrics; spike S3 documents quality.
- **CJK:** setting `betterofficeViewer.cjkFonts: "cdn"` lazily imports `@betteroffice/fonts/cdn` (adds the pinned
  jsdelivr origin to CSP `font-src`/`connect-src`/`script-src` for that panel) — the only network path in the
  product, opt-in, default off.

## 9. postMessage protocol (v1)

| Direction | type | Payload | Purpose |
|---|---|---|---|
| wv → host | `ready` | – | webview script loaded; host responds `init` |
| host → wv | `init` | `{format, bytes, config, fileName, fontsManifest}` | first open / reload |
| host → wv | `fileChanged` | `{bytes}` | external change while clean |
| wv → host | `loaded` | `{fileName, timings}` | render success (N1 telemetry via diagnostics) |
| wv → host | `load-error` | `{phase, message}` | V6 panel + diagnostics |
| wv → host | `link` | `{url}` | allowlisted external open |
| wv → host | `contentChanged` | `{label?}` | M2 dirty flag → `CustomDocumentEditEvent` |
| wv → host | `snapshot` | `{bytes}` (transfer) | debounced engine snapshot for backup |
| host → wv | `requestSave` | – | E1 flush → `saved` |
| wv → host | `saved` | `{bytes}` (transfer) | host writes; also used for `saveAs` |
| host → wv | `undo`/`redo` | – | VS Code edit-history integration (M2) |
| host → wv | `bo-assets` (worker) | `{assets: Record<name, ArrayBuffer>}` | §4.2 preamble handshake |
| wv → host | `state` | `{scroll, zoom, page}` | `getState/setState` restoration |

## 10. Settings (contributes.configuration)

```jsonc
"betterofficeViewer.editing":            { "type": "boolean", "default": true,  "description": "Open OOXML files editable (M2). When off, always read-only." },
"betterofficeViewer.fonts":              { "type": "string",  "default": "bundled", "enum": ["bundled", "off"], "description": "Bundled metric-compatible fonts for Office-accurate layout. 'off' uses system fonts only." },
"betterofficeViewer.cjkFonts":           { "type": "string",  "default": "off", "enum": ["off", "cdn"], "description": "Fetch CJK font faces from the pinned betteroffice CDN. The only network access this extension can perform." },
"betterofficeViewer.initialZoom":        { "type": "string",  "default": "fitPage", "enum": ["fitPage", "fitWidth", "100"] },
"betterofficeViewer.forceReadOnly":      { "type": "boolean", "default": false }   // alias kept explicit for policy admins
```

Commands: `betterofficeViewer.exportPng`, `betterofficeViewer.exportSvg` (vsdx), `betterofficeViewer.exportPdf`
(vsdx), `betterofficeViewer.print`, `betterofficeViewer.copyDiagnostics`, `betterofficeViewer.getDiagnostics`,
`betterofficeViewer.reload`.

## 11. Performance & memory

- **Lazy engines:** only the opened format's wasm/worker is fetched; no cross-format preload. docx's 20 MB edit-wasm
  is fetched during `init` with progress state in the panel (N1 budget covers it: upstream measures 485 ms avg render
  once loaded; wasm fetch is local disk through the SW).
- **Panel lifecycle:** no `retainContextWhenHidden` (docs: high memory overhead). Hidden panels are torn down; state
  (`scroll/zoom/page`) survives via `getState/setState`; reopen cost ≈ cold open (accepted, PRD N1 budgets hold).
- **Disposal:** worker `terminate()` + engine `dispose()` + release of byte references on `onDidDispose`; N3 target
  (≥ 90% returned) verified by a leak test (10 open/close cycles, process memory delta).
- **Virtualization:** docx/pptx/vsdx render viewport pages only (engines provide frame delta / display lists); xlsx
  viewports via engine session (upstream viewport-limits changesets).

## 12. Testing strategy

| Layer | Tooling | Coverage |
|---|---|---|
| Unit (host) | node:test via esbuild bundle | config, links allowlist, protocol types, manifest generator, vendorguard |
| Unit (webview) | vitest + jsdom/happy-dom | chrome components, vsdx shell logic, font resolution, shim |
| Integration | `@vscode/test-electron` (xvfb in CI) | ported predecessor suite (ready→loaded→reload→dispose, diagnostics, links) × 4 formats + editing flows (E1–E4) + CSP/network audit (S1) |
| Fidelity | upstream-style harness: render sample corpus → compare page counts + SSIM vs baseline images (N6) | docx/pptx/xlsx corpora + vsdx fixtures (shapes/connectors/layers/themes/CJK) |
| Compatibility | matrix job: VS Code stable + insiders × {linux, windows, macOS} | guards the #315494 regression class |
| Leak/perf | scripted open/close cycles, timing assertions | N1–N3 |

Samples: port predecessor `gen_samples.py`; add vsdx corpus (basic shapes, orthogonal connectors, layers, themes,
shape data, CJK labels, 2000+ shape page for budget rules).

## 13. CI/CD

- **build.yml:** typecheck (host + webview tsconfigs) → esbuild → unit + integration (linux) → artifact VSIX.
- **compat.yml (scheduled + on release PRs):** stable + insiders matrix, xvfb integration suite.
- **vsdx-wasm.yml:** containerized Rust toolchain (`rust-toolchain.toml`, wasm-pack 0.15.0, binaryen 132, Node 22)
  building vendored wasm; cached; artifact attached for the release workflow.
- **release.yml:** `vsce package` (Marketplace) + `ovsx publish` (Open VSX), provenance note + vendored SHA in
  release notes.
- `.vscodeignore` excludes sources, docs, vendor Rust tree (only built artifacts ship).

## 14. Milestone mapping

| PRD milestone | Design scope |
|---|---|
| M1 Viewer | §2, §3.1 (readonly provider), §3.3, §3.5–3.6, §4, §5, §6, §7, §8, §9 (viewer messages), §11–13; V*, S*, W* |
| M2 Editing | §3.2/3.4 save+backup+undo, E1–E6, X1–X4, settings `editing`, protocol M2 messages, editing tests |
| M3 Reach | E7 vsdx editing ops, W6 web entry (browser extension host spike), A3, perf tuning |

## 15. Design risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| D1 | Spike S1 fails (docx worker rejects wasm bytes via host module) | fetch-shim fallback (§4.2.2) — engine-source-free, already the universal path |
| D2 | New VS Code webview service-worker regressions | self-contained workers avoid the broken path entirely; compat matrix on insiders; error panel names the phase |
| D3 | Vendored vsdx drifts from upstream | vendorguard plugin + sync procedure in `vendor/README.md`; mechanical npm swap when upstream publishes |
| D4 | docx edit-wasm (20 MB) cold-open latency | budgeted in N1; progress UI; optional future: split parse-only viewer path (parse wasm 5.3 MB) if telemetry-free diagnostics show budget misses |
| D5 | Editing corruption edge cases | backup-before-save, E4 conflict policy, byte-diff corpus harness (E1 AC), upstream package-integrity warnings surfaced |
| D6 | React/engine bundle bloat | per-format entries (no shared chunk coupling), tree-shaken i18n via per-locale subpaths, VSIX budget tracked in CI (fail > 75 MB) |

# Scoping — BetterOffice-based VS Code Office & Visio Viewer

Successor to [`ahati.vscode-office-file-reader-viewer`](https://github.com/ahati/vscode-office-file-reader-viewer)
(@silurus/ooxml engine, docx/xlsx/pptx, 0.1.2), rebuilt on
[openooxml/betteroffice](https://github.com/openooxml/betteroffice) and extended with **Visio (.vsdx)** support.

Research basis: direct inspection of the upstream monorepo (pin `57fc1984`, 2026-10-13), npm registry data,
VS Code docs/issues, and marketplace crawl — details inline.

---

## 1. Summary

| | |
|---|---|
| **What** | Read-only high-fidelity viewers for `.docx/.docm`, `.xlsx/.xlsm`, `.pptx/.pptm`, **`.vsdx`** as VS Code custom editors |
| **Engine** | Word: `@docx-editor.dev/{core,react}` 2.29.0 (npm, Apache-2.0, DOM/ProseMirror paginated editor; replaced the interim `@betteroffice/docx`); `@betteroffice/{xlsx,pptx}` (npm, Apache-2.0, Rust→WASM) + `@betteroffice/vsdx` (vendored from source — not yet on npm) |
| **Rendering** | Paged DOM/ProseMirror surface for Word; canvas 2D via each engine's React editor for xlsx/pptx; thin custom canvas shell for vsdx |
| **Network** | Zero by default; fonts bundled from `@betteroffice/fonts` (replaces the old Google-Fonts opt-in). Word shapes text with one bundled `harfbuzz.wasm` served same-origin — no engine ships a worker, no collaboration surface, no telemetry (audit: `docs/MIGRATION-DOCX-EDITOR-2X.md` §2) |
| **License** | **Apache-2.0 recommended** (§7) — upstream is Apache-2.0 with NOTICE obligations |
| **Size budget** | ~20–30 MB VSIX (≈17 MB raw WASM + 15 MB fonts + JS; the 30 MB `@betteroffice/docx` engine wasm went away with the Word engine swap) — well under marketplace limits (§9) |

**Headline positioning:** the only true-canvas, offline, zero-telemetry VS Code viewer spanning OOXML **and** VSDX.
The incumbent (`cweijan.vscode-office`, 1.57 M installs) uses DOM approximations and cannot open Visio at all;
the only existing vsdx viewer has 446 installs and self-documented fidelity gaps (§8).

---

## 2. Engine facts (verified)

| Package | npm | Unpacked | WASM modules (raw) | Worker |
|---|---|---|---|---|
| `@docx-editor.dev/{core,react,i18n}` 2.29.0 | ✅ | ≈1–2 MB JS + `harfbuzz.wasm` | `harfbuzz.wasm` (HarfBuzz text shaping; loaded same-origin) | none — single-file react bundle, zero dynamic imports (the old `@betteroffice/docx` worker went away with the engine swap) |
| `@betteroffice/xlsx` 0.3.0 | ✅ | 5.3 MB | 5.2 MB | none in published dist — in-thread (session worker exists only in monorepo sources) |
| `@betteroffice/pptx` 0.2.0 | ✅ | 5.6 MB | 5.4 MB | none in published dist — in-thread (session worker exists only in monorepo sources) |
| `@betteroffice/vsdx` 0.1.0 | ❌ private | ~0.3 MB TS + wasm | ~5–6 MB (est.; single module, raster feature) | none (main-thread) |
| `@betteroffice/fonts` 0.4.0 | ✅ | 15 MB | — (TTF assets) | — |

- **Offline by default:** no WebSocket/XHR/EventSource anywhere in `packages/*/src`; collaboration is strictly
  transport-injected (we simply don't inject one). The only network path in the whole stack is the optional
  `@betteroffice/fonts/cdn` provider (pinned jsdelivr) — we won't use it unless the user opts in.
  For Word, the 2.x audit (`docs/MIGRATION-DOCX-EDITOR-2X.md` §2) confirms the same posture: no
  WebSocket/sendBeacon/EventSource/`new Worker`/analytics strings in the `@docx-editor.dev` dists, no Google-Fonts
  origin (the API is gone; we pass font bytes), the only `fetch` is the same-origin `harfbuzz.wasm` lookup, and the
  `yjs`/`pdf-lib` peers of the unused collaboration / PDF-export entrypoints are never imported or bundled.
- **Fidelity:** engine-authored benchmarks — docx SSIM 0.838 vs LibreOffice 0.769 with **63/63 exact page counts**;
  pptx SSIM 0.917. Reproduce in our own harness before using in marketing (§13).
- **Asset loading has no override knobs**: wasm URLs and worker paths are hard-coded
  `new URL('...', import.meta.url)` literals; the only documented override is `initWasm(bytes | WebAssembly.Module)`.
  This drives the bundling architecture in §4. The Word engine's `harfbuzz.wasm` loader is the one such reference
  we still rewrite: the build maps it to a manifest asset served from the extension origin.

### Editor integration surfaces (readOnly mode)

| Format | Component | Buffer prop | Fonts | Notable readOnly behavior |
|---|---|---|---|---|
| docx | `DocxEditor` (@docx-editor.dev/react) | `document: DocumentSource` | `fonts: FontConfigurationFragment` (byte-backed) | `mode:'view'\|'edit'`; keeps comment/track-change cards, outline, selection; single bundle, no worker; ref: `load/save/getEditor/snapshot` and the editor facade for zoom/paging |
| xlsx | `XlsxEditor` (xlsx-react) | `file: Uint8Array` | **none — no font API exists** (TBD, §11 R8) | toolbar hidden, sheet tabs/zoom/navigation stay; API: `findText`, `readCells`, `renderPng`, `print` |
| pptx | `PptxEditor` (pptx-react) | `file: Uint8Array` | **`fonts` required** (`PptxFontFace[]`) | thumbnail rail + zoom stay; slideshow/exportPng/tool disabled by the viewer variant; API: `goToSlide`, `findText`, `exportPng` |
| vsdx | **custom shell over core** | bytes → `openDiagram()` | `VsdxFontFace[]` (same loader as pptx) | our own page tabs / zoom / fit / pan; `DiagramHandle.exportPdf/Svg/Png` available |

`PptxWorkerViewerProps` is deprecated ("Removed in 0.6.0") and several APIs are marked `@experimental` — pin exact
versions and treat upstream minor bumps as potentially breaking (§11 R6).

---

## 3. Formats & features (v1)

**File associations:** `*.docx`, `*.docm`, `*.xlsx`, `*.xlsm`, `*.pptx`, `*.pptm`, `*.vsdx` — all `priority: default`
custom read-only editors (same pattern as the predecessor). `.vsdm/.vstx/.vssx` and legacy `.vsd` are **out of scope**
(upstream only claims vsdx; matches the whole ecosystem).

**Included:** page/slide/sheet rendering, zoom + fit, navigation (pages/slides/sheet tabs), find (engine APIs),
text selection & copy (docx), file-change auto-reload (existing FileSystemWatcher pattern), theme-aware chrome,
external-link allowlist (http/https/mailto/tel — ported), diagnostics output channel + `getDiagnostics` command.

**New commands worth adding:** *Export page/slide/sheet as PNG* (engine APIs exist for all three), *Diagram → PDF/SVG*
(vsdx `exportPdf`/`exportSvg`), *Print* (docx ref.print / xlsx printDisplayList).

**Settings (keep minimal):**
- `officeFileViewer.fonts`: `"bundled" | "off"` (default `bundled`) — `off` ships no font bytes at render time
- `officeFileViewer.cjkFonts`: `"off" | "cdn"` (default `off`) — opt-in network fetch of metric-compatible CJK faces
- drop the old `enableTextSelection` / `xlsxShowZoomSlider` (now native to the editors)

---

## 4. Architecture

```
extension host (node)                      webview (browser context)
┌───────────────────────────┐   postMessage (ArrayBuffer transfer)
│ CustomReadonlyEditorProvider│ ────────────────────────────────▶  per-format entry bundle (IIFE)
│  · read file bytes          │ ◀────────────────────────────────   · mounts DocxEditor/XlsxEditor/PptxEditor
│  · config, diagnostics,     │        ready/loaded/load-error       (readOnly) or vsdx canvas shell
│    link allowlist, watcher  │                                   · fetch()s .wasm + worker via asWebviewUri
└───────────────────────────┘                                      · spawns engine worker from blob:
                                                                        └─ worker calls initWasm(bytes)
```

### 4.1 The worker problem (drives everything)

VS Code docs require workers to be loaded from `data:`/`blob:` URIs, and **module workers that `import()`/fetch
webview-resource URIs are broken since VS Code 1.119** (open bug [`microsoft/vscode#315494`](https://github.com/microsoft/vscode/issues/315494),
regression from PR #311844). **Verified against the published npm dists:** no entry ships a worker today — the Word
engine's 2.x react bundle is a single file with zero dynamic imports, the xlsx/pptx dists contain no workers and no
`new Worker` at all (their sessions run in-thread via `initWasm(bytes)`), and vsdx runs on the main thread. The worker
path below existed only for the interim `@betteroffice/docx` engine and is kept as the design record for any future
engine that needs one.

**Interim decision (historical, retained for the record): fully self-contained workers.**
1. esbuild bundles the docx engine worker (`residentEngineWorker`) as a **separate
   single-file IIFE entry** (chunks inlined, wasm-import specifiers rewritten to `import` of emitted assets — the same
   rewrite plugin the predecessor already has, extended with a worker-URL rewrite).
2. The webview entry `fetch()`es the worker bundle + all `.wasm` assets via `webview.asWebviewUri`, creates the worker
   from `URL.createObjectURL(blob)`, and **transfers wasm bytes into it via postMessage** so the worker never touches
   the network/service-worker path.
3. Docx: the worker protocol already carries a host-module message type (`ResidentEngineWorkerHostModule`) — **spike S1
   must confirm wasm bytes can be supplied that way**; if not, patch our bundler shim to expose a `wasmBytes` registry.
   xlsx/pptx/vsdx: `initWasm(bytes)` is the documented path ("pass wasm bytes in runtimes that cannot fetch that URL").
4. `instantiateStreaming` where possible (`.wasm` is served as `application/wasm`; **keep `.wasm`/`.mjs` suffixes in
   emitted asset names** — MIME is extension-derived), with `instantiate(bytes)` fallback.

### 4.2 CSP (keep the predecessor's, plus fonts)

```
default-src 'none'; img-src ${cspSource} data: blob:; media-src ${cspSource} blob:;
font-src ${cspSource} [+ cdn origin when cjkFonts=cdn]; script-src 'nonce-…' 'wasm-unsafe-eval';
worker-src data: blob:; style-src 'unsafe-inline'; connect-src ${cspSource} data: blob: [+ cdn when opted in]
```
`worker-src data: blob:` is mandatory (unset `worker-src` silently falls back to `script-src` and blocks blob workers —
microsoft/vscode#331633). `wasm-unsafe-eval` (not `unsafe-eval`) is the correct narrow directive, and it must also hold
inside the worker's context.

### 4.3 React & chrome

React 19 + `react-dom` bundled per format entry (IIFE, no splitting — ~140 KB ×3, acceptable). Import
`@docx-editor.dev/react/styles.css` for Word (the engine's only stylesheet); xlsx/pptx use inline styles.
i18n packages are hard dependencies with `en` hard-coded as default — use per-locale subpath imports / rely on
tree-shaking to avoid bundling 10 locale JSONs. Docx chrome (toolbar/zoom/ruler/outline) gives VS Code-native feel;
the 2.x editor selects read-only behavior with `mode:'view'` and saves through the ref's `save()`.

### 4.4 vsdx viewer (custom, no React)

`@betteroffice/vsdx` core is a clean main-thread API: `initWasm(bytes)` → `openDiagram(bytes, {fonts})` →
`snapshot()/layoutPage(i)/paintPage(ctx, …)` (+ `sizeCanvasForPage`, point mapping, `hitTest`). A read-only shell with
page tab strip, zoom/fit/pan is ~400 LOC and avoids vendoring `vsdx-react` (1.1 MB edit-oriented source + i18n +
`scripts/package-boundary.ts` build dep + monorepo-path test fixtures). Exit ramp: if upstream ships
`@betteroffice/vsdx`/`vsdx-react` on npm and we later want the full editor, swap mechanically.

---

## 5. VSDX sourcing (decision)

`@betteroffice/vsdx` is **not on npm and has no publication ETA**: `private: true` ×3 packages, `publish = false` ×10
crates, no pending changesets, no roadmap entry; feature work froze 2026-10-01 after a September burst (0.1.0 released
2026-09-28) and upstream attention moved to docx/pptx worker editors. Docs state plainly: "available from source."

| Strategy | Verdict |
|---|---|
| (a) git submodule of the monorepo | **Rejected** — 108 MB checkout + 48 MB .git for 292 KB of relevant TS; workspace-wide `bun install`; CI pain |
| (b) **vendored snapshot + pinned-rev wasm build** | **Chosen** — snapshot `packages/vsdx/src` (292 KB, zero runtime deps) + `shared/collaboration-limits.ts` (278 B, easy to miss!) + tracked `.d.ts`; build wasm in CI from vendored Rust closure (`crates/vsdx-*` + `ooxml-{opc,drawingml,text}`, ~3–4 MB, incl. root `Cargo.toml`/`Cargo.lock` + upstream `scripts/wasm.ts`) |
| (c) wait for npm | Keep as **exit ramp** for a later release — swap is mechanical once published |

**Build toolchain (pinned):** wasm-pack **exactly 0.15.0** (asserted), wasm-opt/binaryen (CI pins `version_132`),
Rust stable + `wasm32-unknown-unknown` (upstream doesn't pin rustc — we should, for reproducibility), bun 1.4.2 for the
tsup step only. Build takes minutes (wasm-opt `-O3` under `lto=true`); cache `target/wasm-pack` in CI.
Attribution: keep Apache-2.0 headers, copy `LICENSE`+`NOTICE`, add `vendor/README` recording the upstream SHA.

---

## 6. Fonts

`@betteroffice/fonts` (15 MB, metric-compatible Calibri/Cambria/Arial/Times/Courier + common deck fonts; measured:
exact page-count match 61.9% vs 46.5% without) replaces the predecessor's Google-Fonts hack **and keeps the viewer
offline** — this is a net win over 0.1.2's fidelity story.

- **docx:** the 2.x editor takes byte-backed fonts (`createFontSource(bytes, request)` →
  `composeFontConfiguration`); we keep the bundled `@betteroffice/fonts` faces and hand their bytes to the engine,
  which shapes with the bundled `harfbuzz.wasm`.
- **pptx/vsdx:** load 4 style variants of one family: `resolveMetricCompatFace('Arial', b, i) ?? resolveLastResortFace(...)`
  → `loadBundledFontBytes` → `{family, bold, italic, bytes}` (exact pattern from upstream demos).
- **xlsx:** no font API exists — system/bundled-font metrics for grid text are engine-internal; verify rendering quality
  in spike S3.
- **CJK:** `@betteroffice/fonts-cjk` is 34 MB — do **not** bundle. Setting `cjkFonts: "cdn"` lazily imports
  `@betteroffice/fonts/cdn` (pinned jsdelivr, documented upstream path); without it, CJK text silently falls back to
  metric-compatible Latin faces (upstream behavior). Document the limitation.

---

## 7. License — **recommend Apache-2.0** (user shortlist: ISC or Apache-2.0)

Both are permissive and compatible with bundling Apache-2.0 dependencies. Choose **Apache-2.0** because:

1. **Patent grant** — Apache-2.0's explicit patent license protects downstream users of an extension that ships large
   third-party Apache-2.0 binaries; ISC has none.
2. **NOTICE mechanics match the obligation.** Upstream ships a `NOTICE` ("BetterOffice, Copyright 2026 Elia Hilse, The
   OpenOOXML Project") and a `THIRD-PARTY-NOTICES.md` (the docx engine derives from the eigenpal/docx-editor project,
   now published as `@docx-editor.dev/*` and consumed at 2.29.0, also Apache-2.0). Apache-2.0 §4(d) requires preserving these when we redistribute — having our own NOTICE file makes the
   distribution self-consistent.
3. **Uniformity** — one license story across our code and the vendored `packages/vsdx` snapshot.

**Required attribution set (either license):** our `LICENSE` + `NOTICE`, plus copies of upstream `LICENSE`,
`NOTICE`, `THIRD-PARTY-NOTICES.md` shipped in the VSIX and summarized in the README ("Licenses" section).
Mark any modified vendored files as modified (Apache-2.0 §4(b)). ISC remains legally workable if preferred — same
third-party notice duty, just no patent grant and no NOTICE convention of its own.

Marketplace metadata: `license: Apache-2.0`; note `cweijan` (MIT), Syncfusion/MESCIUS (proprietary components) — our
licensing hygiene is a stated differentiator (§8).

---

## 8. Competitive landscape (point-in-time, 2026-10)

| Extension | Installs | Formats | Rendering | VSDX | License | Notes |
|---|---|---|---|---|---|---|
| cweijan.vscode-office | 1.57 M (4.3★) | Office + pdf/epub/psd/md/archives… | DOM libs: docxjs, x-spreadsheet, pptxviewjs | **No** | MIT | saves xlsx edits; **opt-out Azure telemetry**; md WYSIWYG is its moat |
| GrapeCity/MESCIUS Spreadsheet Viewer | 6.8 M (3.4★) | xlsx/csv | Wijmo (commercial) | No | proprietary comp. | low rating = xlsx fidelity pain |
| Syncfusion Document Viewer | 68 k (4.3★) | docx/xlsx/pdf | EJ2 DOM | No | proprietary free-tool | |
| tomoki1207.pdf | 14 M (4.5★) | pdf | pdf.js | — | MIT | stale since 2025; proof single-format viewers scale |
| RokRage.vsdx-viewer | **446** | vsdx only | custom canvas, self-documented gaps (no ShapeSheet/themes/NURBS) | vsdx only | unclear/OSS-contradicted | the entire incumbent field for vsdx |
| **ours (0.1.2)** | 32 | docx/xlsx/pptx | @silurus/ooxml canvas | No | MIT | not on Open VSX |

**Takeaways:** we can't win on breadth (no PDF/epub/markdown planned — accepted non-goal, revisit PDF later); we win on
(1) **fidelity** (canvas pagination vs DOM approximation — reproduce benchmarks in our harness before claiming),
(2) **Visio** (greenfield: best incumbent has 446 installs), (3) **privacy/offline hard guarantee** (vs opt-out
telemetry), (4) licensing hygiene, (5) Open VSX presence (predecessor never published there). Naming: "Office Viewer"
is taken by the incumbent — use e.g. **"BetterOffice Viewer — docx, xlsx, pptx, Visio"** with vsdx/visio keywords.

---

## 9. Size & performance budget

| Item | Raw | Notes |
|---|---|---|
| docx (`@docx-editor.dev` JS + `harfbuzz.wasm`) | ~1–2 MB | single react bundle + one same-origin shaping asset; no worker |
| xlsx + pptx wasm | 10.6 MB | |
| vsdx wasm (est.) | ~5–6 MB | |
| @betteroffice/fonts | ~15 MB | TTFs; subset later if needed |
| JS (4 webview entries + vsdx shell + React runtime) | ~8–12 MB | minified |
| **VSIX (zip)** | **~20–30 MB** | wasm compresses ~2.5–3×; far under Open VSX's 256 MB cap (MS Marketplace has no official cap; empirically ≥360 MB accepted) |

Memory: one engine per webview panel; keep `supportsMultipleEditorsPerDocument: false` (predecessor behavior);
**no `retainContextWhenHidden`** (docs: high memory overhead) — accept cold re-init on tab switch, keep
`getState/setState` for scroll/zoom restoration; `worker.terminate()` + wasm handle disposal on `onDidDispose`.

---

## 10. Phased plan

| Phase | Content | Exit criteria |
|---|---|---|
| **0 — Scaffold** (few days) | Repo skeleton (port esbuild.mjs, tsconfigs, provider, CSP, diagnostics, watcher); CI (typecheck + integration tests on ubuntu/windows); asset-rewrite plugin extended to workers | sample.docx renders in dev; blob worker + wasm-bytes path proven |
| **1 — Spikes** (2–3 days) | S1: docx resident worker accepts wasm bytes via host-module message (else shim). S2: blob-worker + `initWasm(bytes)` on xlsx/pptx in a real webview across VS Code stable + insiders (#315494 regression class). S3: xlsx font-metric quality without font config | all spikes green, or fallbacks designed |
| **2 — OOXML v1** (1–2 weeks) | docx/xlsx/pptx editors in readOnly, fonts wired (§6), find/zoom/navigation, reload, PNG export + print commands, integration tests ported + extended | feature-complete OOXML, VSIX < 40 MB |
| **3 — VSDX** (1 week + CI) | Vendor snapshot (b), CI wasm build with pinned toolchain, custom canvas shell (pages/zoom/fit/pan), vsdx fixtures (incl. connectors/themes/layers), PDF/SVG export commands | sample decks render; association `*.vsdx` |
| **4 — Polish & ship** (few days) | README/marketplace listing (vsdx keyword), benchmark reproduction, Open VSX + Marketplace publish, telemetry-free verification | published on both registries |

**Later / optional:** editing mode (engines support lossless `save()`; switch `CustomReadonlyEditorProvider` →
`CustomEditorProvider` with backup), PDF support (biggest adoption lever we're consciously skipping), CJK bundled
variant, upstream contribution of vsdx viewer components.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Webview worker/resource loading regressions (open bug #315494 class; SW churn #318660) | self-contained blob workers + wasm-bytes transfer (§4.1); test on stable **and** insiders each release; diagnostics fallback UI with console capture |
| R2 | vsdx is unofficial/unpublished; upstream may change its private API | pin upstream SHA in `vendor/README`; mechanical npm swap later; vsdx isolated in its own phase & module |
| R3 | vsdx wasm build nondeterminism (upstream doesn't pin rustc) | we pin rustc + binaryen in our CI; functional (not checksum) validation; LFS or CI-artifact for the ~5 MB binary if committed |
| R4 | Word bundle + HarfBuzz shaper add ~1–2 MB (the 20 MB `@betteroffice/docx` engine wasm is gone); xlsx/pptx/vsdx wasm can slow cold open | lazy-load wasm per format only when a file opens; prewarm only the opened format; show progress state (engines report load phases) |
| R5 | VSIX size growth (fonts/wasm) | budget table (§9); fonts setting `off`; revisit font subsetting |
| R6 | Upstream API churn (`@experimental` markers; pptx viewer props already deprecated for 0.6.0) | pin exact versions; changeset review on bump; wrap engine APIs behind thin adapters |
| R7 | Memory pressure with many editors open | one engine per webview panel (no workers), dispose wasm handles on `onDidDispose`, no retainContextWhenHidden |
| R8 | xlsx has no font-supply API → metric drift on grid text | spike S3; document limitation; upstream issue if needed |
| R9 | Fidelity claims unverifiable | reproduce benchmarks with our own harness before any marketing use (§13) |
| R10 | Vendored-snapshot drift (missed `shared/collaboration-limits.ts`, `.d.ts`, headers) | vendoring checklist in `vendor/README`; CI typecheck fails on missing pieces |

---

## 12. Testing & CI

- **Port** predecessor integration tests (lifecycle: ready → loaded → reload → dispose; diagnostics ring; link allowlist)
  via `@vscode/test-electron`, extended to 4 formats.
- **Samples:** port `samples/gen_samples.py`; add vsdx fixtures (basic shapes, connectors, layers, themes, CJK text).
- **Webview matrix:** smoke-render each sample in real VS Code (stable + insiders) in CI via xvfb; assert
  `loaded` messages + non-blank canvas hash.
- **Unit:** asset-rewrite plugin (wasm + worker URL rewrites), CSP builder, vendored vsdx shell logic.
- **CI:** ubuntu+windows; Phase 3 adds Rust/wasm-pack/binaryen/bun job (cached) building vsdx wasm from vendored sources.

---

## 13. Open decisions (for the user)

1. **License:** Apache-2.0 (recommended, §7) or ISC?
2. **Fonts:** bundle Latin core 15 MB by default (recommended) — or ship leaner VSIX with CDN-only fonts?
3. **vsdx delivery:** build wasm in CI from vendored Rust sources (recommended) vs commit a prebuilt binary (faster
   builds, blob in git) vs defer vsdx until npm publication (no ETA)?
4. **Scope confirm:** read-only v1 (no save), no PDF/markdown breadth, `.vsdx` only (no `.vsdm/.vstx/.vssx/.vsd`)?
5. **Naming/publisher:** e.g. `vscode-betteroffice-viewer`, display name "BetterOffice Viewer", publisher `ahati`,
   and publish to Open VSX in addition to the Marketplace?

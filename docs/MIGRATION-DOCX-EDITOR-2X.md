# Migration: `@eigenpal/docx-editor-*` 1.9.0 → `@docx-editor.dev/*` 2.29.0

Status: **planned** · Scope: DOCX webview engine only (xlsx/pptx/vsdx untouched) · Target: `@docx-editor.dev/core@2.29.0` + `@docx-editor.dev/react@2.29.0`

Product invariants (unchanged by this migration, audited in §2): **fully offline · no
share/collaboration surface · no telemetry**.

## 0. Background

`@eigenpal/docx-editor-*` 1.9.0 is the last release of the old npm scope. The vendor renamed the
scope to `@docx-editor.dev/*` (same repo: `github.com/eigenpal/docx-editor`, same Apache-2.0
license) and shipped ~20 minors since. `docx-editor.dev/editor` (the demo that "looks different")
runs the 2.x line. Migrating buys us: current engine fixes/fidelity, HarfBuzz-shaped layout,
the redesigned chrome, and a maintained support line. The old scope is frozen forever at 1.9.0.

New license situation (verified on npm, 2026-10):

- `@docx-editor.dev/core`, `/react`, `/i18n` — Apache-2.0 (unchanged).
- `@docx-editor.dev/fonts` (optional, we do NOT adopt — see §4) — `Apache-2.0 AND OFL-1.1 AND LicenseRef-GUST-Font-License`.

## 1. Verified facts that shape the plan

Engine surface (from the published dists, not docs):

| Topic | 1.9.0 (today) | 2.29.0 (target) |
| --- | --- | --- |
| Google Fonts | engine fetches `fonts.googleapis.com` by default; we kill it via `setGoogleFontsEnabled(false)` at module scope | **API removed.** Google Fonts is an opt-in origin (`googleFonts()` from `@docx-editor.dev/fonts/google`). Core/react dists contain **zero** `googleapis`/`gstatic` strings. No egress by construction (see §2). |
| Text shaping/layout | DOM engine, no wasm, no workers | **HarfBuzz via WASM** (`harfbuzzjs`; `dist/harfbuzz.wasm`, emscripten glue: `new URL("harfbuzz.wasm", import.meta.url)` + same-origin `fetch`/XHR). Without fonts: fixed-width measurer fallback. Font-load failure degrades gracefully via `onFontError` (non-fatal). No workers in the react dist (single 429 KB bundle, **zero dynamic imports** — nothing lazy-loads at runtime). |
| Bundled react dist | many split chunks (dialogs etc.) | one `index.mjs` (~430 KB), `./styles.css` export unchanged |
| Fonts prop | `FontDefinition[]` (URL-based, fetched on demand) | `FontConfiguration \| FontConfigurationFragment \| FontResolver` — **byte-backed**: `FontSource { request, id, bytes: Uint8Array, hash, faceIndex }` built with `createFontSource(bytes, request)` and composed with `composeFontConfiguration`. Sampled once at mount; identity change remounts. |
| Peer deps | none | core: `yjs`, `pdf-lib` (declared for the `/collaboration` + PDF-export capability surface we never import — no `import` statement in any shipped chunk references them; the only `yjs` string in the editor chain is a diagnostics-table key). react: react/react-dom 18\|19 ✓ (we run 19), `@docx-editor.dev/core ~2.29.0`, `@docx-editor.dev/i18n ^2.29.0` (no deps; locales are static bundled JS) |

Component API mapping for every prop/ref we use today (`webview/mounts/docx.tsx`):

| 1.9.0 | 2.29.0 | Notes |
| --- | --- | --- |
| `documentBuffer={bytes}` | `document={bytes}` | `DocumentSource` |
| `documentName` | `title` | chrome title bar |
| `readOnly` + `mode='viewing'\|'editing'` | `mode='view'\|'edit'` (`EditorMode`; `'suggesting'` needs a review module — not used) | `readOnly` prop is gone |
| `colorMode='light'` | `colorMode='light'\|'dark'\|'system'` | 2.x themes **only the chrome**; the canvas stays Word-faithful. Becomes a setting — see §6. |
| `showToolbar` (default true) | `chrome` (default true) | title bar + toolbar frame |
| `showRuler={!readOnly}` | `rulers={!readOnly}` | on by default with chrome |
| `showOutline` | `navigation` (default true) | headings + find pane |
| `showZoomControl` | no prop — zoom control is part of the chrome; zoom is engine-owned | accept |
| `showFileOpen={false}` / `showHelpMenu={false}` | `menu` accepts `false` or `DocxEditorMenuProps`; rows are individually falsable — `menu={{ reportIssue: false }}` is the documented example | keep File→Open out of our flow (`onOpen` override or row key — spike A); **`reportIssue: false` is mandatory** (§2, M3) |
| `fonts: FontDefinition[]` | `fonts: FontConfigurationFragment` | see §4 |
| `onSave={(buffer) => …}` | `onSave: () => void` — we call `ref.save(): Promise<ArrayBuffer \| null>` ourselves | save flow rewrite, §5 |
| `onError` | **gone.** `onFontError(error: EditorFontError)` for fonts; `onReady(editor)`, `onChange(DocumentChange)` | spike B: how document *load* failures surface (`DocumentOpenDiagnostic`/`EditorSnapshot`/`DocumentRefresh*`) |
| `initialZoom` | `zoom?: number` + `zoomMode?: ZoomMode \| 'auto'` | map: `fitPage` → `{type:'fit', fit:'page'}`; `fitWidth` → `{type:'fit', fit:'pageWidth'}` (or `'auto'` = bounded width-fit 50–100%); `100` → `zoom={1}` + `{type:'fixed'}`. Verify `ZoomFitTarget` literals (spike A). |
| ref: `getZoom/getCurrentPage/getTotalPages/setZoom/scrollToPage` | ref is deliberately slim: `load/save/getDocumentHandle/getEditor/focus/exec/snapshot`. Zoom/paging live on the facade: `editor.getZoom()/setZoom()/getZoomMode()/setZoomMode()/scrollToPage()/getPageGeometry()` | state polling + restore rewrite, §5 |

## 2. Offline / no-collaboration / no-telemetry audit (evidence)

Greps run over the extracted `@docx-editor.dev/core@2.29.0`, `@docx-editor.dev/react@2.29.0`
and `@docx-editor.dev/i18n@2.29.0` tarballs. Repeat this table's checks against **our built
bundle** at §3.3 — that is the gate that matters, since it covers all transitive code.

### 2.1 Network egress

| Vector | Finding | Disposition |
| --- | --- | --- |
| Absolute URLs in dists | core: only OOXML **XML namespace identifiers** (`schemas.openxmlformats.org`, `schemas.microsoft.com`) — never fetched, they are strings in XML markup. react: `www.w3.org/2000/svg` (namespace), `vuejs.org` + `github.com/eigenpal/docx-editor/issues/new` (docs/help-menu strings), i18n: `example.com` fixtures in locale sample text. **No CDN, no analytics, no license server.** | none fetched at runtime |
| `fetch(` | 1 site in core = the harfbuzz.wasm loader (`new URL("harfbuzz.wasm", import.meta.url)` → relative URL, `credentials:"same-origin"`, XHR fallback). 1 site in react = inside `useDocxSource(url)` — a host-opt-in URL-loading hook **we never call** (we pass bytes). | wasm served from our own asset origin (§3.2); `useDocxSource` inert; CSP `connect-src` blocks any future misuse |
| WebSocket / sendBeacon / EventSource / `new Worker` / importScripts / serviceWorker / script injection | **zero occurrences in all three dists** | — |
| Google Fonts | `googleapis`/`gstatic` absent from every dist; the origin API (`@docx-editor.dev/fonts/google`) is a separate package we don't install | the 1.9.0 kill-switch is replaced by absence-by-construction |
| Telemetry/analytics/crash SDKs | `sentry`, `posthog`, `amplitude`, `mixpanel`, `analytics`, `beacon`: zero occurrences; no version/update check endpoints | — |
| Install-time execution | none of the three packages declare `postinstall`/`prepare` scripts (their `build`/`typecheck` scripts are monorepo-only) | no supply-chain phone-home |
| PDF/Markdown export | `ChromeExportFormat = 'markdown' \| 'pdf'`; react bundle contains no dynamic `import(` at all, so export cannot lazy-load code or bytes at runtime | verify the PDF path fails gracefully offline in QA (§8) and produces no network attempt |

### 2.2 Collaboration / sharing surface

| Vector | Finding | Disposition |
| --- | --- | --- |
| `yjs` / `/collaboration` subpath | exists in core, separate entrypoint; **no `import` statement in any shipped chunk resolves yjs** — the only match in the editor chain is a `yjsStateVector` key in a static diagnostics schema table. `yjs` will be npm-auto-installed as a peer but must not reach our bundle. | never imported by our entry; add build-time assertion (§3.3); alias to a throwing stub if the graph ever leaks |
| Collaboration module | registered only via the `modules` prop (construction-time); we pass **no modules** — no presence, no remote carets, no share UI | keep passing none; drop the 1.9.0 agents-stub aliases if the dist confirms no agents reference (`@docx-editor.dev/agents` on npm is a `0.0.1-placeholder`; react dist contains zero collaboration/presence/agents strings) |
| "Report an issue" chrome row | File/Help menu row deep-links to `github.com/eigenpal/docx-editor/issues/new` in a browser — a click-through, not an egress | **mandatory** `menu={{ reportIssue: false }}` (M3) — an offline product must not offer it |
| File→Open packaged fallback | opens a **local** file picker (user-initiated read, never a document-triggered fetch) | still disabled for product coherence — VS Code owns opening (spike A for the row key / `onOpen` override) |

### 2.3 Enforcement layers after migration (defense in depth, in order)

1. **By construction**: we only pass byte sources (`document`, byte-backed `fonts`), no URL
   origins, no modules, no resolver that fetches.
2. **Bundle postcheck** (§3.3): built docx bundle must contain none of
   `new WebSocket`, `sendBeacon`, `EventSource`, `googleapis`, `gstatic`, and must not
   statically resolve `yjs`/`pdf-lib`; `harfbuzz.wasm` must be present in the asset manifest.
3. **CSP** (already in `src/providers/officeProvider.ts`, unchanged): `script-src 'nonce-…'
   'wasm-unsafe-eval'` (wasm compile stays allowed), `connect-src <ext-origin> data: blob:` —
   the only remote origin ever conditionally added is the user-opt-in CJK font CDN. This blocks
   the entire §2.1 table independent of engine behavior.
4. **VS Code webview sandbox**: no ambient authority beyond what CSP grants.

## 3. Dependency + build plumbing

1. `package.json`: remove both `@eigenpal/*` deps; add `@docx-editor.dev/core@2.29.0`,
   `@docx-editor.dev/react@2.29.0` (npm pulls `@docx-editor.dev/i18n` transitively; `yjs`/`pdf-lib`
   auto-install as peers — they must stay **unbundled**: nothing we import may reach them).
2. `scripts/build.mjs`:
   - Drop the `@eigenpal/docx-editor-agents` (+`/react`) → `webview/bootstrap/agentsStub.ts`
     aliases once the 2.x react dist confirms no agents reference; then delete the stub file.
   - Assets: add `node_modules/@docx-editor.dev/core/dist/harfbuzz.wasm` → `out/media/assets/`
     + manifest so `__extAssetUrl('harfbuzz.wasm')` resolves. The existing asset-rewrite plugin
     already handles `new URL(..., import.meta.url)` for engine bundles (same mechanism as the
     vsdx wasm) and `.wasm` is already in `ASSET_EXTENSIONS`; extend it to the core dist file.
   - Postcheck `verifyNoEgressNoCollaboration` — per §2.3 layer 2:
     forbidden markers become `new WebSocket`, `sendBeacon`, `EventSource`, `googleapis`,
     `gstatic` (drop `'docx-editor-agents'` if the dist no longer references agents); add a
     positive check that `harfbuzz.wasm` is in `out/media/manifest.json`; add a check that the
     docx bundle contains no `from"yjs` / `from"pdf-lib`-style resolved imports (a leaked peer
     dep fails the build instead of shipping).
3. React 2.x ships a single file — remove/keep whatever chunk handling the old build had for the
   eigenpal dialog chunks (likely nothing; esbuild just bundles it).

## 4. `webview/fonts.ts` — bytes-based font fragment

2.x wants font **bytes**, not URLs — which actually tightens the offline story (no on-demand
`connect-src` fetch at all if we hand over prefetched bytes via `getAssetBytes`).

- Keep our `@betteroffice/fonts` faces (richer than `@docx-editor.dev/fonts`, which only bundles
  Carlito/Caladea/Liberation — we also ship Noto Arabic/Hebrew, Gelasio, Comic Relief, Inter,
  Roboto, …). Do **not** adopt `@docx-editor.dev/fonts` (and therefore never install the Google
  Fonts origin at all).
- Rewrite `loadDocxFontDefinitions` to produce a `FontConfigurationFragment`:
  - for each face: fetch TTF bytes through the asset bootstrap, then
    `createFontSource(bytes, { family, style, weight, italic? })` → collect `source`s
    (per-face failures degrade that face only — matching upstream semantics);
  - set `supportedFamilies` from the face list; keep existing family aliasing (Calibri→Carlito …).
- If byte prefetch for ~40 faces proves too heavy at mount, fall back to a `FontResolver` that
  fetches only the families a document actually declares (capped at 64 families engine-side) —
  still extension-origin URLs only.

## 5. `webview/mounts/docx.tsx` rewrite

- Props per the §1 table, plus `menu={{ reportIssue: false, …spike A }}`. Header comment
  rewritten: the "no wasm, no workers" rationale and the `setGoogleFontsEnabled` paragraph are
  obsolete — replace with the §2 audit summary (no egress by construction + CSP + postcheck) and
  the harfbuzz asset note.
- Save flow: `onSave={() => { void ref.current?.save().then(b => b && context.saveBytes(b)); }}`
  (`save()` resolves `null` before mount).
- Zoom/page state poll (1 s): `const ed = ref.current?.getEditor();` → `ed.getZoom()`;
  page reads from spike C (candidates: `getPageGeometry().length` for total pages; visible page
  via facade/snapshot/events). Keep the getter-only polling shape; guard `getEditor() === null`.
- Zoom/page restore effect: replace the `getTotalPages() > 0` retry with
  `ed.getPageGeometry().length > 0` as the layout-ready signal, then `ed.setZoom(saved)` /
  `ed.scrollToPage(saved)`.
- Errors: `onFontError` → surface as a non-fatal status notice (layout degrades but works) or
  `context.fail('fonts', error)` — decide during implementation; load errors per spike B.
- Keep: mount container, `reportState` debounce contract.

## 6. NEW: configurable chrome color mode (default light)

Today the adapter hardcodes `colorMode="light"` + a forced-light stylesheet. We keep light as the
default but make it a setting:

1. `package.json` → `contributes.configuration`:
   ```json
   "officeFileViewer.colorMode": {
     "type": "string", "enum": ["light", "dark", "system"], "default": "light",
     "description": "Editor chrome color mode for Word documents. The document canvas always stays Word-faithful (white)."
   }
   ```
2. `webview/protocol.ts`: `ViewerWebviewConfig` gains `colorMode: 'light' | 'dark' | 'system'`.
3. `src/providers/officeProvider.ts`: read the setting into the config payload (next to
   `editing`/`forceReadOnly`).
4. `webview/mounts/docx.tsx`:
   - `colorMode={init.config.colorMode}` (2.x themes chrome only — canvas stays white in all
     modes; matches the product requirement "stay in light theme" as default).
   - Make the forced-light CSS (`color-scheme: light`, light scrollbars) **conditional**: apply
     for `'light'`; for `'dark'`/`'system'` drop the overrides so the chrome follows the
     OS/theme while the canvas remains white.
5. Dark-mode QA: chrome colors, menus/popups (radix-based), and the light scrollbar overrides
   must not fight each other.

## 7. Docs / notices

- `THIRD-PARTY-NOTICES.md`: rename the eigenpal entry to the `@docx-editor.dev/*` packages at
  2.29.0 (same upstream repo); add runtime-bundled transitive deps of core that ship in our
  bundle (`harfbuzzjs`, `emf-converter`, `utif2`, `bidi-js`, `fflate`, `fast-xml-parser`,
  prosemirror-*, radix select, clsx, cva, i18n) with their licenses.
- `NOTICE` line ("based on @eigenpal/docx-editor") → new package names.
- `README.md`, `docs/SCOPING.md`, `webview/bootstrap/assetBootstrap.ts` header ("docx … no wasm")
  and `webview/entries/docx.ts` header: docx now uses one harfbuzz wasm asset (same-origin,
  bundled); still no workers, still zero network egress, still no collaboration, no telemetry —
  cite §2.

## 8. Spikes to close first (30–60 min, in a scratch branch after `npm install`)

- **A. Chrome props**: exact `DocxEditorMenuProps` row keys to hide File→Open (+ confirm
  `reportIssue: false`); verify `ZoomFitTarget` literals (`'page'`/`'pageWidth'`); confirm no
  `showZoomControl`-equivalent is needed.
- **B. Load-error surfacing**: how a corrupt docx reports failure without `onError`
  (`DocumentOpenDiagnostic`, snapshot `LOADING_SNAPSHOT`, popup?). Decide our `context.fail`
  wiring.
- **C. Current-page reads**: how the host reads "current page / total pages" for state reporting
  (`getPageGeometry()` vs events vs snapshot).
- **D. Peer-dep containment**: confirm esbuild never reaches `yjs`/`pdf-lib` from our entry
  imports; if the graph leaks, alias them to a throwing stub like the old agents stub (and check
  whether the packaged File→Export→PDF row can even be surfaced — it must fail gracefully
  offline or be hidden).
- **E. Offline export/print QA**: click every export/print entry in the chrome while the
  devtools network panel is open — expect zero requests and graceful failure where a format
  isn't supportable offline.

## 9. Execution order

1. Spike branch: install new deps, run spikes A–E against `node_modules` dists.
2. Build plumbing (§3) — compile must pass with the new packages before touching app code.
3. `webview/fonts.ts` (§4), `webview/mounts/docx.tsx` (§5).
4. colorMode setting end-to-end (§6).
5. Docs/notices (§7).
6. Verify: `npm run typecheck`, `npm run compile` (postchecks green), `npm test`, then manual
   matrix: open each `samples/*.docx` · edit + save (lossless rezip round-trip) · zoom fit/fixed +
   page restore after reopen · dark chrome w/ light canvas + system · fonts (Carlito/Calibri doc,
   Arabic/Hebrew sample) · images, tables, comments, tracked changes · **offline audit: devtools
   network panel shows zero external requests across open/edit/save/export/print; no share,
   presence, or report-issue UI anywhere in the chrome**.
7. Bump the vsix, eyeball final bundle size (react 430 KB + core + harfbuzz.wasm ~1–2 MB total).

## 10. Risks

- **Bundle size** grows (harfbuzz wasm ≈ 1–2 MB asset). Acceptable; vsix already 25 MB.
- **Shaping regression risk is inverted**: 2.x HarfBuzz shaping should *improve* wrap/pagination
  fidelity vs 1.9.0's DOM layout — but verify against samples with complex scripts.
- **Silent behavior changes**: `mode` default (`'edit'` even for `w:trackRevisions` docs — 1.x
  behaved how? verify) and menu row keys if spike A misses one (a stray packaged row is a UX
  bug, never an egress — the picker is local and CSP stands).
- **pdf-lib/yjs leakage** would fail the §3.2 postcheck — caught at build time, not runtime.
- **Export-to-PDF offline behavior** unknown until spike E — worst case is a graceful error
  dialog; hide the row if it is noisy.
- Rollback: single revert of the dependency swap + `git checkout` of the five touched files;
  the old 1.9.0 scope stays installable.

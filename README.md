# Office File Editor & Viewer for VS Code

Open **Word**, **Excel**, **PowerPoint** and **Visio** files directly in Visual Studio Code —
rendered on canvas by native OOXML engines, edited in place, saved losslessly. No Office install,
no server conversion, no upload.

> **Offline-only · No telemetry · No AI · No accounts · No ads**

Everything — engines, fonts, WASM assets — ships inside the extension. Opening, editing and saving
a document makes **zero network requests**. There is no AI assistant, no LLM integration, no
telemetry, no analytics, no crash reporting, no sign-in, and no "phone home" of any kind.

## Supported formats

| Format | Extensions | What you get |
|---|---|---|
| Word | `.docx` `.docm` | Full paged editor: headers/footers, footnotes, tables, images, tracked changes & comment cards, outline & find, text selection & copy — with **lossless in-place save** |
| Excel | `.xlsx` `.xlsm` | Sheet tabs, formulas (cached values), merged cells, frozen panes, cell editing, selection & copy, zoom, find |
| PowerPoint | `.pptx` `.pptm` | Slide canvas with masters, images, speaker notes, thumbnail rail, slide navigation, editing |
| Visio | `.vsdx` | Full Visio-style editor: shape stencils with search, Drawing Explorer, Shape Data, Layers, page tabs, connectors, pan & zoom, save |

## How it works

- **Word** — the [`@docx-editor.dev`](https://github.com/eigenpal/docx-editor) paginated word
  processor (DOM/ProseMirror), with text shaped through a bundled **HarfBuzz WASM** asset so line
  breaks and page breaks match real font metrics. Saving re-zips the OOXML package selectively:
  parts the editor doesn't understand survive the round-trip untouched.
- **Excel / PowerPoint** — the [BetterOffice](https://github.com/openooxml/betteroffice)
  Rust→WASM engines rendered through their React editors.
- **Visio** — a vendored BetterOffice Rust→WASM diagram core behind a native-feeling canvas shell
  (the only VS Code extension we know of that opens `.vsdx` at all).
- **Fonts** — metric-compatible substitutes (Calibri→Carlito, Cambria→Caladea, Times New
  Roman→Liberation Serif, Arial→Liberation Sans, Courier New→Liberation Mono, plus Noto Arabic /
  Hebrew, Gelasio, Inter, Roboto and more) are bundled, so pagination is computed from real
  metrics without downloading a single face.

## Privacy & offline guarantees

**No network access.** Opening, editing and saving are pure local computation. This is enforced,
not just intended:

1. **No egress by construction** — every engine receives bytes, not URLs. There is no Google
   Fonts lookup to disable (the API no longer exists in the bundled engine), no CDN fallback, no
   update checker, no collaboration transport (WebSocket/beacon/EventSource are compile-time
   forbidden), no AI or "assist" endpoints.
2. **Build-time postcheck** — every shipped webview bundle is scanned; the build fails if it
   contains egress markers or collaboration machinery.
3. **Strict CSP** — the webview runs with `script-src 'nonce-…' 'wasm-unsafe-eval'` and
   `connect-src` limited to the extension's own origin, inside VS Code's sandbox.

**No AI.** No model calls, no prompts sent anywhere, no third-party inference SDKs, no data
sharing. What you open never leaves your machine.

**The one deliberate exception:** `officeFileViewer.cjkFonts: "cdn"` (default **off**) fetches
open-licensed CJK font faces from a pinned jsDelivr URL. Off by default, and the *only* network
path the extension can ever take.

Also: macros in `.docm/.xlsm/.pptm` are **never executed**; external hyperlinks open through VS
Code with an `http/https/mailto/tel` allowlist only.

## Usage

Install and open any supported file — the extension registers as the default editor. Use
**Open With…** to switch back to the binary or text editor at any time.

- `Ctrl`/`Cmd` `+` / `-` / `0` — zoom in / out / reset
- `Ctrl`/`Cmd` `S` — save (lossless re-zip for Word)
- `Ctrl`/`Cmd` `F` — find in document (where the format supports it)
- Edit the file on disk (e.g. regenerate a report) — the open viewer live-reloads
- Word chrome theme: follow the `officeFileViewer.colorMode` setting; the document canvas stays
  Word-faithful white in every mode

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `officeFileViewer.editing` | `true` | Open documents editable. Turn off to open everything read-only. |
| `officeFileViewer.forceReadOnly` | `false` | Always open read-only, regardless of `editing` (applies to Word, Excel, PowerPoint). |
| `officeFileViewer.colorMode` | `light` | Word editor chrome color mode: `light`, `dark` or `system`. The document canvas always stays white. |
| `officeFileViewer.fonts` | `bundled` | Use the bundled metric-compatible fonts for Office-accurate layout. `off` uses system fonts only. |
| `officeFileViewer.cjkFonts` | `off` | `cdn` fetches CJK faces from the pinned open-source font CDN — the **only** network access this extension can perform. |
| `officeFileViewer.initialZoom` | `fitPage` | Initial zoom for paged viewers: `fitPage`, `fitWidth` or `100`. |

## Commands

- **Office File Viewer: Show Diagnostics** — recent engine lifecycle events, for bug reports
- **Office File Viewer: Copy Diagnostics to Clipboard**
- **Office File Viewer: Reload Active Viewer**

## Known limitations

- Save writes through each engine's serializer; VS Code-level dirty-state markers, hot-exit
  backup and external-change conflict prompts are planned — until then, undo history lives in the
  open editor.
- `officeFileViewer.initialZoom: "fitPage"` currently behaves like width-fit for Word (the
  bundled engine has no page-height fit target yet).
- Visio: linear fill gradients and arc/gap line jumps render; exotic ShapeSheet features may
  differ from Visio. `.vsdm/.vstx/.vssx` and legacy `.vsd` are not supported.
- CJK text renders with substituted metrics unless `officeFileViewer.cjkFonts: "cdn"` is enabled.
- ODF (`.odt/.ods/.odp`) and legacy binary formats (`.doc/.xls/.ppt/.vsd`) are not supported.

## Development

```bash
npm install
npm run compile        # dev build (host + webviews + assets) into out/
npm run watch
npm run typecheck      # host + webview tsc
npm test               # compile + VS Code integration tests (all four formats)
npm run package        # production (minified) build; postchecks enforce the offline contract
npx @vscode/vsce package --no-dependencies   # produce the .vsix
npm run build:vsdx-wasm  # rebuild the vendored Visio WASM (needs the Rust toolchain)
```

The production build runs a **no-egress / no-collaboration postcheck** over every shipped bundle
and fails the build on violations — the build itself is the enforcement (see the
Privacy & offline guarantees section above). `docs/SCOPING.md` documents the architecture.

## License & third-party attribution

This project is [Apache-2.0](./LICENSE) © 2026 ahati. It builds on open-source engines and fonts;
the full, authoritative notices ship inside every package ([NOTICE](./NOTICE),
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) and the per-font OFL texts). Summary:

| Component | Role | License | Copyright |
|---|---|---|---|
| [`@docx-editor.dev/core` `react` `i18n`](https://github.com/eigenpal/docx-editor) 2.29.0 | Word editor | Apache-2.0 | © 2026 EigenPal Inc. |
| [`harfbuzzjs`](https://github.com/harfbuzz/harfbuzzjs) | HarfBuzz text shaping (WASM) | MIT | © The HarfBuzz Authors |
| [`@betteroffice/xlsx(-react)`, `pptx(-react)`](https://github.com/openooxml/betteroffice) | Excel & PowerPoint engines | Apache-2.0 | © 2026 Elia Hilse, The OpenOOXML Project |
| `@betteroffice/vsdx` (vendored snapshot) | Visio diagram core + WASM | Apache-2.0 | © 2026 Elia Hilse, The OpenOOXML Project |
| [`@betteroffice/fonts`](https://www.npmjs.com/package/@betteroffice/fonts) | Bundled metric-compatible faces (Carlito, Caladea, Liberation, Noto, Gelasio, …) | SIL OFL-1.1 | © their respective font projects |
| [`react`, `react-dom`](https://github.com/facebook/react) | Webview UI runtime | MIT | © Meta Platforms, Inc. and affiliates |
| ProseMirror (`prosemirror-*`), `@radix-ui/react-select`, `fflate`, `fast-xml-parser`, `utif2`, `bidi-js`, `emf-converter`, `clsx`, `class-variance-authority` | Bundled engine/UI dependencies | MIT / Apache-2.0 (per package) | per package |

The `@docx-editor.dev` packages are the renamed continuation of the `@eigenpal/docx-editor`
packages (same repository, same Apache-2.0 license); the BetterOffice API design in turn derives
from that project. `yjs` and `pdf-lib` are declared optional peers of the Word engine for its
collaboration and PDF-export entrypoints — this extension ships neither, and they are not bundled.

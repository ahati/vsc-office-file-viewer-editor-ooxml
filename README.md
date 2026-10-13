# Office File Editor & Viewer

Open Word, Excel, PowerPoint and Visio files directly in Visual Studio Code — rendered on canvas with
high-fidelity WASM engines. No Office install, no server conversion, no telemetry, no network access.

## Supported formats

| Format | Extensions | What you get |
|---|---|---|
| Word | `.docx` `.docm` | Paged canvas rendering with headers/footers, footnotes, tables, tracked-changes & comment cards, text selection & copy |
| Excel | `.xlsx` `.xlsm` | Sheet tabs, formulas (cached values), merged cells, frozen panes, cell selection & copy, zoom |
| PowerPoint | `.pptx` `.pptm` | Slide canvas with masters, images, speaker notes, thumbnail rail, slide navigation |
| Visio | `.vsdx` | Multi-page diagrams with connectors, themes and layer visibility, page tabs, pan & zoom |

## Highlights

- **Faithful rendering** — Rust/WASM engines built from the OOXML formats up, with metric-compatible
  fonts bundled so pagination and line breaks match Office (exact page counts on the upstream fidelity corpus).
- **Fully offline** — every engine, font and asset ships inside the extension. Opening a file makes zero
  network requests.
- **Private by design** — no telemetry, no analytics, no crash reporting. Ever.
- **Safe** — macros in `.docm/.xlsm/.pptm` are never executed; the webview runs under a strict CSP.
- **Live reload** — change the file on disk (e.g. regenerate a report) and the open viewer refreshes.
- **Theme aware** — follows your light/dark/high-contrast VS Code theme.

## Usage

Install, then open any supported file — the viewer registers as the default editor. Use **Open With…**
to switch back to the binary or text editor at any time.

- `Ctrl`/`Cmd` + `+` / `-` / `0` — zoom in / out / reset (Visio: fit & presets in the toolbar)
- `Ctrl`/`Cmd` + `F` — find in document (where the format supports it)
- External hyperlinks open in your system browser via VS Code

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `officeFileViewer.fonts` | `bundled` | Use the bundled metric-compatible fonts (Calibri, Arial, Times New Roman, …) for Office-accurate layout. `off` uses system fonts only. |
| `officeFileViewer.cjkFonts` | `off` | `cdn` additionally fetches CJK font faces from the pinned open-source font CDN — the **only** network access this extension can ever perform. |
| `officeFileViewer.initialZoom` | `fitPage` | Initial zoom for paged viewers: `fitPage`, `fitWidth` or `100`. |
| `officeFileViewer.forceReadOnly` | `false` | Reserve for policy-locked setups. |

## Commands

- **Office File Viewer: Show Diagnostics** — recent engine lifecycle events for bug reports
- **Office File Viewer: Copy Diagnostics to Clipboard**
- **Office File Viewer: Reload Active Viewer**

## Known limitations

- Editing: documents open with the full editor chrome and `Ctrl/Cmd+S` performs a lossless in-place save.
  VS Code-level dirty-state markers, hot-exit backup and external-change conflict prompts are planned for
  an upcoming release — until then, undo history lives inside the open editor.
- Visio: linear fill gradients and arc/gap line jumps render; exotic ShapeSheet features may differ from
  Visio. `.vsdm/.vstx/.vssx` and legacy `.vsd` are not supported.
- CJK text renders with substituted font metrics unless `officeFileViewer.cjkFonts: "cdn"` is enabled.
- ODF (`.odt/.ods/.odp`) and legacy binary formats (`.doc/.xls/.ppt/.vsd`) are not supported.

## Privacy

This extension makes **no network requests** and collects **no data**. All parsing and rendering happens
locally in a sandboxed webview. External links are opened only via an allowlist (`http`, `https`, `mailto`, `tel`).

## License & acknowledgement

[Apache-2.0](./LICENSE) © 2026 ahati.

Built on the open-source [BetterOffice](https://github.com/openooxml/betteroffice) engines
(Apache-2.0, © The OpenOOXML Project) — Rust/WASM DOCX, XLSX, PPTX and VSDX engines — and the
[BetterOffice fonts](https://www.npmjs.com/package/@betteroffice/fonts) collection of open, metric-compatible
font faces. See [NOTICE](./NOTICE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for the full
attribution record.

# PRD — Office File Editor & Viewer: full Office support for VS Code

| | |
|---|---|
| **Status** | Draft v1 — ready for review |
| **Relates to** | [`docs/SCOPING.md`](./SCOPING.md) (research evidence & upstream analysis), [`docs/DESIGN.md`](./DESIGN.md) (technical design) |
| **Name** | Office File Editor & Viewer · id `ahati.office-file-editor-viewer` (decided; BetterOffice appears in attribution only) |
| **Successor of** | `ahati.vscode-office-file-reader-viewer` 0.1.2 (@silurus/ooxml, view-only) |

---

## 1. Vision

A developer opens any Microsoft Office file — Word, Excel, PowerPoint, **Visio** — in VS Code and sees it rendered
exactly as Office would, can **edit and save it losslessly without leaving the editor**, offline, with zero telemetry
and zero server round-trips. One extension, four formats, powered by the open-source BetterOffice Rust/WASM engines.

> "Full office support" = the complete OOXML document lifecycle: **view → inspect → edit → save**, plus Visio
> viewing, inside VS Code's native editor surfaces.

## 2. Problem

- Developers constantly receive Office artifacts (spec .docx, test matrices .xlsx, deck .pptx, architecture diagrams
  .vsdx) but VS Code shows binary garbage. Context-switching to Office/LibreOffice breaks flow; online previewers leak
  confidential documents.
- Existing extensions are either unfaithful (DOM approximations with wrong pagination), narrow (xlsx-only), or
  opaque (proprietary components, opt-out telemetry). **No extension renders VSDX well at all** — the best incumbent
  has 446 installs and self-documented gaps (SCOPING §8).
- Nobody offers **lossless in-editor saving** for OOXML; faithful engines can't open Visio; Visio viewers can't open
  Office files.

## 3. Goals

| # | Goal |
|---|---|
| G1 | High-fidelity **viewing** of `.docx/.docm`, `.xlsx/.xlsm`, `.pptx/.pptm`, `.vsdx` — canvas rendering with Office-accurate pagination |
| G2 | **Lossless editing & saving** of docx/xlsx/pptx (untouched file parts preserved on round-trip — an upstream engine guarantee) |
| G3 | **Fully offline & private**: no network by default, no telemetry, ever; macros are never executed |
| G4 | Visio **.vsdx viewing** with page/layer/zoom fidelity + PDF/SVG/PNG export — a category no incumbent serves |
| G5 | Native VS Code feel: custom editors, theme-aware chrome, file-change reload, hot-exit survival, find, print |
| G6 | Clean OSS story: Apache-2.0, vendored/attribution-complete, publishable on Marketplace + Open VSX |

## 4. Non-goals (explicit)

- ODF (`odt/ods/odp`), legacy binary formats (`.doc/.xls/.ppt/.vsd`), `.vsdm/.vstx/.vssx`, template packages
  (`.dotx/.xltx/.potx` — best-effort open, no support promise)
- Macro **execution** (`.docm/.xlsm/.pptm` render with VBA ignored — by design, a security guarantee)
- Real-time collaboration (upstream supports it; requires relay infrastructure — not a product we operate)
- PDF/EPUB/markdown/images/CSV breadth (the incumbent's moat — we compete on fidelity, not breadth; PDF may return as
  a separate format later)
- Format conversion (e.g., docx→pdf export) — beyond single-artifact export below
- AI/agent editing surfaces (upstream `@betteroffice/agents` — out of scope)
- Telemetry of any kind

## 5. Personas

| Persona | Scenario |
|---|---|
| **Backend dev (Rahul)** | CI fails; the failing values live in a QA team's `.xlsx` with formulas and merged cells. Opens it in VS Code, searches for the endpoint name, fixes a stale cell comment… reads only. Wants instant open, no Office install. |
| **Tech writer (Mara)** | Maintains API docs as `.docx`. Wants to fix a typo/paragraph in VS Code during a docs-as-review PR and save without Word (fidelity + tracked-changes-safe round trip). |
| **Solutions architect (Jonas)** | Keeps system diagrams in Visio. Reviews PRs that ship updated `.vsdx` files; wants to *see* the diagram next to the diff, export page 2 as PNG/SVG for the README. |
| **Security-conscious org** | Air-gapped / regulated environments: mandates zero network, no telemetry, no macro execution; sideloads VSIX. |

## 6. Functional requirements

Priorities: **P0** = release blocker for M1 · **P1** = M2 · **P2** = M3/stretch. AC = acceptance criteria.

### 6.1 Viewing (all P0 unless noted)

| ID | Requirement | AC |
|---|---|---|
| V1 | Custom read-only-grade editors registered as default for `*.docx *.docm *.xlsx *.xlsm *.pptx *.pptm *.vsdx` | "Open With" lists the viewer as default; files open without config |
| V2 | Canvas rendering via BetterOffice engines: Word pages with headers/footers/footnotes; Excel sheets incl. formulas (cached values), merged cells, charts; PowerPoint slides incl. masters, media, speaker notes; Visio pages incl. connectors, layers, themes | Sample corpus (happy-path + fixtures from upstream fidelity suite) renders without errors; pagination matches Office page counts on the reproduced benchmark set |
| V3 | Zoom (in/out/fit-width/fit-page/reset), pan; per-format navigation: page scrubber (docx), sheet tabs (xlsx), slide panel (pptx), page tabs + layer visibility toggle (vsdx) | Keyboard + mouse + status affordances work; zoom persists across reload of same file in session |
| V4 | Theme-aware UI (light/dark/high-contrast) | No hardcoded colors; screenshots pass in 4 themes |
| V5 | Live reload on external file change | Editing the file on disk refreshes the open viewer within 1s; no stale-render window showing old content as current |
| V6 | Graceful failure: corrupt/unsupported/oversized files show a friendly panel with reason + "Copy diagnostics" action | No silent blank webview; reason names the failing OOXML part when known |
| V7 | Text selection & copy (docx at minimum; xlsx cell copy as TSV) | Copied text preserves paragraph/sheet structure; works read-only |
| V8 | Find in document (docx/xlsx/pptx via engine find APIs; vsdx shape-text search) | Find bar with match count, next/prev, Enter/Shift-Enter; <1s on 1MB files |
| V9 | Comments/track-changes visibility (docx: comment & tracked-change cards in viewing mode) | Cards render and are attributed; accept/reject only in edit mode (E6) |

### 6.2 Editing & saving (P1 for OOXML · P2 for vsdx)

| ID | Requirement | AC |
|---|---|---|
| E1 | `docx/xlsx/pptx` open in **editable** mode by default (setting to force read-only); dirty-state tracked; Ctrl+S saves via engine `save()` (lossless round-trip) | Save writes bytes identical-in-semantics to source for unedited files (byte-diff limited to engine-normalized parts); dirty marker clears; re-open shows edits |
| E2 | Undo/redo inside the editor per engine semantics; VS Code-level undo integration where feasible | 100-step undo works in-session; undo history resets on external reload |
| E3 | Hot exit & crash safety: `backup()` persists current bytes; unsaved edits survive VS Code restart | Kill -9 VS Code with dirty editor → reopen restores content |
| E4 | External-change conflict handling while dirty: prompt with **Reload (discard) / Keep mine (save over)** | No silent data loss; prompt shows modification timestamps |
| E5 | docx editing includes **suggesting mode** (tracked changes) toggle in viewer chrome | Edits record as tracked changes; toggle state per session |
| E6 | docx comment/track-changes interaction (accept/reject) available in edit mode | Cards actionable; file saves with decisions applied |
| E7 | vsdx basic editing (move/resize shapes, edit shape text) — **P2**, gated on vendored engine stability | Round-trip save preserves unedited ShapeSheet parts; validate() clean on saved file |

### 6.3 Export & print (P1)

| ID | Requirement | AC |
|---|---|---|
| X1 | Export current page/slide/sheet/visio-page as PNG (engine raster APIs) | Command palette + chrome buttons; correct DPR for HiDPI |
| X2 | Visio: export page as SVG and deck as PDF (engine `exportSvg`/`exportPdf`) | SVG opens in browser; PDF opens in pdf.js viewer |
| X3 | Print (docx via engine print pipeline; xlsx via print display list; vsdx via exported PDF) | OS print dialog opens; print output matches on-screen layout for the sample corpus |
| X4 | Save-as/copy source bytes command (unmodified round-trip) | Output opens in Office without repair prompts |

### 6.4 Workspace & platform (P0 unless noted)

| ID | Requirement | AC |
|---|---|---|
| W1 | Works on Windows/macOS/Linux (x64+arm64), local + Remote SSH/WSL/Containers (reads via `vscode.workspace.fs`) | Integration tests pass on all three OS in CI |
| W2 | Multiple editors simultaneously (one engine per panel); tab switching doesn't lose state within a session | 10 files open → switching tabs re-renders without data loss; memory stays within NFR-3 |
| W3 | Settings contributions (see DESIGN §10): editing default, fonts mode, CJK CDN opt-in, zoom default | All documented; defaults match PRD (fonts bundled, CJK off, editing on) |
| W4 | Diagnostics command + output channel capturing lifecycle/engine errors; one-command shareable log (redacted) | Support workflow: user pastes log into GitHub issue template |
| W5 | Publish to Visual Studio Marketplace **and** Open VSX; VSIX ≤ 75 MB | Both listings live; install verified on VSCodium |
| W6 | Web platform (vscode.dev) — **P2/stretch**: engines are pure browser WASM; requires browser extension entry | Loads in chrome via vscode.dev for all four formats (no promise without spike) |

### 6.5 Privacy & security (all P0)

| ID | Requirement | AC |
|---|---|---|
| S1 | Zero network requests by default (bundled fonts; collaboration transport never injected) | Automated CSP/request audit test: zero non-webview-origin requests across sample corpus |
| S2 | Zero telemetry, zero crash reporting | No telemetry code paths in bundle; reproducible build |
| S3 | Strict webview CSP (nonce + `wasm-unsafe-eval`; `worker-src data: blob:`); external links via allowlist (http/https/mailto/tel) + `env.openExternal` | CSP audit test; javascript:/file: links inert |
| S4 | Macros never executed; embedded OLE objects not activated | docm/xlsm/pptm render content only; no host process spawned (verifiable in sandbox test) |
| S5 | No execution of document scripts; webview has no Node integration | `enableScripts: true` with nonce only; `localResourceRoots` locked to extension dir |

### 6.6 Accessibility & i18n

| ID | Requirement | AC |
|---|---|---|
| A1 | Keyboard-operable viewer chrome; focus order; visible focus rings (P1) | Tab-through completes per panel; no keyboard traps |
| A2 | Engine-provided ARIA semantics preserved; accessible text alternatives: docx selection/copy, xlsx "copy sheet as TSV"/`buildA11yGrid` (P1), vsdx shape list panel (P2) | Screen reader announces structure via copied/grid text (canvas limits documented) |
| A3 | UI language: English (engine i18n packages accept translations later) (P2) | en strings externalized in one file |

## 7. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| N1 | Open-to-first-content latency, mid-range laptop (2020, 16 GB) | docx ≤ 2.5 s, xlsx ≤ 2 s, pptx ≤ 2 s, vsdx ≤ 2 s for ≤ 2 MB files (first page/slide/sheet) |
| N2 | Save latency (no-op round trip) | ≤ 1.5 s for ≤ 5 MB files |
| N3 | Resident memory per open editor | ≤ 600 MB typical doc; engine worker terminated on panel close returns ≥ 90% |
| N4 | VSIX size | ≤ 75 MB (fonts removable via setting if future size pressure) |
| N5 | VS Code compatibility | `engines.vscode >= 1.90`; CI-verified against stable **and** insiders (webview worker regressions, SCOPING §4) |
| N6 | Fidelity | Reproduce upstream benchmark harness in-repo; track docx exact-page-count ≥ 90% and SSIM ≥ 0.80 vs Office-rendered baseline corpus (upstream: 63/63, 0.838) — no regression across releases |
| N7 | Upstream dependency policy | Exact version pins; updates reviewed via changesets; vendored vsdx snapshot records upstream SHA |

## 8. User stories (release-mapped)

- **M1 (viewer):** "As Rahul, I double-click the QA workbook in VS Code and see the sheets with formulas' cached
  values, tab between sheets, zoom to a merged region, and Ctrl+F to the failing endpoint — offline."
- **M1:** "As Jonas, I open the architecture `.vsdx` shipped in the PR, flip layers, export page 2 as SVG, and paste
  it into the README."
- **M2 (editing):** "As Mara, I fix two paragraphs in the spec .docx, accept one reviewer comment, Ctrl+S, and the PR
  diff shows only my paragraphs — untouched XML parts byte-identical."
- **M2:** "As any user, I kill VS Code with a dirty workbook; after restart the restore banner returns my edits."
- **M3:** "As the security reviewer, I run the extension in a no-network sandbox, open all four formats, and confirm
  zero outbound requests and no telemetry endpoints."

## 9. Release plan & success metrics

| Milestone | Scope | Success metrics (6 months post-GA) |
|---|---|---|
| **M1 — Viewer GA** | V1–V9, S1–S5, W1–W5, N1–N7 | ≥ 5,000 installs · rating ≥ 4.0 · render-success ≥ 99% of opens (diagnostics-based support signals) · Open VSX listing live |
| **M2 — Editing GA** | E1–E6, X1–X4, A1–A2 | ≥ 15% of sessions use save (self-reported/issue signal) · zero data-loss issues · tracked-changes round-trip validated against corpus |
| **M3 — Reach** | E7, W6, A3, perf tuning, CJK CDN polish | vsdx opens = top-3 keyword driver in reviews · vscode.dev smoke green (if shipped) |

Metrics are marketplace/install-data + GitHub-issue based (no telemetry, by S2).

## 10. Competitive context (summary)

Full table in `SCOPING.md` §8. Positioning: the only true-canvas, offline, zero-telemetry viewer spanning OOXML **and**
VSDX; the only one adding **lossless editing** to that combination. Incumbent weaknesses we exploit: DOM-approximation
fidelity (cweijan 1.57 M installs, no Visio, opt-out Azure telemetry), xlsx UX pain (6.8 M-install viewer at 3.4★),
greenfield Visio (best: 446 installs).

## 11. Dependencies

| Dependency | Role | Risk posture |
|---|---|---|
| `@betteroffice/docx` 0.4.x, `@betteroffice/xlsx` 0.3.x, `@betteroffice/pptx` 0.2.x | rendering/editing engines | npm-published; pinned; `@experimental` API churn (SCOPING R6) |
| `@betteroffice/vsdx` (vendored @ pinned SHA) | Visio engine | unpublished upstream — we own the build (SCOPING §5) |
| `@betteroffice/fonts` (+ optional `fonts-cjk` via CDN) | metric-compatible fonts | npm-published |
| VS Code Custom Editor API, webview workers/WASM | platform | regression class #315494 — self-contained workers mitigate (DESIGN §4) |

## 12. Product risks

| Risk | Impact | Mitigation |
|---|---|---|
| Editing introduces data-loss/corruption incidents | Trust destroyed (product killer) | E1 AC byte-diff harness; backup-before-save; conflict prompts (E4); corpus regression suite per release |
| Upstream changes engine APIs mid-cycle | Rework | Exact pins + adapter layer (DESIGN §3.4); changeset watch in CI |
| vsdx fidelity below user expectations (ShapeSheet edge cases) | Feature discount | Validate page in M1 with real corpus; publish known-limitations list (mirroring upstream docs) |
| VS Code webview regressions on upgrade | Viewer breaks for users | Insiders CI lane; self-contained worker design; fast patch release path |
| VSIX size growth | Install friction | N4 budget; fonts setting off-switch; measure per release |

## 13. Open decisions (carried from SCOPING §13, now defaulting)

1. License → **Apache-2.0** (rationale SCOPING §7) — *confirm*
2. Fonts bundled by default → **yes**; CJK via opt-in CDN — *confirm*
3. vsdx delivery → **vendored snapshot + CI wasm build** — *confirm*
4. Editing default-on for OOXML in M2 (vs read-only forever) → **default-on, force-read-only setting** — *confirm*
5. Name/publisher — **DECIDED**: `ahati.office-file-editor-viewer`, display name "Office File Editor & Viewer"; BetterOffice branding appears only in attribution. Dual-registry publish (Marketplace + Open VSX) — *confirm publish targets*

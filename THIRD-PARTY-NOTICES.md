# Third-party notices

This extension bundles or is derived from the third-party software listed below. Entries are added
as material is incorporated. The authoritative license texts for each component ship with the
corresponding upstream package.

---

## betteroffice (`@betteroffice/*`)

- Packages bundled at runtime: `@betteroffice/xlsx`, `@betteroffice/xlsx-react`,
  `@betteroffice/pptx`, `@betteroffice/pptx-react`, `@betteroffice/fonts`. (The Word surface no
  longer uses `@betteroffice/docx`; it bundles the upstream `@docx-editor.dev/*` packages instead —
  see the next entry.)
- Upstream: The OpenOOXML Project (`openooxml/betteroffice`), pinned for this milestone at
  commit `57fc1984`.
- License: Apache License, Version 2.0 — Copyright 2026 Elia Hilse, The OpenOOXML Project.
- The extension also vendors a snapshot of `packages/vsdx/**`, `shared/collaboration-limits.ts`, the
  relevant Rust crate closure (`crates/vsdx-*`, `crates/ooxml-{opc,drawingml,text}`) and upstream
  build scripts under `vendor/betteroffice/`; see `vendor/betteroffice/README.md` for the recorded
  upstream revision and the sync procedure.

### docx-editor.dev (`@docx-editor.dev/*`) — upstream of the `@betteroffice/docx` derivation

The API design and portions of the TypeScript packages in the betteroffice repository derive from the
docx-editor.dev editor (upstream repository: <https://github.com/eigenpal/docx-editor>, mirrored at
<https://github.com/sorenlouv/docx-editor>). The Word surface of this extension bundles the current
2.x line, published on npm under the renamed `@docx-editor.dev/*` scope:

- `@docx-editor.dev/core` 2.29.0
- `@docx-editor.dev/react` 2.29.0
- `@docx-editor.dev/i18n` 2.29.0 (transitive dependency of both)

2.29.0 is the current release of the same codebase previously consumed as the
`@eigenpal/docx-editor-*` packages (1.9.0, the frozen end of the old npm scope).

License: Apache License, Version 2.0 (per the `license` field of the published package metadata and
the `LICENSE` file shipped in the packages). Copyright 2026 EigenPal Inc.

The license terms are identical to this repository's root `LICENSE`; that file serves as the copy of
the license for this derivation.

## Bundled docx-editor runtime dependencies

The Word editor's published bundles pull in the runtime packages below, which this extension's build
bundles into the webview. Each is redistributed in modified (bundled, minified, tree-shaken) form
under its own license; the authoritative license texts ship with the installed packages.

### MIT

- `harfbuzzjs` 1.6.1 — MIT, Copyright (c) 2019-2026 The harfbuzzjs project authors. The published
  `harfbuzz.wasm` also contains HarfBuzz itself, distributed under HarfBuzz's MIT-style license
  (`licenses/HarfBuzz-COPYING.txt` in upstream `@docx-editor.dev/core`).
- `utif2` 4.1.0 — MIT, Copyright (c) 2017 Photopea.
- `bidi-js` 1.1.0 — MIT, Copyright (c) 2021 Jason Johnston.
- `fflate` 0.8.3 — MIT, Copyright (c) 2026 Arjun Barrett.
- `fast-xml-parser` 5.11.2 — MIT, Copyright (c) 2017 Amit Kumar Gupta.
- `prosemirror-view` 1.42.6, `prosemirror-model` 1.25.12, `prosemirror-state` 1.4.4,
  `prosemirror-keymap` 1.2.3, `prosemirror-commands` 1.7.2 and `prosemirror-transform` 1.12.2
  (transitive) — MIT, Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and
  others.
- `clsx` 2.1.1 — MIT, Copyright (c) Luke Edwards <luke.edwards05@gmail.com>.
- `@radix-ui/react-select` 2.4.1 — MIT, Copyright (c) 2022 WorkOS. Bundled together with the internal
  `@radix-ui/*` primitives it depends on, which carry the same license and copyright.

### Apache-2.0

- `emf-converter` 2.0.2 — Apache License, Version 2.0 (author: ChristopherVR,
  <https://github.com/ChristopherVR/emf-converter>).
- `class-variance-authority` 0.7.1 — Apache License, Version 2.0 — Copyright 2022 Joe Bell.

`@docx-editor.dev/core` declares `yjs` and `pdf-lib` as peer dependencies for its collaboration and
PDF-export capability surface. Neither is imported by the editor chain and neither is bundled into
the webview.

---

## React

`react` and `react-dom` are bundled into the webview entry bundles.

- Upstream: <https://github.com/facebook/react>
- License: MIT — Copyright Meta Platforms, Inc. and affiliates.
- This extension ships the license text of the installed packages under
  `node_modules/react/LICENSE` / `node_modules/react-dom/LICENSE` at build time; the packages do not
  contribute code to the extension host.

---

## BetterOffice bundled fonts (`@betteroffice/fonts`)

`@betteroffice/fonts@0.4.0` redistributes open-licensed font faces (Carlito, Caladea, Liberation
Sans/Serif/Mono, Noto Sans Arabic, Noto Naskh Arabic, Noto Sans Hebrew, Gelasio, Comic Relief,
Inter, Roboto, Open Sans, Source Sans 3, Montserrat, Poppins, Oswald, Heebo, DM Sans, DM Serif
Display, …). All are licensed under the SIL Open Font License, Version 1.1, unless documented
otherwise by the upstream package.

- Upstream: <https://github.com/openooxml/betteroffice> (`packages/fonts`), which vendors the faces
  unmodified from their respective upstream projects and ships the applicable OFL texts, with the
  copyright notices they cover, under the package's `LICENSES/` directory. Those files are the
  authoritative copies for redistribution and are not duplicated here.
- Each face retains its own copyright line and Reserved Font Name as recorded in the package's
  `LICENSES/` files (for example: Carlito — Copyright 2013 The Carlito Project Authors; Caladea —
  Copyright 2012 The Caladea Project Authors; Liberation — Copyright 2012 Red Hat, Inc.;
  Noto — Copyright 2022 The Noto Project Authors).

Bundling these faces in the webview asset directory is redistributing unmodified font binaries; the
OFL permits this provided the license and notices accompany the fonts, which the upstream package
guarantees for every installed copy.

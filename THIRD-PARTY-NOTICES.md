# Third-party notices

This extension bundles or is derived from the third-party software listed below. Entries are added
as material is incorporated. The authoritative license texts for each component ship with the
corresponding upstream package.

---

## betteroffice (`@betteroffice/*`)

- Packages bundled at runtime: `@betteroffice/docx`, `@betteroffice/docx-react`,
  `@betteroffice/xlsx`, `@betteroffice/xlsx-react`, `@betteroffice/pptx`,
  `@betteroffice/pptx-react`, `@betteroffice/fonts`.
- Upstream: The OpenOOXML Project (`openooxml/betteroffice`), pinned for this milestone at
  commit `57fc1984`.
- License: Apache License, Version 2.0 — Copyright 2026 Elia Hilse, The OpenOOXML Project.
- The extension also vendors a snapshot of `packages/vsdx/**`, `shared/collaboration-limits.ts`, the
  relevant Rust crate closure (`crates/vsdx-*`, `crates/ooxml-{opc,drawingml,text}`) and upstream
  build scripts under `vendor/betteroffice/`; see `vendor/betteroffice/README.md` for the recorded
  upstream revision and the sync procedure.

### eigenpal docx editor (derivation of `@betteroffice/docx`)

The API design and portions of the TypeScript packages in the betteroffice repository derive from the
eigenpal docx editor (upstream repository: <https://github.com/eigenpal/docx-editor>, mirrored at
<https://github.com/sorenlouv/docx-editor>), published on npm as the following packages (last
release: 1.9.0):

- `@eigenpal/docx-editor-core`
- `@eigenpal/docx-editor-react`
- `@eigenpal/docx-editor-vue`
- `@eigenpal/docx-editor-i18n`
- `@eigenpal/docx-editor-agents`
- `@eigenpal/nuxt-docx-editor`

License: Apache License, Version 2.0 (per the `license` field of the published package metadata and
the `LICENSE` file shipped in the packages). Copyright 2026 EigenPal Inc.

The license terms are identical to this repository's root `LICENSE`; that file serves as the copy of
the license for this derivation.

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

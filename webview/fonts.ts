/**
 * Per-format font wiring (DESIGN §8, SCOPING §6; MIGRATION-DOCX-EDITOR-2X §4).
 *
 * - docx (@docx-editor.dev/* 2.29.0): the editor takes BYTES — a `FontConfigurationFragment`
 *   (`{ supportedFamilies, sources }`) whose sources are built with `createFontSource`. We resolve
 *   our bundled metric-compatible faces (`@betteroffice/fonts`) to the Office family names Word
 *   documents reference and load their TTFs through the bundle's asset lookups (`__extAssetUrl`,
 *   i.e. `out/media/assets/`, extension origin), so Office-accurate layout stays fully offline.
 *   2.x has no Google Fonts path at all (that origin lives in the separate, uninstalled
 *   `@docx-editor.dev/fonts/google`), and a face that cannot be produced degrades only itself.
 * - pptx (@betteroffice/pptx): takes `PptxFontFace[]` (family + bytes) — registered under their
 *   real family names so the engine matches deck runs.
 * - xlsx: no font API at all (SCOPING R8).
 */
import { loadBundledFontBytes, resolveLastResortFace, resolveMetricCompatFace } from '@betteroffice/fonts';
import { createFontSource, type FontConfigurationFragment } from '@docx-editor.dev/core/editor';
import type { FontFaceRequest, FontSource } from '@docx-editor.dev/core/contracts/editor';
import type { PptxFontFace } from '@betteroffice/pptx';
import type { ViewerWebviewConfig } from './protocol';

/** Families Word documents most commonly reference; resolved to bundled metric-compatible faces. */
const DOCX_FAMILIES = ['Calibri', 'Cambria', 'Arial', 'Times New Roman', 'Courier New'] as const;

/** Families the pptx engine matches deck runs against (real family names, metric-compatible bytes). */
const PPTX_FAMILIES = [
	'Arial',
	'Calibri',
	'Cambria',
	'Times New Roman',
	'Courier New',
	'Georgia',
	'Comic Sans MS',
	'Inter',
	'Roboto',
	'Open Sans',
	'Montserrat',
	'Poppins',
	'DM Sans',
	'DM Serif Display',
	'Oswald',
	'Heebo',
] as const;

const STYLE_VARIANTS: ReadonlyArray<{ bold: boolean; italic: boolean }> = [
	{ bold: false, italic: false },
	{ bold: true, italic: false },
	{ bold: false, italic: true },
	{ bold: true, italic: true },
];

let docxFontDefinitions: Promise<FontConfigurationFragment> | undefined;
let pptxFontFaces: Promise<PptxFontFace[]> | undefined;

/**
 * Byte-backed font configuration for the docx editor: our bundled metric-compatible faces exposed
 * under the Office family names, loaded from extension assets (never the network).
 *
 * Every family is registered in all four bold/italic variants under the name a document names it by
 * (`Calibri`, …) with the bytes of the metric-compatible substitute (`Carlito`) — the aliasing that
 * keeps Word line breaks and pagination. Each face yields its own source; a face whose bytes cannot
 * be read or admitted is skipped with a warning while the rest still load (per-face degradation is
 * the upstream semantic), so one bad asset never costs the whole document its metrics.
 */
export function loadDocxFontDefinitions(config: ViewerWebviewConfig): Promise<FontConfigurationFragment> {
	if (docxFontDefinitions) return docxFontDefinitions;

	docxFontDefinitions = (async () => {
		if (config.fonts === 'off') {
			console.info('[office-file-viewer] bundled docx fonts disabled (officeFileViewer.fonts=off)');
			return { supportedFamilies: [], sources: [] };
		}

		const resolved = await Promise.all(
			DOCX_FAMILIES.flatMap((family) =>
				STYLE_VARIANTS.map(async ({ bold, italic }): Promise<FontSource | undefined> => {
					const face =
						resolveMetricCompatFace(family, bold, italic) ?? resolveLastResortFace(family, bold, italic);
					const label = `${family} ${bold ? 'bold' : 'regular'}${italic ? ' italic' : ''}`;
					// The request carries the AUTHORED face: the bytes may be a substitute, but the engine
					// must find a source for the family/weight/style the document actually asked for.
					const request: FontFaceRequest = {
						family,
						weight: bold ? 700 : 400,
						style: italic ? 'italic' : 'normal',
					};
					try {
						// Same asset lookup the engine bundles use (rewritten to `__extAssetUrl`): extension
						// origin, served from out/media/assets — no font CDN, no egress.
						const bytes = new Uint8Array(await loadBundledFontBytes(face));
						const outcome = createFontSource(bytes, request);
						if ('failure' in outcome) {
							console.warn(
								`[office-file-viewer] docx font face "${label}" rejected (${outcome.failure.reason}); skipping it`,
							);
							return undefined;
						}
						return outcome.source;
					} catch (error) {
						console.warn(`[office-file-viewer] docx font face "${label}" could not be loaded; skipping it`, error);
						return undefined;
					}
				}),
			),
		);

		return {
			supportedFamilies: [...DOCX_FAMILIES],
			sources: resolved.filter((source): source is FontSource => source !== undefined),
		};
	})();

	return docxFontDefinitions;
}

/** The faces `PptxEditor` needs: every resolvable family in the 4 bold/italic variants. */
export async function loadPptxFontFaces(config: ViewerWebviewConfig): Promise<PptxFontFace[]> {
	if (pptxFontFaces) return pptxFontFaces;

	pptxFontFaces = (async () => {
		if (config.fonts === 'off') {
			// One minimal face is enough to open a deck (engine contract: non-empty fonts array);
			// the browser/deck fallback chain synthesizes the other styles.
			const face = resolveLastResortFace('Arial', false, false);
			const bytes = await loadBundledFontBytes(face);
			console.info('[office-file-viewer] pptx fonts=off: using a single last-resort face');
			return [{ family: 'Arial', bold: false, italic: false, bytes: new Uint8Array(bytes.slice(0)) }];
		}

		const faces = await Promise.all(
			PPTX_FAMILIES.flatMap((family) =>
				STYLE_VARIANTS.map(async ({ bold, italic }): Promise<PptxFontFace | undefined> => {
					const face = resolveMetricCompatFace(family, bold, italic);
					if (!face) return undefined; // family has no bundled metric-compatible face
					const bytes = await loadBundledFontBytes(face);
					return { family, bold, italic, bytes: new Uint8Array(bytes.slice(0)) };
				}),
			),
		);

		const resolved = faces.filter((face): face is PptxFontFace => face !== undefined);
		if (resolved.length === 0) {
			// Engine contract: at least one face must exist. Last-resort resolution never fails, but
			// if the font package changes shape, fail loudly instead of rendering a blank deck.
			throw new Error('no pptx font face could be resolved (PptxEditor requires a non-empty fonts array)');
		}
		return resolved;
	})();

	return pptxFontFaces;
}

/** Test hook: forget the memoized state (each webview entry calls these at most once anyway). */
export function resetFontsForTests(): void {
	docxFontDefinitions = undefined;
	pptxFontFaces = undefined;
}

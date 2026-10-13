/**
 * Per-format font wiring (DESIGN §8, SCOPING §6).
 *
 * - docx (@eigenpal/docx-editor): takes `FontDefinition[]` — family + src URL + weight — and
 *   injects `@font-face` rules itself. We point `src` at our bundled metric-compatible TTFs via
 *   `__extAssetUrl` so Office-accurate layout stays fully offline. The engine's built-in Google
 *   Fonts lookup MUST be disabled before mount (`setGoogleFontsEnabled(false)`, module scope in
 *   the docx mount) — that is the only network path in the entire product.
 * - pptx (@betteroffice/pptx): takes `PptxFontFace[]` (family + bytes) — registered under their
 *   real family names so the engine matches deck runs.
 * - xlsx: no font API at all (SCOPING R8).
 */
import { loadBundledFontBytes, resolveLastResortFace, resolveMetricCompatFace } from '@betteroffice/fonts';
import type { FontDefinition } from '@eigenpal/docx-editor-core/utils';
import type { PptxFontFace } from '@betteroffice/pptx';
import { getAssetUrl } from './bootstrap/assetBootstrap';
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

let docxFontDefinitions: Promise<FontDefinition[]> | undefined;
let pptxFontFaces: Promise<PptxFontFace[]> | undefined;

/**
 * Font definitions for the eigenpal docx editor: bundled metric-compatible faces exposed under
 * the Office family names, served from extension assets (never the network).
 *
 * `FontDefinition` has no italic axis, so italic runs are synthesized by the browser from the
 * registered regular/bold faces — same tradeoff as upstream's own `fonts` prop examples.
 */
export function loadDocxFontDefinitions(config: ViewerWebviewConfig): Promise<FontDefinition[]> {
	if (docxFontDefinitions) return docxFontDefinitions;

	docxFontDefinitions = (async () => {
		if (config.fonts === 'off') return [];
		const defs = await Promise.all(
			DOCX_FAMILIES.flatMap((family) =>
				[400, 700].map(async (weight): Promise<FontDefinition | undefined> => {
					const face =
						resolveMetricCompatFace(family, weight === 700, false) ??
						resolveLastResortFace(family, weight === 700, false);
					if (!face?.file) return undefined;
					// Resolve lazily at font-use time: `src` is the asset URL, the browser fetches
					// on demand (connect-src is already scoped to the extension origin).
					return { family, weight, src: getAssetUrl(face.file) };
				}),
			),
		);
		return defs.filter((def): def is FontDefinition => def !== undefined);
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

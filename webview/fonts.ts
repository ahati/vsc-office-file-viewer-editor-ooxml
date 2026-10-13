/**
 * Per-format font wiring (DESIGN §8, SCOPING §6).
 *
 * The engines never reach for a font package on their own: docx takes a provider through
 * `configureDefaultFonts({ fonts })` (process-wide, memoized) and pptx takes `PptxFontFace[]`
 * directly. xlsx has no font API at all (SCOPING R8). Either way the bytes come from
 * `@betteroffice/fonts`, whose asset URLs the build rewrote to `__extAssetUrl(...)` lookups served
 * from `out/media/assets/` — so this stays fully offline.
 *
 * `officeFileViewer.fonts: "off"` skips the bundled provider, *but* pptx still gets one
 * last-resort face: `PptxEditor` requires a non-empty `fonts` array and no-ops/blank-renders
 * without glyph metrics. That face is resolved through `resolveLastResortFace` (a single TTF) and
 * the choice is reported to diagnostics by the caller.
 */
import * as fonts from '@betteroffice/fonts';
import { loadBundledFontBytes, resolveLastResortFace, resolveMetricCompatFace } from '@betteroffice/fonts';
import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { setGoogleFontsEnabled } from '@betteroffice/docx/utils';
import type { PptxFontFace } from '@betteroffice/pptx';
import type { ViewerWebviewConfig } from './protocol';

/** Word family the pptx fallback chain starts from (upstream demo pattern). */
const PPTX_FAMILY = 'Arial';

/**
 * Families registered for deck text matching, in addition to `PPTX_FAMILY`: the engine picks the
 * face registered FOR a run's family (docs: "the face registered for its family, else a registered
 * Arial or sans-serif face"), so matching the common Office/deck families with their
 * metric-compatible substitutes is what keeps line breaks and wrap widths Office-accurate.
 * Only families `resolveMetricCompatFace` actually maps are registered (checked at runtime).
 */
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

let docxFontsConfigured = false;
let googleFontsDisabled = false;
let pptxFontFaces: Promise<PptxFontFace[]> | undefined;

/**
 * Configures the docx (layout) font provider once per webview. Must run before `DocxEditor` is
 * imported/mounted: `@betteroffice/docx`'s module scope resolves the provider lazily, but the
 * editor starts laying out as soon as it renders.
 */
export function configureDocxFonts(config: ViewerWebviewConfig): void {
	if (docxFontsConfigured) return;
	docxFontsConfigured = true;

	// Never fetch Google Fonts: offline by construction (the only opt-in network path is the CJK
	// CDN, which M1 does not enable).
	if (!googleFontsDisabled) {
		googleFontsDisabled = true;
		try {
			setGoogleFontsEnabled(false);
		} catch (error) {
			console.warn('[office-file-viewer] setGoogleFontsEnabled(false) failed', error);
		}
	}

	if (config.fonts === 'off') {
		console.info('[office-file-viewer] bundled docx fonts disabled (officeFileViewer.fonts=off)');
		return;
	}

	configureDefaultFonts({ fonts });
}

/** The faces `PptxEditor` needs: every resolvable family in the 4 bold/italic variants. */
export async function loadPptxFontFaces(config: ViewerWebviewConfig): Promise<PptxFontFace[]> {
	if (pptxFontFaces) return pptxFontFaces;

	pptxFontFaces = (async () => {
		const variants: Array<{ bold: boolean; italic: boolean }> = [
			{ bold: false, italic: false },
			{ bold: true, italic: false },
			{ bold: false, italic: true },
			{ bold: true, italic: true },
		];

		if (config.fonts === 'off') {
			// One minimal face is enough to open a deck (engine contract: non-empty fonts array);
			// the browser/deck fallback chain synthesizes the other styles.
			const face = resolveLastResortFace(PPTX_FAMILY, false, false);
			const bytes = await loadBundledFontBytes(face);
			console.info('[office-file-viewer] pptx fonts=off: using a single last-resort face');
			return [{ family: PPTX_FAMILY, bold: false, italic: false, bytes: new Uint8Array(bytes.slice(0)) }];
		}

		const faces = await Promise.all(
			PPTX_FAMILIES.flatMap((family) =>
				variants.map(async ({ bold, italic }): Promise<PptxFontFace | undefined> => {
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
	docxFontsConfigured = false;
	googleFontsDisabled = false;
	pptxFontFaces = undefined;
}

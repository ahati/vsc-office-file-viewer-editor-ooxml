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
/** PptxFontFace family name the engine matches deck text against. */
const PPTX_FALLBACK_NAME = 'Arial';

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

/** The options `PptxEditor` needs: `Arial` in the 4 bold/italic variants (+ last-resort fallback). */
export async function loadPptxFontFaces(config: ViewerWebviewConfig): Promise<PptxFontFace[]> {
	if (pptxFontFaces) return pptxFontFaces;

	pptxFontFaces = (async () => {
		const variants: Array<{ bold: boolean; italic: boolean }> = [
			{ bold: false, italic: false },
			{ bold: true, italic: false },
			{ bold: false, italic: true },
			{ bold: true, italic: true },
		];

		const faces = await Promise.all(
			variants.map(async ({ bold, italic }): Promise<PptxFontFace | undefined> => {
				if (config.fonts === 'off' && !(bold === false && italic === false)) {
					// One minimal face is enough to open a deck; the browser/deck fallback chain
					// synthesizes the other styles.
					return undefined;
				}
				const face =
					config.fonts === 'off'
						? resolveLastResortFace(PPTX_FAMILY, bold, italic)
						: (resolveMetricCompatFace(PPTX_FAMILY, bold, italic) ?? resolveLastResortFace(PPTX_FAMILY, bold, italic));
				const bytes = await loadBundledFontBytes(face);
				return { family: PPTX_FALLBACK_NAME, bold, italic, bytes: new Uint8Array(bytes.slice(0)) };
			}),
		);

		const resolved = faces.filter((face): face is PptxFontFace => face !== undefined);
		if (resolved.length === 0) {
			// Engine contract: at least one face must exist. Last-resort resolution never fails, but
			// if the font package changes shape, fail loudly instead of rendering a blank deck.
			throw new Error('no pptx font face could be resolved (PptxEditor requires a non-empty fonts array)');
		}
		if (config.fonts === 'off') {
			console.info('[office-file-viewer] pptx fonts=off: using a single last-resort face');
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

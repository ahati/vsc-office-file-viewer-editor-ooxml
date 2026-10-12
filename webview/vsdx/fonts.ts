/**
 * Font loading for the vsdx viewer.
 *
 * The engine takes `VsdxFontFace[]` at `openDiagram(bytes, { fonts })` and registers each face with
 * the wasm renderer (`registerFont(family, bold, italic, bytes)`) — fonts are fixed for the lifetime
 * of the handle, so they are resolved once per open.
 *
 * Upstream demo pattern (SCOPING §6): four style variants of "Arial" resolved through
 * `resolveMetricCompatFace('Arial', bold, italic) ?? resolveLastResortFace(...)` and loaded with
 * `loadBundledFontBytes`. Both live in the bundled-and-offline `@betteroffice/fonts` package whose
 * `new URL('../assets/*.ttf', import.meta.url)` lookups are rewritten by the build into manifest
 * lookups (`__boAssetUrl`), so nothing is fetched from the network.
 *
 * `config.fonts === 'off'` still loads exactly one last-resort face: the engine needs at least one
 * registered face to measure text at all. `config.cjkFonts === 'cdn'` swaps the source for the
 * lazily imported CDN provider (best effort — a failure falls back to the bundled faces).
 */
import { loadBundledFontBytes, resolveLastResortFace, resolveMetricCompatFace } from '@betteroffice/fonts';
import type { VsdxFontFace } from '../../vendor/betteroffice/vsdx/src/index';
import type { ViewerWebviewConfig } from '../protocol';
import { errorText } from './util';

/** Family name the diagram asks for; the bundled face stands in for it metric-compatibly. */
export const DEFAULT_FONT_FAMILY = 'Arial';

const STYLE_VARIANTS: ReadonlyArray<{ bold: boolean; italic: boolean }> = [
	{ bold: false, italic: false },
	{ bold: true, italic: false },
	{ bold: false, italic: true },
	{ bold: true, italic: true },
];

export interface VsdxFontLoadResult {
	fonts: VsdxFontFace[];
	/** Non-fatal problems; the caller logs them and renders with whatever load succeeded. */
	warnings: string[];
}

export async function loadVsdxFonts(config: ViewerWebviewConfig): Promise<VsdxFontLoadResult> {
	const warnings: string[] = [];

	if (config.fonts === 'off') {
		const bytes = await tryLoad(
			() => loadBundledFontBytes(resolveLastResortFace(DEFAULT_FONT_FAMILY, false, false)),
			warnings,
			'last-resort regular face',
		);
		return { fonts: bytes ? [{ family: DEFAULT_FONT_FAMILY, bytes }] : [], warnings };
	}

	if (config.cjkFonts === 'cdn') {
		const cdnFonts = await loadCdnFaces(warnings);
		if (cdnFonts.length > 0) return { fonts: cdnFonts, warnings };
		warnings.push('CDN faces unavailable; falling back to the bundled font assets');
	}

	const fonts: VsdxFontFace[] = [];
	for (const variant of STYLE_VARIANTS) {
		const bytes = await tryLoad(
			() => {
				const face =
					resolveMetricCompatFace(DEFAULT_FONT_FAMILY, variant.bold, variant.italic) ??
					resolveLastResortFace(DEFAULT_FONT_FAMILY, variant.bold, variant.italic);
				return loadBundledFontBytes(face);
			},
			warnings,
			`${variant.bold ? 'bold' : 'regular'}${variant.italic ? ' italic' : ''} ${DEFAULT_FONT_FAMILY} face`,
		);
		if (bytes) {
			fonts.push({ family: DEFAULT_FONT_FAMILY, bold: variant.bold, italic: variant.italic, bytes });
		}
	}
	if (fonts.length === 0) {
		warnings.push(
			`no ${DEFAULT_FONT_FAMILY} faces could be loaded; the engine falls back to its internal metrics`,
		);
	}
	return { fonts, warnings };
}

/** Lazily pulls the four variants from the pinned CDN provider (opt-in via `cjkFonts: 'cdn'`). */
async function loadCdnFaces(warnings: string[]): Promise<VsdxFontFace[]> {
	try {
		const cdn = await import('@betteroffice/fonts/cdn');
		const provider = cdn.createFontProvider();
		const fonts: VsdxFontFace[] = [];
		for (const variant of STYLE_VARIANTS) {
			const load =
				provider.resolve(DEFAULT_FONT_FAMILY, variant.bold, variant.italic) ??
				provider.resolveLastResort(DEFAULT_FONT_FAMILY, variant.bold, variant.italic);
			fonts.push({
				family: DEFAULT_FONT_FAMILY,
				bold: variant.bold,
				italic: variant.italic,
				bytes: new Uint8Array(await load()),
			});
		}
		return fonts;
	} catch (error) {
		warnings.push(`CDN font loading failed: ${errorText(error)}`);
		return [];
	}
}

async function tryLoad(
	load: () => Promise<ArrayBuffer>,
	warnings: string[],
	label: string,
): Promise<Uint8Array | undefined> {
	try {
		return new Uint8Array(await load());
	} catch (error) {
		warnings.push(`failed to load the ${label}: ${errorText(error)}`);
		return undefined;
	}
}

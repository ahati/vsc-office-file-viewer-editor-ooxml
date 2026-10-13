/**
 * Webview entry — Word documents (.docx / .docm).
 *
 * Handshake (DESIGN §3.3/§9): `ready` -> host `init { bytes, config, fileName, mediaBase }` ->
 * `bootstrap()` (manifest + wasm/font asset URLs) -> dynamic import of the `docx` mount ->
 * eigenpal `DocxEditor` (DOM paginated editor; offline fonts, Google Fonts disabled) ->
 * `loaded { fileName, timings }`.
 *
 * Everything format-specific (fonts, props, find/reset APIs) lives in `webview/mounts/docx.tsx`;
 * the shared protocol plumbing lives in `webview/bootstrap/entryRuntime.ts`.
 */
import { runViewerEntry } from '../bootstrap/entryRuntime';

runViewerEntry({
	format: 'docx',
	async mount(init, context) {
		const { mountDocx } = await import('../mounts/docx');
		await mountDocx(init, context);
	},
});

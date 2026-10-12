/**
 * Webview entry — PowerPoint presentations (.pptx / .pptm).
 *
 * Handshake (DESIGN §3.3/§9): `ready` -> host `init` -> `bootstrap()` ->
 * `initWasm(pptx_wasm_bg.wasm bytes)` (the engine runs in-thread; the dist ships no worker) ->
 * `loadPptxFontFaces()` -> `PptxEditor` read-only with `fonts` -> `loaded { fileName, timings }`.
 */
import { runViewerEntry } from '../bootstrap/entryRuntime';

runViewerEntry({
	format: 'pptx',
	async mount(init, context) {
		const { mountPptx } = await import('../mounts/pptx');
		await mountPptx(init, context);
	},
});

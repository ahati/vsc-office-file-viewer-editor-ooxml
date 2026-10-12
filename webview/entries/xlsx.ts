/**
 * Webview entry — Excel workbooks (.xlsx / .xlsm).
 *
 * Handshake (DESIGN §3.3/§9): `ready` -> host `init` -> `bootstrap()` -> `initWasm(xlsx_wasm_bg.wasm
 * bytes)` (the engine runs in-thread; the dist ships no worker) -> `XlsxEditor` read-only ->
 * `loaded { fileName, timings }`.
 *
 * xlsx has no font API (SCOPING R8), so no font provider is configured here.
 */
import { runViewerEntry } from '../bootstrap/entryRuntime';

runViewerEntry({
	format: 'xlsx',
	async mount(init, context) {
		const { mountXlsx } = await import('../mounts/xlsx');
		await mountXlsx(init, context);
	},
});

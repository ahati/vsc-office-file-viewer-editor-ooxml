/**
 * Webview entry — Visio diagrams (.vsdx).
 *
 * Handshake (DESIGN §3.3/§9): `ready` -> host `init { bytes, config, fileName, mediaBase }` ->
 * `bootstrap()` (manifest + wasm/font asset URLs) -> dynamic import of the `vsdx` mount ->
 * full `VsdxEditor` (vendored @betteroffice/vsdx-react: ribbon, Shapes sidebar, Drawing Explorer,
 * Shape Data, Layers, page tabs, zoom slider) -> `loaded { fileName, timings }`.
 *
 * Saving: the editor's save action is intercepted in the mount and routed to the host for
 * in-place writes (lossless engine `save()`).
 */
import { runViewerEntry } from '../bootstrap/entryRuntime';

runViewerEntry({
	format: 'vsdx',
	async mount(init, context) {
		const { mountVsdx } = await import('../mounts/vsdx');
		await mountVsdx(init, context);
	},
});

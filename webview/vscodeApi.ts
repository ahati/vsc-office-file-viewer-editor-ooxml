/**
 * Typed access to the VS Code webview API.
 *
 * `acquireVsCodeApi()` is injected by the webview host into every webview document (and may only be
 * called once per document), so it is declared here as a global for all entry bundles.
 */

export interface VsCodeApi<State = unknown> {
	/** Posts a message to the extension host. */
	postMessage(message: unknown): void;
	/** Restores state persisted by `setState` (survives hide/restore and reload). */
	getState(): State | undefined;
	/** Persists small UI state (scroll position, zoom, page) with the webview. */
	setState(state: State): void;
}

declare global {
	function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;
}

/**
 * Convenience wrapper with a clear failure mode when an entry bundle is accidentally loaded outside
 * a webview (for example in a plain browser tab).
 */
export function getVsCodeApi<State = unknown>(): VsCodeApi<State> {
	if (typeof acquireVsCodeApi !== 'function') {
		throw new Error('acquireVsCodeApi() is unavailable: this bundle must run inside a VS Code webview');
	}
	return acquireVsCodeApi<State>();
}

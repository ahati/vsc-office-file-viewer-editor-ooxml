/**
 * Webview globals and module wildcards available to webview-side sources (extended for the engine
 * adapter milestone).
 *
 * `__boAssetUrl` / `__boWorkerUrl` are injected by the build (scripts/build.mjs,
 * `asset-import-rewrite`) into the engines' bundle-time asset lookups:
 *   - webview main thread: defined by `webview/bootstrap/assetBootstrap.ts` (manifest-driven),
 *   - engine worker:       defined by `webview/bootstrap/workerFetchShim.ts` (`bo-asset://` scheme,
 *                          served from the bytes the main thread posted).
 */

export {};

declare global {
	/**
	 * Resolves the original asset basename (e.g. `docx_edit_bg.wasm`, `Carlito-Regular.ttf`) to a URL
	 * that the current context can fetch. `fallbackUrl` is the esbuild-emitted URL for the asset.
	 */
	var __boAssetUrl: ((name: string, fallbackUrl?: string) => string) | undefined;
	/** Resolves a logical engine worker name to a blob/data URL that can be passed to `new Worker`. */
	var __boWorkerUrl: ((logical: 'docx' | 'xlsx' | 'pptx') => string) | undefined;
	/**
	 * Format of this webview, set by the extension host's HTML (`src/providers/officeProvider.ts`)
	 * before the entry bundle runs. Used to skip work that belongs to another format (e.g. the docx
	 * engine worker bundle).
	 */
	var __BO_FORMAT__: string | undefined;
}

/** The wasm/ttf binaries reachable through the manifest are emitted with their native extensions. */
declare module '*.wasm' {
	const url: string;
	export default url;
}
declare module '*.ttf' {
	const url: string;
	export default url;
}

/**
 * Stylesheets: the engine packages ship plain CSS (`@betteroffice/docx-react/styles.css`) which
 * esbuild bundles into `out/media/webview-<format>.css` and the webview <link>s. TypeScript only
 * needs to know the import is side-effect-only.
 */
declare module '*.css' {
	const css: string;
	export default css;
}

/**
 * Upstream engine worker modules are shipped untyped (their `.d.mts` is empty); they are imported
 * for their side effects only. Only docx has an engine worker in the published packages.
 */
declare module '*residentEngineWorker.mjs';

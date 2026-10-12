/**
 * Worker preamble (DESIGN §4.2): self-installing shim that every engine worker bundle imports
 * *before* the upstream worker module (`webview/entries/worker-docx.ts`).
 *
 * Why this exists
 * ---------------
 * The worker runs from a `blob:` URL and, in a VS Code webview, must not fetch/import webview
 * resources from a worker context at all (microsoft/vscode#315494). So:
 *
 *   1. the webview main thread fetched every wasm/ttf byte (`assetBootstrap.ts`) and posted them as
 *      the worker's first message: `{ type: 'bo-assets', assets: Record<name, ArrayBuffer> }`,
 *   2. the build rewrote the engines' `new URL('<file>.wasm', import.meta.url)` lookups into
 *      `__boAssetUrl(name)` calls (scripts/build.mjs, `asset-import-rewrite`); here that global maps
 *      the basename to a `bo-asset://` URL,
 *   3. the patched `fetch` serves those URLs from the message payload — no network, no
 *      service-worker, no import of a webview resource.
 *
 * Ordering is not assumed: `fetch('bo-asset://…')` before the message arrives parks on a pending
 * queue that the message handler drains. Engine client messages (`warm`/`open`) are ignored.
 *
 * Everything is defensive: if the host never posts assets, the fetches stay pending (the engine
 * surfaces its own timeout) and non-`bo-asset://` requests keep using the original fetch.
 */

/** Payload of the host -> worker asset handshake message (§4.2). */
export interface BoAssetsMessage {
	type: 'bo-assets';
	assets: Record<string, ArrayBuffer>;
}

export const BO_ASSET_SCHEME = 'bo-asset://';

/** Basename -> bytes, filled by the first `bo-assets` message. */
const assetBytes = new Map<string, ArrayBuffer>();
/** Resolvers parked while waiting for the message (fetch-before-message ordering). */
let pending: Array<() => void> = [];
let announced = false;

/** Resolves once the asset payload has arrived (immediately when it already has). */
function waitForAssets(): Promise<void> {
	if (announced) return Promise.resolve();
	return new Promise<void>((resolve) => {
		pending.push(resolve);
	});
}

function isBoAssetUrl(url: string): boolean {
	return url.startsWith(BO_ASSET_SCHEME);
}

/** Strips the scheme, any query/hash fragment and percent-encoding to recover the file basename. */
function assetNameFromUrl(url: string): string {
	const withoutScheme = url.slice(BO_ASSET_SCHEME.length).split(/[?#]/, 1)[0] ?? '';
	try {
		return decodeURIComponent(withoutScheme);
	} catch {
		return withoutScheme;
	}
}

/** `Content-Type` the engine's `instantiateStreaming` needs, derived from the suffix. */
function contentTypeFor(name: string): string {
	if (name.endsWith('.wasm')) return 'application/wasm';
	if (name.endsWith('.ttf')) return 'font/ttf';
	if (name.endsWith('.otf')) return 'font/otf';
	if (name.endsWith('.woff2')) return 'font/woff2';
	if (name.endsWith('.woff')) return 'font/woff';
	return 'application/octet-stream';
}

function respond(name: string): Response {
	const bytes = assetBytes.get(name);
	if (!bytes) {
		return new Response(`[betteroffice-viewer] asset "${name}" was not seeded into the engine worker`, {
			status: 404,
			statusText: 'Not Found',
			headers: { 'Content-Type': 'text/plain' },
		});
	}
	// A fresh view per call: the same bytes may back several `Response`s, and some callers consume
	// (or transfer) the underlying buffer.
	return new Response(bytes.slice(0), {
		status: 200,
		headers: { 'Content-Type': contentTypeFor(name), 'Content-Length': String(bytes.byteLength) },
	});
}

/** Reads the URL out of every `fetch` input shape (`string`, `URL`, `Request`). */
function inputUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
	const request = input as Request;
	return typeof request?.url === 'string' ? request.url : String(input);
}

/** Builds the `Response` for a `bo-asset://` URL, parking until the payload arrives if needed. */
function assetResponse(url: string): Promise<Response> {
	const name = assetNameFromUrl(url);
	if (assetBytes.has(name)) return Promise.resolve(respond(name));
	return waitForAssets().then(() => respond(name));
}

function installFetchShim(): void {
	// `self.fetch` is the worker global. Keep the original untouched for pass-through requests.
	const originalFetch = globalThis.fetch?.bind(globalThis);
	if (typeof originalFetch !== 'function') return;

	const originalFetchFn = originalFetch as typeof fetch;
	const shimmed = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let url = '';
		try {
			url = inputUrl(input);
		} catch {
			return originalFetchFn(input as RequestInfo, init);
		}
		if (!isBoAssetUrl(url)) return originalFetchFn(input as RequestInfo, init);
		return assetResponse(url);
	}) as typeof fetch;

	// Keep the properties engines may feature-detect on (e.g. `fetch.length`).
	try {
		Object.defineProperty(shimmed, 'name', { value: 'fetch' });
	} catch {
		/* non-fatal */
	}
	globalThis.fetch = shimmed;
}

function installMessageHandler(): void {
	const onMessage = (event: MessageEvent): void => {
		const data = event.data as BoAssetsMessage | undefined;
		if (!data || data.type !== 'bo-assets' || typeof data.assets !== 'object' || data.assets === null) {
			// Engine client messages (`warm`, `open`, `sync`, …) — always ignored here.
			return;
		}
		for (const [name, value] of Object.entries(data.assets as Record<string, unknown>)) {
			if (value instanceof ArrayBuffer) assetBytes.set(name, value);
			else if (ArrayBuffer.isView(value)) {
				// `postMessage` always delivers ArrayBuffers, but a non-transferred TypedArray view
				// (tests, future hosts) is accepted too.
				const view = value as ArrayBufferView;
				const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
				assetBytes.set(name, slice);
			}
		}
		announced = true;
		const waiting = pending;
		pending = [];
		for (const resolve of waiting) resolve();
	};
	self.addEventListener('message', onMessage);
}

// --- top-level install ---------------------------------------------------------------
// esbuild evaluates this module before the engine worker module bundled after it, so both the
// globals and the fetch shim exist before any rewritten lookup runs.
globalThis.__boAssetUrl = (name: string) => BO_ASSET_SCHEME + name;
globalThis.__boWorkerUrl = (logical: string) => {
	// Workers cannot spawn engine workers (engines have no such path); surface it loudly if it ever
	// happens instead of returning an unusable URL.
	throw new Error(`[betteroffice-viewer] worker context cannot resolve engine worker "${logical}"`);
};

installFetchShim();
installMessageHandler();

/** Current state, exposed for diagnostics/tests. */
export function getSeededAssetNames(): string[] {
	return [...assetBytes.keys()];
}

/** True once the `bo-assets` payload has been received. */
export function hasSeededAssets(): boolean {
	return announced;
}

export { waitForAssets };

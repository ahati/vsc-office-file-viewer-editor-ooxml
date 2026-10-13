/**
 * Webview asset bootstrap (DESIGN §4/§5).
 *
 * Loads `manifest.json` (logical asset name -> emitted file under `out/media/`), installs the
 * `__extAssetUrl(name)` global the build's asset-rewrite plugin emits, and prefetches the WASM
 * modules for the current format family. Font TTFs are NOT prefetched — font loaders
 * (`@betteroffice/fonts`, the `@docx-editor.dev/react` byte-backed `fonts` prop) resolve their asset
 * bytes on demand through `connect-src`, which is scoped to the extension origin.
 *
 * There are no engine workers: xlsx/pptx run in-thread (their dists ship no workers), vsdx runs on
 * the main thread, and docx moved to the `@docx-editor.dev` DOM engine. docx does have one wasm
 * asset — `harfbuzz.wasm`, the same-origin HarfBuzz text shaper — which is prefetched here when
 * present in the manifest like the other engines' wasm; each engine's `initWasm(bytes)` is fed from
 * `getAssetBytes`, so nothing is ever fetched from a worker context (microsoft/vscode#315494 class
 * of failures).
 */
import type { ViewerWebviewConfig } from '../protocol';

export interface AssetManifest {
	assets: Record<string, string>;
	workers?: Record<string, string>;
}

export type BootstrapPhase =
	| 'bootstrap-start'
	| 'manifest'
	| 'assets-fetched'
	| 'bootstrap-done';

interface BootstrapState {
	ready: Promise<void> | undefined;
	manifest: AssetManifest | undefined;
	assetBytes: Map<string, ArrayBuffer>;
	timings: Record<string, number>;
	mediaBase: string;
}

const state: BootstrapState = {
	ready: undefined,
	manifest: undefined,
	assetBytes: new Map<string, ArrayBuffer>(),
	timings: {},
	mediaBase: '',
};

const t0 = { value: now() };

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function recordTiming(phase: string, at: number = now()): void {
	state.timings[phase] = Math.round((at - t0.value) * 10) / 10;
}

export function getTimings(): Record<string, number> {
	return { ...state.timings };
}

export function getMediaBase(): string {
	return state.mediaBase;
}

/** Logical asset name -> absolute URL inside the webview (font/wasm lookups rewritten by the build). */
export function getAssetUrl(name: string, fallbackUrl?: string): string {
	const rel = state.manifest?.assets[name];
	if (rel) return state.mediaBase + rel;
	if (fallbackUrl) return fallbackUrl;
	console.warn(`[office-file-viewer] asset "${name}" missing from manifest`);
	return `ext-missing-asset://${name}`;
}

/** Cached wasm bytes (bootstrap prefetch); `undefined` when not prefetched — callers fetch then. */
export function getAssetBytes(name: string): ArrayBuffer | undefined {
	return state.assetBytes.get(name);
}

function resolveMediaBase(explicit?: string): string {
	if (explicit) return explicit.endsWith('/') ? explicit : explicit + '/';
	// Fallback for direct-mount dev flows: the entry runtime always passes mediaBase via `init`.
	const base = new URL('.', document.baseURI).toString();
	return base;
}

async function loadManifest(mediaBase: string): Promise<AssetManifest> {
	const response = await fetch(`${mediaBase}manifest.json`, { cache: 'no-store' });
	if (!response.ok) throw new Error(`asset manifest fetch failed: HTTP ${response.status} ${response.statusText}`);
	const manifest = (await response.json()) as AssetManifest;
	if (!manifest || typeof manifest !== 'object' || !manifest.assets || typeof manifest.assets !== 'object') {
		throw new Error('asset manifest is malformed: expected { assets: Record<string, string> }');
	}
	return manifest;
}

/** Prefetches wasm assets only; fonts resolve on demand through the asset bootstrap. */
async function fetchWasmAssets(manifest: AssetManifest, mediaBase: string): Promise<void> {
	const wasmEntries = Object.entries(manifest.assets).filter(([name]) => name.endsWith('.wasm'));
	await Promise.all(
		wasmEntries.map(async ([name, rel]) => {
			const response = await fetch(mediaBase + rel);
			if (!response.ok) throw new Error(`asset "${name}" fetch failed: HTTP ${response.status}`);
			state.assetBytes.set(name, await response.arrayBuffer());
		}),
	);
}

/**
 * Loads the manifest, installs the asset resolvers and prefetches wasm bytes.
 * Idempotent; failures reset the state so the entry can retry once (DESIGN §4.3).
 */
export async function bootstrap(
	_config: ViewerWebviewConfig,
	mediaBase?: string,
	/** Legacy hook from the worker era; wasm-only prefetch makes format-specific tuning moot. */
	_options?: { format?: string },
): Promise<void> {
	if (state.ready) return state.ready;

	state.mediaBase = resolveMediaBase(mediaBase);
	recordTiming('bootstrap-start');

	state.ready = (async () => {
		state.manifest = await loadManifest(state.mediaBase);
		recordTiming('manifest');
		if (!globalThis.__extAssetUrl) {
			globalThis.__extAssetUrl = (name: string) => getAssetUrl(name);
		}
		await fetchWasmAssets(state.manifest, state.mediaBase);
		recordTiming('assets-fetched');
		recordTiming('bootstrap-done');
	})();

	try {
		await state.ready;
	} catch (error) {
		// Allow a retry (a fresh asset fetch is exactly what a transient webview failure needs,
		// DESIGN §4.3); the entry reports the phase+message through the error panel.
		state.ready = undefined;
		throw error;
	}
}

/** Test/debug hook: forgets every fetched byte (not used by the view entries). */
export function resetBootstrapForTests(): void {
	state.ready = undefined;
	state.manifest = undefined;
	state.assetBytes.clear();
	state.timings = {};
	t0.value = now();
	state.mediaBase = '';
}

export const EXT_ASSET_SCHEME = 'ext-asset://';

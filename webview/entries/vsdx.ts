/**
 * Webview entry — Visio drawings (.vsdx / .vsdm not supported), M1 read-only viewer.
 *
 * Handshake (webview/protocol.ts): post `ready` -> host posts
 * `init { format, bytes, config, fileName, mediaBase }` -> load the engine and paint.
 *
 * vsdx runs on the webview main thread (no engine worker, DESIGN §4.2):
 *
 *   bootstrap(config, mediaBase)   manifest-driven asset resolution (`__boAssetUrl`, fonts)
 *   wasm bytes (bootstrap cache) -> initWasm(wasmBytes)
 *   loadVsdxFonts(config)          four Arial style variants (SCOPING §6)
 *   openDiagram(fileBytes, {fonts}) -> mountVsdxShell(...).renderInitial()
 *
 * Every step reports failures as `load-error { phase, message }` with
 * `phase ∈ 'init' | 'wasm' | 'open' | 'render'` and also renders a fatal panel, which keeps the
 * viewer usable before `npm run build:vsdx-wasm` has produced the real wasm-bindgen glue (the
 * build's stub throws from `initWasm`).
 *
 * `window.__vsdxShell = { getHandle, dispose }` is left as the later export-command hook
 * (exportPng/exportSvg/exportPdf take the DiagramHandle from there); no commands are wired here.
 */
import * as assetBootstrapModule from '../bootstrap/assetBootstrap';
import type { HostToWebview, ViewerWebviewConfig, WebviewToHost } from '../protocol';
import { showFatalError } from '../vsdx/errorPanel';
import { loadVsdxFonts } from '../vsdx/fonts';
import { mountVsdxShell, type VsdxErrorPhase, type VsdxShell, type VsdxShellState } from '../vsdx/shell';
import { roundMs } from '../vsdx/util';
import { getVsCodeApi, type VsCodeApi } from '../vscodeApi';
import { initWasm, openDiagram, type DiagramHandle } from '../../vendor/betteroffice/vsdx/src/index';

const FORMAT = 'vsdx' as const;
/** Manifest key of the compiled vsdx wasm module (scripts/build.mjs emits assets as `assets/<name>`). */
const WASM_ASSET_NAME = 'vsdx_wasm_bg.wasm';
/** Any URL scheme that is not fetchable (`bo-asset://`, `bo-missing-asset://`, ...). */
const NON_FETCHABLE_URL = /^(?!https?:|blob:|data:)[a-z][a-z0-9+.-]*:/i;
const STATE_DEBOUNCE_MS = 250;

type InitMessage = Extract<HostToWebview, { type: 'init' }>;
type IncomingMessage = HostToWebview | { type: 'hidden' };

interface AssetBootstrapModule {
	/** Documented signature (webview/bootstrap/assetBootstrap.ts). */
	bootstrap(config: ViewerWebviewConfig, mediaBase: string): Promise<void>;
	/** Manifest lookup by original asset basename. */
	getAssetUrl?(name: string, fallbackUrl?: string): string;
	/** Bytes already fetched by the bootstrap (avoids a second fetch of the same file). */
	getAssetBytes?(name: string): ArrayBuffer | undefined;
}

interface ShellHandle {
	getHandle(): DiagramHandle | undefined;
	dispose(): void;
}

interface VsdxWindow {
	__vsdxShell?: ShellHandle;
}

const bootstrapModule = assetBootstrapModule as unknown as AssetBootstrapModule;
const vsdxWindow = window as unknown as VsdxWindow;

let vscodeApi: VsCodeApi | undefined;
let disposed = false;
let loadToken = 0;
let lastInit: Pick<InitMessage, 'config' | 'fileName' | 'mediaBase'> | undefined;
let session: { handle: DiagramHandle; shell: VsdxShell } | undefined;
let pendingState: VsdxShellState | undefined;
let stateTimeout = 0;

function post(message: WebviewToHost): void {
	vscodeApi?.postMessage(message);
}

/** Reports a phase failure to the host and swaps the viewer root for the fatal panel. */
function reportError(phase: VsdxErrorPhase, error: unknown): void {
	const message = error instanceof Error ? error.message || error.name : String(error);
	console.error(`[betteroffice-viewer] vsdx ${phase} failed`, error);
	const root = document.getElementById('viewer-root');
	if (root) showFatalError(root, phase, message);
	post({ type: 'load-error', phase, message });
}

function scheduleState(state: VsdxShellState): void {
	pendingState = state;
	if (stateTimeout !== 0) return;
	stateTimeout = window.setTimeout(() => {
		stateTimeout = 0;
		if (disposed || !pendingState) return;
		post({ type: 'state', state: { ...pendingState } });
		pendingState = undefined;
	}, STATE_DEBOUNCE_MS);
}

function closeSession(): void {
	const active = session;
	session = undefined;
	if (!active) return;
	try {
		active.shell.dispose();
	} catch (error) {
		console.warn('[betteroffice-viewer] vsdx shell dispose failed', error);
	}
	try {
		active.handle.dispose();
	} catch (error) {
		console.warn('[betteroffice-viewer] vsdx handle dispose failed', error);
	}
}

function disposeViewer(): void {
	if (disposed) return;
	disposed = true;
	if (stateTimeout !== 0) {
		window.clearTimeout(stateTimeout);
		stateTimeout = 0;
	}
	closeSession();
	vsdxWindow.__vsdxShell = undefined;
}

/** Resolves the wasm module URL: bootstrap helper first, the build-injected global as fallback. */
function resolveWasmUrl(): string | undefined {
	const fromBootstrap = bootstrapModule.getAssetUrl?.(WASM_ASSET_NAME);
	if (typeof fromBootstrap === 'string' && fromBootstrap.length > 0) return fromBootstrap;
	const fromGlobal = globalThis.__boAssetUrl?.(WASM_ASSET_NAME);
	return typeof fromGlobal === 'string' && fromGlobal.length > 0 ? fromGlobal : undefined;
}

async function fetchAssetBytes(url: string): Promise<Uint8Array> {
	if (NON_FETCHABLE_URL.test(url)) {
		throw new Error(
			`the ${WASM_ASSET_NAME} asset is not resolvable yet (${url}); ` +
				'run `npm run build:vsdx-wasm` to produce the wasm glue and rebuild the extension',
		);
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/** Bootstrap-cached bytes when available, otherwise a fetch of the manifest URL. */
async function resolveWasmBytes(): Promise<Uint8Array> {
	const cached = bootstrapModule.getAssetBytes?.(WASM_ASSET_NAME);
	if (cached && cached.byteLength > 0) return new Uint8Array(cached);
	const url = resolveWasmUrl();
	if (!url) throw new Error(`the asset manifest has no entry for ${WASM_ASSET_NAME}`);
	return fetchAssetBytes(url);
}

async function load(init: InitMessage, options: { bootstrap: boolean }): Promise<void> {
	const token = ++loadToken;
	const started = performance.now();
	const timings: Record<string, number> = {};
	const fileBytes = new Uint8Array(init.bytes);
	lastInit = { config: init.config, fileName: init.fileName, mediaBase: init.mediaBase };
	closeSession();

	// phase 'init' — asset manifest/resolution (no-op steps are still timed and reported).
	if (options.bootstrap) {
		const mark = performance.now();
		try {
			await bootstrapModule.bootstrap(init.config, init.mediaBase);
		} catch (error) {
			if (token === loadToken && !disposed) reportError('init', error);
			return;
		}
		timings.bootstrapMs = roundMs(performance.now() - mark);
		if (token !== loadToken || disposed) return;
	}

	// phase 'wasm' — compile/instantiate the engine before any document work.
	const wasmMark = performance.now();
	try {
		await initWasm(await resolveWasmBytes());
	} catch (error) {
		if (token === loadToken && !disposed) reportError('wasm', error);
		return;
	}
	timings.wasmMs = roundMs(performance.now() - wasmMark);
	if (token !== loadToken || disposed) return;

	// phase 'open' — fonts are fixed at open time, then the package is parsed into a handle.
	let handle: DiagramHandle;
	try {
		const fontsMark = performance.now();
		const { fonts, warnings } = await loadVsdxFonts(init.config);
		timings.fontsMs = roundMs(performance.now() - fontsMark);
		for (const warning of warnings) console.warn(`[betteroffice-viewer] vsdx fonts: ${warning}`);
		if (token !== loadToken || disposed) return;
		const openMark = performance.now();
		handle = openDiagram(fileBytes, { fonts });
		timings.openMs = roundMs(performance.now() - openMark);
	} catch (error) {
		if (token === loadToken && !disposed) reportError('open', error);
		return;
	}
	if (token !== loadToken || disposed) {
		handle.dispose();
		return;
	}

	// phase 'render' — shell mount + first frame.
	const root = document.getElementById('viewer-root');
	if (!root) {
		handle.dispose();
		reportError('render', new Error('#viewer-root is missing from the webview document'));
		return;
	}
	const renderMark = performance.now();
	try {
		const shell = mountVsdxShell(root, {
			handle,
			config: init.config,
			fileName: init.fileName,
			onError: (message) => post({ type: 'load-error', phase: 'render', message }),
			onState: scheduleState,
		});
		await shell.renderInitial();
		timings.firstFrameMs = roundMs(performance.now() - renderMark);
		timings.totalMs = roundMs(performance.now() - started);
		if (disposed || token !== loadToken) {
			shell.dispose();
			handle.dispose();
			return;
		}
		session = { handle, shell };
		vsdxWindow.__vsdxShell = { getHandle: () => session?.handle, dispose: disposeViewer };
		post({ type: 'loaded', fileName: init.fileName, timings });
	} catch (error) {
		try {
			handle.dispose();
		} catch (disposeError) {
			console.warn('[betteroffice-viewer] vsdx handle dispose failed', disposeError);
		}
		reportError('render', error);
	}
}

function onMessage(event: MessageEvent<IncomingMessage>): void {
	const message = event.data;
	if (!message || typeof message !== 'object') return;
	switch (message.type) {
		case 'init':
			if (message.format !== FORMAT) return;
			void load(message, { bootstrap: true });
			return;
		case 'fileChanged': {
			const previous = lastInit;
			if (!previous) return;
			void load(
				{ type: 'init', format: FORMAT, bytes: message.bytes, config: previous.config, fileName: previous.fileName, mediaBase: previous.mediaBase },
				{ bootstrap: false },
			);
			return;
		}
		case 'hidden':
			disposeViewer();
			return;
		default:
			return;
	}
}

function main(): void {
	vscodeApi = getVsCodeApi<Record<string, unknown>>();
	post({ type: 'ready' });
	window.addEventListener('message', onMessage);
	// Best-effort teardown when VS Code hides/destroys the panel (no retainContextWhenHidden).
	window.addEventListener('pagehide', disposeViewer);
	window.addEventListener('beforeunload', disposeViewer);
}

try {
	main();
} catch (error) {
	console.error('[betteroffice-viewer] vsdx entry failed to start', error);
}

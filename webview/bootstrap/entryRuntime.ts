/**
 * Shared entry-runtime for the `docx` / `xlsx` / `pptx` webview entries.
 *
 * Owns everything every format needs before/around its mount (DESIGN §3.3, §9):
 *   ready -> init -> bootstrap -> dynamic-import mount -> loaded { timings }
 * plus the cross-format chrome the hosts relies on:
 *   - structured `load-error` reporting through the error panel,
 *   - external-link interception for `<a href="http|https|mailto|tel">`,
 *   - the debounced `state { zoom, page }` message.
 *
 * Mounts are dynamically imported (`await import('../mounts/docx')`) so nothing from
 * engines are evaluated before `bootstrap()` installed `__extAssetUrl`.
 */
import { bootstrap, getTimings, recordTiming } from '../bootstrap/assetBootstrap';
import { clearErrorPanel, renderErrorPanel, setStatus } from '../chrome/errorPanel';
import type { HostToWebview, ViewerFormat, ViewerWebviewConfig, WebviewToHost } from '../protocol';
import { getVsCodeApi, type VsCodeApi } from '../vscodeApi';

/** The `init` payload, with the host fields the mounts use. */
export interface ViewerInit {
	format: ViewerFormat;
	bytes: ArrayBuffer;
	config: ViewerWebviewConfig;
	fileName: string;
	mediaBase: string;
}

/** Small surface mounts use to talk back to the host. */
export interface ViewerContext {
	format: ViewerFormat;
	fileName: string;
	config: ViewerWebviewConfig;
	/** Reports a render/runtime failure: posts `load-error` and shows the error panel. */
	fail(phase: string, error: unknown): void;
	/** Delivers a lossless engine save (`onSave` chrome callback) to the host, which writes the file. */
	saveBytes(bytes: ArrayBuffer | Uint8Array): void;
	/** Debounced (500 ms) `state { zoom, page }` message (DESIGN §9). */
	reportState(state: { zoom?: number; page?: number; pageCount?: number }): void;
	/** Restores the previous zoom from the webview state, if the host preserved it. */
	getInitialZoom(defaultZoom: number): number;
	/** True when the webview state carried a zoom (used to prefer it over `config.initialZoom`). */
	hasSavedZoom(): boolean;
	/** Restores the previous 1-based page/slide from the webview state (`getState`/`setState`). */
	getSavedPage(defaultPage: number): number;
}

interface EntryOptions {
	format: ViewerFormat;
	/**
	 * Mounts (or re-renders) the editor for an `init` payload. Called again when the host re-sends
	 * `init` (reload / external file change), so implementations must be idempotent.
	 */
	mount(init: ViewerInit, context: ViewerContext): Promise<void>;
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const STATE_DEBOUNCE_MS = 500;

/** Boots one webview entry: wires the protocol, then delegates to the format mount. */
export function runViewerEntry(options: EntryOptions): void {
	const { format } = options;
	let vscode: VsCodeApi;
	try {
		vscode = getVsCodeApi();
	} catch (error) {
		// Loaded outside a webview (e.g. a stray browser tab): nothing can be reported, bail loudly.
		renderErrorPanel('runtime', error instanceof Error ? error.message : String(error));
		return;
	}

	const post = (message: WebviewToHost): void => {
		try {
			vscode.postMessage(message);
		} catch (error) {
			console.warn('[office-file-viewer] postMessage failed', error);
		}
	};

	installLinkInterception(post);

	let stateTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingState: { zoom?: number; page?: number; pageCount?: number } = {};
	const fail = (phase: string, error: unknown): void => {
		const stack = error instanceof Error ? error.stack : undefined;
		const message = error instanceof Error
			? error.message
			: typeof error === 'object' && error !== null
				? JSON.stringify(error, Object.getOwnPropertyNames(error))
				: String(error);
		console.error(`[office-file-viewer] ${format} ${phase} failed`, error);
		renderErrorPanel(phase, message);
		post({ type: 'load-error', phase, message: stack ? `${message}\n${stack}` : message });
	};

	// Engine/runtime errors that escape a mount (xlsx has no `onError` prop at all) also land in the
	// error panel once the entry is live.
	window.addEventListener('error', (event) => {
		if (event.error) fail('runtime', event.error instanceof Error ? { message: event.error.message, stack: event.error.stack } : event.error);
	});
	window.addEventListener('unhandledrejection', (event) => {
		fail('runtime', (event as PromiseRejectionEvent).reason instanceof Error ? { message: (event as PromiseRejectionEvent).reason.message, stack: (event as PromiseRejectionEvent).reason.stack } : (event as PromiseRejectionEvent).reason);
	});

	const savedState = vscode.getState() as { zoom?: number; page?: number } | undefined;
	const hasSavedZoom = (): boolean => typeof savedState?.zoom === 'number';

	const context: ViewerContext = {
		format,
		fileName: '',
		config: undefined as unknown as ViewerWebviewConfig,
		fail,
		saveBytes(bytes) {
			// Normalize to a plain ArrayBuffer for the structured clone (docx hands us an ArrayBuffer,
			// xlsx/pptx hand us Uint8Array views into larger buffers).
			const ab = bytes instanceof Uint8Array
				? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
				: bytes;
			post({ type: 'saved', bytes: ab as ArrayBuffer });
		},
		reportState(state) {
			Object.assign(pendingState, state);
			if (stateTimer !== undefined) clearTimeout(stateTimer);
			stateTimer = setTimeout(() => {
				const snapshot = { ...pendingState };
				post({ type: 'state', state: snapshot });
				// Survive hide/restore: the panel is torn down without `retainContextWhenHidden`
				// (DESIGN §11), so the webview state is the only continuity channel.
				try {
					vscode.setState(snapshot);
				} catch (error) {
					console.warn('[office-file-viewer] setState failed', error);
				}
			}, STATE_DEBOUNCE_MS);
		},
		hasSavedZoom,
		getInitialZoom(defaultZoom) {
			return hasSavedZoom() ? savedState!.zoom! : defaultZoom;
		},
		getSavedPage(defaultPage) {
			return typeof savedState?.page === 'number' && savedState.page > 0 ? savedState.page : defaultPage;
		},
	};

	let started = false;
	const onInit = (init: ViewerInit): void => {
		if (init.format !== format) return;
		context.fileName = init.fileName;
		context.config = init.config;
		if (!started) recordTiming('init-received');
		const phase = started ? 'reload' : 'bootstrap';
		started = true;

		setStatus('busy');
		clearErrorPanel();

		void (async () => {
			await bootstrap(init.config, init.mediaBase, { format });
			await options.mount(init, context);
			recordTiming('mounted');
			setStatus('idle');
			post({ type: 'loaded', fileName: init.fileName, timings: timingSnapshot() });
		})().catch((error: unknown) => {
			fail(phase, error);
		});
	};

	window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
		const message = event.data;
		if (!message) return;
		if (message.type === 'init') onInit(message as ViewerInit);
		// `fileChanged` is intentionally not handled in M1: the provider re-sends `init` on change.
	});

	post({ type: 'ready' });
}

/** The timings record for the `loaded` message: bootstrap phases first, mount phases last. */
function timingSnapshot(): Record<string, number> {
	return getTimings();
}

/**
 * `<a href>` interception: VS Code webviews must not navigate, so every allowlisted external link
 * is posted to the host (`env.openExternal`). `preventDefault` also covers engine-rendered anchors
 * (docx hyperlinks, xlsx hyperlink cells, pptx runs with hyperlink fields).
 */
function installLinkInterception(post: (message: WebviewToHost) => void): void {
	document.addEventListener(
		'click',
		(event) => {
			const target = event.target as Element | null;
			const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
			if (!anchor) return;
			const href = anchor.getAttribute('href') ?? '';
			if (href.length === 0 || href.startsWith('#')) return;
			let scheme: string;
			try {
				scheme = new URL(href, document.baseURI).protocol.replace(/:$/, '').toLowerCase();
			} catch {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (ALLOWED_LINK_SCHEMES.has(scheme)) post({ type: 'link', url: href });
		},
		true,
	);
}

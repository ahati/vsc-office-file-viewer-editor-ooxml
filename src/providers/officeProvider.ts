import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { getViewerWebviewConfig } from '../config';
import { getNonce } from '../util';

/**
 * Formats this extension contributes a custom editor for. `docx` also claims `.docm`, `xlsx` claims
 * `.xlsm`, `pptx` claims `.pptm` (see `contributes.customEditors` in package.json).
 */
export type ViewerFormat = 'docx' | 'xlsx' | 'pptx' | 'vsdx';

/** Read-only document model: the file's raw bytes plus its format. */
export class OfficeDocument implements vscode.CustomDocument {
	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	constructor(
		readonly uri: vscode.Uri,
		readonly format: ViewerFormat,
		/** Full file content; handed to the webview as an `ArrayBuffer` (transferred/structured clone). */
		public data: Uint8Array,
	) {}

	/** Timestamp until which `fileChanged` events are our own save echo (see `resolveCustomEditor`). */
	suppressReloadUntil = 0;

	dispose(): void {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}
}

/**
 * Shared read-only custom editor provider for all four formats.
 *
 * M1 behaviour (DESIGN §3.1/§3.3/§3.5):
 *   - reads bytes through `vscode.workspace.fs` only (Remote/WSL/Codespaces safe),
 *   - builds a CSP-locked webview that loads `out/media/webview-<format>.js`,
 *   - webview `ready` -> host `init {format, bytes, config, fileName, mediaBase}`,
 *   - `FileSystemWatcher` on the file pushes `fileChanged {bytes}`,
 *   - message trace + engine errors land in the "Office File Viewer" output channel and a 200-line
 *     in-memory ring exposed by `officeFileViewer.getDiagnostics`.
 *
 * M2 replaces this class with a `CustomEditorProvider` carrying the save/backup/undo lifecycle
 * (DESIGN §3.4); keep the HTML/CSP and message plumbing here as the single place that owns them.
 */
export class OfficeProvider implements vscode.CustomReadonlyEditorProvider<OfficeDocument> {
	public static readonly VIEW_TYPE_PREFIX = 'officeFileViewer';
	public static readonly OUTPUT_CHANNEL_NAME = 'Office File Viewer';

	/** Webview entry bundles are emitted as `out/media/webview-<format>.js` (scripts/build.mjs). */
	private static readonly MEDIA_DIR = ['out', 'media'] as const;
	private static readonly ASSET_MANIFEST = 'manifest.json';

	/** All formats this provider factory knows how to register. */
	public static readonly FORMATS: readonly ViewerFormat[] = ['docx', 'xlsx', 'pptx', 'vsdx'];

	private static readonly output = vscode.window.createOutputChannel(OfficeProvider.OUTPUT_CHANNEL_NAME);
	private static readonly ring: string[] = [];
	private static readonly RING_LIMIT = 200;

	/** Live panels, keyed by document URI, so `officeFileViewer.reload` can re-init them. */
	private static readonly liveViewers = new Map<string, { reload(): void }>();

	public static register(context: vscode.ExtensionContext, format: ViewerFormat): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			`${OfficeProvider.VIEW_TYPE_PREFIX}.${format}`,
			new OfficeProvider(context, format),
			// One engine instance per document: memory bound (SCOPING R7, DESIGN §3.1).
			{ supportsMultipleEditorsPerDocument: false },
		);
	}

	/** Logs a line to the output channel, the ring buffer and the extension host console. */
	public static log(message: string): void {
		const line = `[${new Date().toISOString()}] ${message}`;
		OfficeProvider.output.appendLine(line);
		OfficeProvider.ring.push(line);
		if (OfficeProvider.ring.length > OfficeProvider.RING_LIMIT) OfficeProvider.ring.shift();
		console.log(`[office-file-viewer] ${message}`);
	}

	/** Most recent lifecycle events (oldest first); used by the diagnostics commands and tests. */
	public static getDiagnostics(): readonly string[] {
		return [...OfficeProvider.ring];
	}

	/** The shared "Office File Viewer" output channel (shown by the diagnostics command). */
	public static getOutputChannel(): vscode.OutputChannel {
		return OfficeProvider.output;
	}

	/** Re-inits every open viewer (fresh bytes + settings); used by the reload command. */
	public static reloadActiveViewers(): number {
		for (const viewer of OfficeProvider.liveViewers.values()) viewer.reload();
		return OfficeProvider.liveViewers.size;
	}

	public static hasActiveViewers(): boolean {
		return OfficeProvider.liveViewers.size > 0;
	}

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly format: ViewerFormat,
	) {}

	async openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): Promise<OfficeDocument> {
		const data = await Promise.resolve(vscode.workspace.fs.readFile(uri)).catch((error: unknown) => {
			// Surface a message that names the file inside VS Code's editor error dialog.
			throw new Error(`Office File Viewer could not read ${uri.fsPath}: ${String(error)}`);
		});
		return new OfficeDocument(uri, this.format, data);
	}

	async resolveCustomEditor(
		document: OfficeDocument,
		panel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		OfficeProvider.log(`resolve ${document.format}: ${document.uri.toString()}`);
		panel.webview.options = {
			enableScripts: true,
			// Everything the webview may load lives inside the extension (out/media/**).
			localResourceRoots: [this.context.extensionUri],
		};

		const mediaBase = this.getMediaBase(panel.webview);
		panel.webview.html = this.getHtmlForWebview(panel.webview, document.format, mediaBase);

		const sendInit = async (): Promise<void> => {
			try {
				document.data = await vscode.workspace.fs.readFile(document.uri);
			} catch (error) {
				OfficeProvider.log(`read failed for ${document.uri.toString()}: ${String(error)}`);
			}
			await panel.webview.postMessage({
				type: 'init',
				format: document.format,
				bytes: toArrayBuffer(document.data),
				config: getViewerWebviewConfig(),
				fileName: vscode.workspace.asRelativePath(document.uri, false),
				mediaBase,
			});
		};

		const messageSubscription = panel.webview.onDidReceiveMessage((message: unknown) => {
			const msg = message as { type?: string; [key: string]: unknown } | undefined;
			switch (msg?.type) {
				case 'ready':
					void sendInit();
					return;
				case 'loaded':
					OfficeProvider.log(
						`rendered ${String(msg.fileName ?? document.uri.toString())} timings=${JSON.stringify(msg.timings ?? {})}`,
					);
					return;
				case 'load-error':
					OfficeProvider.log(
						`render FAILED for ${document.uri.toString()} ` +
							`phase=${String(msg.phase ?? 'unknown')} error=${String(msg.message ?? 'unknown')}`,
					);
					return;
				case 'link':
					void openExternalLink(msg.url);
					return;
				case 'saved': {
					// Lossless engine save from the editor chrome (Ctrl/Cmd+S): write through
					// `workspace.fs`, then swallow the watcher echo of our own write.
					const raw = msg.bytes as ArrayBuffer | Uint8Array | undefined;
					if (!(raw instanceof ArrayBuffer) && !(raw instanceof Uint8Array)) return;
					const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
					document.data = bytes;
					document.suppressReloadUntil = Date.now() + 2_000;
					void Promise.resolve(vscode.workspace.fs.writeFile(document.uri, bytes))
						.then(() => OfficeProvider.log(`saved ${document.uri.toString()} (${bytes.byteLength} bytes)`))
						.catch((error: unknown) => {
							document.suppressReloadUntil = 0;
							OfficeProvider.log(`save FAILED for ${document.uri.toString()}: ${String(error)}`);
							void vscode.window.showErrorMessage(
								`Office File Viewer: could not save ${document.uri.fsPath}: ${String(error)}`,
							);
						});
					return;
				}
				case 'state':
					// Viewer state (scroll/zoom/page) is not persisted yet; M1 only traces it.
					OfficeProvider.log(`state ${document.uri.toString()}: ${JSON.stringify(msg.state ?? {})}`);
					return;
				default:
					OfficeProvider.log(`unhandled message from webview: ${String(msg?.type)}`);
			}
		});

		// Refresh on external change: re-read and push `fileChanged` (M2 turns this into the
		// dirty-document conflict prompt, DESIGN §3.3).
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), '*'),
		);
		const reload = (): void => {
			void sendInit();
		};
		const changeSubscription = watcher.onDidChange((changed) => {
			if (changed.toString() !== document.uri.toString()) return;
			if (Date.now() < document.suppressReloadUntil) {
				OfficeProvider.log(`ignored own save echo: ${document.uri.toString()}`);
				return;
			}
			OfficeProvider.log(`file changed on disk: ${document.uri.toString()}`);
			void sendInit();
		});

		const viewerKey = document.uri.toString();
		OfficeProvider.liveViewers.set(viewerKey, { reload });

		// Panels are created without `retainContextWhenHidden` (DESIGN §11), so a hidden panel can
		// release its engine state. The vsdx shell listens for this message and disposes its session;
		// the other entries ignore unknown messages. One-way and cheap: fire only on hide.
		const viewStateSubscription = panel.onDidChangeViewState((event) => {
			if (event.webviewPanel.visible) return;
			OfficeProvider.log(`hidden ${document.format}: ${document.uri.toString()}`);
			void panel.webview.postMessage({ type: 'hidden' });
		});

		panel.onDidDispose(() => {
			messageSubscription.dispose();
			changeSubscription.dispose();
			viewStateSubscription.dispose();
			watcher.dispose();
			OfficeProvider.liveViewers.delete(viewerKey);
			OfficeProvider.log(`disposed ${document.format}: ${document.uri.toString()}`);
		});
	}

	async backupCustomDocument(
		document: OfficeDocument,
		_context: vscode.CustomDocumentBackupContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		// Read-only in M1: nothing to restore on hot exit (M2 wires engine snapshots here).
		return {
			id: document.uri.toString(),
			delete(): void {
				/* nothing to clean up */
			},
		};
	}

	/** Webview URI of `out/media/` (trailing slash) — the `<base href>` and asset manifest root. */
	private getMediaBase(webview: vscode.Webview): string {
		const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...OfficeProvider.MEDIA_DIR));
		return mediaUri.toString().replace(/\/?$/, '/');
	}

	private getHtmlForWebview(webview: vscode.Webview, format: ViewerFormat, mediaBase: string): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, ...OfficeProvider.MEDIA_DIR, `webview-${format}.js`),
		);
		// Formats whose bundle imports a stylesheet get one emitted next to it by esbuild (currently
		// only docx: `@betteroffice/docx-react/styles.css` -> `out/media/webview-docx.css`). Probe the
		// file on disk so a format without CSS never emits a dangling <link> (and a stale asset cannot
		// break loading).
		const cssFile = vscode.Uri.joinPath(
			this.context.extensionUri,
			...OfficeProvider.MEDIA_DIR,
			`webview-${format}.css`,
		);
		const cssHref = fs.existsSync(cssFile.fsPath) ? webview.asWebviewUri(cssFile).toString() : undefined;
		const stylesheetTag = cssHref ? `\n\t<link rel="stylesheet" href="${cssHref}" />` : '';
		const nonce = getNonce();
		const { cjkFonts } = getViewerWebviewConfig();
		const csp = buildContentSecurityPolicy(webview.cspSource, nonce, cjkFonts === 'cdn');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<base href="${mediaBase}" />${stylesheetTag}
	<title>Office File Viewer</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		html, body {
			width: 100%; height: 100%; overflow: hidden;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family, sans-serif);
		}
		#viewer-root { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
		#status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
		#status[data-state="idle"] { display: none; }
		#status[data-state="error"] { color: var(--vscode-errorForeground, #f44747); white-space: pre-wrap; padding: 16px; text-align: center; }
		.spinner {
			width: 28px; height: 28px; border-radius: 50%;
			border: 3px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
			border-top-color: var(--vscode-progressBar-background, var(--vscode-foreground));
			animation: spin 0.9s linear infinite;
		}
		@keyframes spin { to { transform: rotate(360deg); } }
	</style>
</head>
<body>
	<div id="viewer-root" data-format="${format}">
		<div id="status" data-state="busy"><div class="spinner"></div></div>
	</div>
	<script nonce="${nonce}">window.__BO_FORMAT__ = ${JSON.stringify(format)};</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	/** Exposed for tests: the webview asset manifest path inside the extension. */
	public static getAssetManifestPath(): string {
		return [...OfficeProvider.MEDIA_DIR, OfficeProvider.ASSET_MANIFEST].join('/');
	}
}

/** Opens an external hyperlink from a document; only safe schemes are honored. */
async function openExternalLink(rawUrl: unknown): Promise<void> {
	if (typeof rawUrl !== 'string') return;
	let uri: vscode.Uri;
	try {
		uri = vscode.Uri.parse(rawUrl);
	} catch {
		return;
	}
	const allowed = new Set(['http', 'https', 'mailto', 'tel']);
	if (!allowed.has(uri.scheme.toLowerCase())) return;
	await vscode.env.openExternal(uri);
}

/** Cuts an exact `ArrayBuffer` view out of a `Uint8Array` (structured clone copies it). */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Pinned CDN origin for opt-in CJK font faces (`officeFileViewer.cjkFonts: "cdn"`). */
const CJK_FONT_ORIGIN = 'https://cdn.jsdelivr.net';

/**
 * Webview Content-Security-Policy (DESIGN §6).
 *
 * Offline by default: the only allowed origin is the extension's own `cspSource`. When the user opts
 * into the CJK font CDN, exactly that origin is added to `font-src`, `connect-src` and `script-src`.
 * `style-src` must list `cspSource` as well as `'unsafe-inline'`: the external `webview-<format>.css`
 * link (and inline styles) are both needed, and 'unsafe-inline' alone does not permit loading a
 * stylesheet URL. `worker-src data: blob:` must stay explicit: an unset `worker-src` falls back to
 * the nonce-only `script-src` list and blocks the blob: workers the engines use
 * (microsoft/vscode#331633).
 */
export function buildContentSecurityPolicy(cspSource: string, nonce: string, cjkCdn: boolean): string {
	const extra = cjkCdn ? ` ${CJK_FONT_ORIGIN}` : '';
	return [
		`default-src 'none';`,
		`base-uri ${cspSource};`,
		`img-src ${cspSource} data: blob:;`,
		`media-src ${cspSource} blob:;`,
		`font-src ${cspSource}${extra};`,
		`script-src 'nonce-${nonce}' 'wasm-unsafe-eval'${extra};`,
		`worker-src data: blob:;`,
		`style-src ${cspSource} 'unsafe-inline'${extra};`,
		`connect-src ${cspSource} data: blob:${extra};`,
	].join(' ');
}

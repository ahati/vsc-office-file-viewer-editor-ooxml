/**
 * Message protocol shared between the extension host and the webview.
 *
 * Canonical definition. `src/protocol.ts` is a hand-maintained mirrored copy for the host tsconfig
 * (see DESIGN §2/§9) — keep both files in sync when the protocol changes.
 *
 * This module must never import `vscode` or any Node API: it is bundled into the webview.
 */

export type ViewerFormat = 'docx' | 'xlsx' | 'pptx' | 'vsdx';

/** Settings snapshot the host hands to the webview on `init`. */
export interface ViewerWebviewConfig {
	editing: boolean;
	forceReadOnly: boolean;
	fonts: 'bundled' | 'off';
	cjkFonts: 'off' | 'cdn';
	initialZoom: 'fitPage' | 'fitWidth' | '100';
}

export type HostToWebview =
	| {
			type: 'init';
			format: ViewerFormat;
			/** Raw OOXML package bytes, transferred to the webview. */
			bytes: ArrayBuffer;
			config: ViewerWebviewConfig;
			fileName: string;
			/** Webview URI of `out/media/`, with a trailing slash (asset manifest base). */
			mediaBase: string;
	  }
	| { type: 'fileChanged'; bytes: ArrayBuffer };

export type WebviewToHost =
	| { type: 'ready' }
	| { type: 'loaded'; fileName: string; timings: Record<string, number> }
	| { type: 'load-error'; phase: string; message: string }
	| { type: 'link'; url: string }
	| { type: 'state'; state: Record<string, unknown> };

/*
 * M2 (editing) messages — reserved placeholders, do not implement yet:
 *
 *   webview -> host: { type: 'contentChanged'; label?: string }
 *   webview -> host: { type: 'snapshot'; bytes: ArrayBuffer }        // debounced engine snapshot for backup
 *   webview -> host: { type: 'saved'; bytes: ArrayBuffer }
 *   host -> webview: { type: 'requestSave' }
 *   host -> webview: { type: 'undo' } | { type: 'redo' }
 *   host -> worker:  { type: 'bo-assets'; assets: Record<string, ArrayBuffer> }  // bootstrap handshake (§4.2)
 */

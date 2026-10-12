/**
 * Message protocol shared between the extension host and the webview.
 *
 * This file is a *mirrored copy* of `webview/protocol.ts` (DESIGN §2/§9): the webview tsconfig does
 * not include `src/`, and the host must not import webview sources, so the two sides are kept in
 * sync by hand until a codegen step exists in M2.
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
			bytes: ArrayBuffer;
			config: ViewerWebviewConfig;
			fileName: string;
			/** Webview URI of `out/media/`, with a trailing slash. */
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
 *   worker  -> host: { type: 'ext-assets'; assets: Record<string, ArrayBuffer> }  // worker bootstrap handshake
 */

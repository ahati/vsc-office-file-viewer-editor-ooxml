/**
 * vsdx adapter: mounts the full `VsdxEditor` from the vendored
 * `@betteroffice/vsdx-react` (same pin as the vendored core) — ribbon
 * (File/Home/Insert/View), Shapes stencil sidebar with search, Drawing
 * Explorer, Shape Data panel, Layers panel, page tabs and zoom slider.
 *
 * Theme: the component is inline-styled light (the demo's exact look); the
 * mount wraps it in a white surface so dark VS Code themes don't bleed in.
 *
 * Save: the editor's built-in save downloads a `.vsdx` via a blob anchor; a
 * capture-phase click interceptor routes those bytes to the extension host
 * for lossless in-place save instead (same bridge as docx/xlsx/pptx).
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { VsdxEditorApi } from '../../vendor/betteroffice/vsdx-react/src/index';
import type { VsdxFontFace } from '../../vendor/betteroffice/vsdx/src/types';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { getAssetBytes, getAssetUrl, recordTiming } from '../bootstrap/assetBootstrap';
import { resolveHost } from '../chrome/errorPanel';
import { loadVsdxFonts } from '../vsdx/fonts';

const WASM_ASSET = 'vsdx_wasm_bg.wasm';

type VsdxEditorComponent = typeof import('../../vendor/betteroffice/vsdx-react/src/index')['VsdxEditor'];

let reactRoot: ReturnType<typeof createRoot> | undefined;

function ensureReactRoot(): ReturnType<typeof createRoot> {
	const host = resolveHost();
	if (!host) throw new Error('webview host element (#viewer-root) is missing');
	if (!reactRoot) {
		const container = host.querySelector<HTMLElement>('#office-vsdx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'office-vsdx-mount';
		// The editor is light-styled by design; give it an opaque light surface.
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;background:#ffffff;color:#1b1b1b';
		reactRoot = createRoot(container);
	}
	return reactRoot;
}

/** Mounts (or re-renders) the vsdx editor for one `init` payload. */
export async function mountVsdx(init: ViewerInit, context: ViewerContext): Promise<void> {
	// Compile the wasm before the editor mounts: VsdxEditor calls `initWasm()` with no arguments,
	// whose default URL would break in an IIFE bundle — the memoized init below wins instead.
	const wasmBytes = getAssetBytes(WASM_ASSET) ?? (await (await fetch(getAssetUrl(WASM_ASSET))).arrayBuffer());
	const { initWasm } = await import('../../vendor/betteroffice/vsdx/src/wasm/loader');
	await initWasm(new Uint8Array(wasmBytes));
	recordTiming('wasm-ready');
	const { VsdxEditor } = await import('../../vendor/betteroffice/vsdx-react/src/index');
	const fonts = await loadVsdxFonts(init.config);
	ensureReactRoot().render(
		<VsdxViewer VsdxEditor={VsdxEditor} init={init} context={context} fonts={fonts.fonts} />,
	);
}

interface VsdxViewerProps {
	VsdxEditor: VsdxEditorComponent;
	init: ViewerInit;
	context: ViewerContext;
	fonts: VsdxFontFace[];
}

function VsdxViewer({ VsdxEditor, init, context, fonts }: VsdxViewerProps): JSX.Element {
	const apiRef = useRef<VsdxEditorApi | null>(null);

	// In-place save: the editor's save action downloads a `.vsdx` blob anchor.
	// Intercept it (capture phase beats the anchor's default action) and hand
	// the bytes to the host, which writes them next to the source file.
	useEffect(() => {
		const onClick = (event: MouseEvent) => {
			const anchor = (event.target as HTMLElement | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
			if (!anchor || !/^blob:/i.test(anchor.href)) return;
			if (!/\.vsdx$/i.test(anchor.getAttribute('download') ?? '')) return;
			event.preventDefault();
			event.stopPropagation();
			void fetch(anchor.href)
				.then((response) => response.arrayBuffer())
				.then((bytes) => context.saveBytes(bytes))
				.catch((error: unknown) => context.fail('save', error));
		};
		document.addEventListener('click', onClick, true);
		return () => document.removeEventListener('click', onClick, true);
	}, [context]);

	return (
		<VsdxEditor
			file={new Uint8Array(init.bytes)}
			fonts={fonts}
			onReady={(api) => {
				apiRef.current = api;
			}}
			onChange={() => {
				try {
					const snapshot = apiRef.current?.handle.snapshot();
					context.reportState({ pageCount: snapshot?.pages.length ?? 0 });
				} catch {
					/* ignore */
				}
			}}
			onError={(error) => {
				// Degraded, not fatal: per-image decode failures and similar editor issues leave
				// the document usable. Log for diagnostics; the editor shows its own state.
				console.warn('[office-file-viewer] vsdx editor issue:', error);
			}}
		/>
	);
}

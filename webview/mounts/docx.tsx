/**
 * docx adapter: mounts the eigenpal `DocxEditor` (`@eigenpal/docx-editor-react`).
 *
 * Why eigenpal (product decision, 2026-10): DOM + ProseMirror paginated word processor with
 * lossless selective-rezip save (unsupported OOXML and embedded parts survive round-trips),
 * editable by default, Apache-2.0, and a much smaller attack surface than a WASM engine
 * (no wasm, no workers, no eval, zero `fetch(` in dist).
 *
 * OFFLINE CONTRACT (critical): the engine ships a Google Fonts CDN lookup that is ON by default.
 * `setGoogleFontsEnabled(false)` below runs at MODULE EVALUATION time — before any document can
 * parse — and permanently severs `fonts.googleapis.com` for this page. Font fidelity instead
 * comes from our bundled metric-compatible faces handed to the `fonts` prop (see webview/fonts.ts).
 *
 * Prop names verified against `node_modules/@eigenpal/docx-editor-react/dist/index.d.ts`:
 *   documentBuffer?: DocxInput (ArrayBuffer | Uint8Array | Blob | File)   documentName?: string
 *   readOnly?: boolean (hides toolbar + rulers)   mode?: 'editing'|'suggesting'|'viewing'
 *   colorMode?: 'light'|'dark'|'system'           showToolbar/showFileOpen/showHelpMenu?: boolean
 *   showZoomControl?: boolean  showRuler?: boolean  showOutline?: boolean
 *   fonts?: ReadonlyArray<FontDefinition>         onSave?: (buffer: ArrayBuffer) => void
 *   onChange?: (document: Document) => void       onError?: (error: Error) => void
 *   initialZoom?: number                          ref: DocxEditorRef (save/getZoom/getCurrentPage/…)
 */
import { setGoogleFontsEnabled } from '@eigenpal/docx-editor-core';
import '@eigenpal/docx-editor-react/styles.css';
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocxEditorRef } from '@eigenpal/docx-editor-react';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { loadDocxFontDefinitions } from '../fonts';

// Offline kill switch — MUST run before any editor mounts or document parses. The engine's
// Google Fonts lookup is page-global and defaults to enabled; this is the only network egress
// the docx engine can ever perform (see webview/fonts.ts for the offline font substitute).
setGoogleFontsEnabled(false);

type DocxEditorComponent = typeof import('@eigenpal/docx-editor-react')['DocxEditor'];

/** State polling interval for `state { zoom, page }` (the debounce in the entry runtime is 500 ms). */
const STATE_POLL_MS = 1_000;

let reactRoot: ReturnType<typeof createRoot> | undefined;

function ensureReactRoot(): ReturnType<typeof createRoot> {
	const host = resolveHost();
	if (!host) throw new Error('webview host element (#viewer-root) is missing');
	if (!reactRoot) {
		// Keep the host's #status overlay in place: mount into a dedicated child.
		const container = host.querySelector<HTMLElement>('#office-docx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'office-docx-mount';
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;color-scheme:light';
		// The document page is forced light; keep native scrollbars/form controls light as well.
		const scheme = host.ownerDocument.createElement('style');
		scheme.textContent = '#office-docx-mount, #office-docx-mount * { color-scheme: light; }';
		host.ownerDocument.head.appendChild(scheme);
		reactRoot = createRoot(container);
	}
	return reactRoot;
}

/** Mounts (or re-renders) the docx editor for one `init` payload. */
export async function mountDocx(init: ViewerInit, context: ViewerContext): Promise<void> {
	const { DocxEditor } = await import('@eigenpal/docx-editor-react');
	ensureReactRoot().render(
		<DocxViewer DocxEditor={DocxEditor} init={init} context={context} fonts={await loadDocxFontDefinitions(init.config)} />,
	);
}

interface DocxViewerProps {
	DocxEditor: DocxEditorComponent;
	init: ViewerInit;
	context: ViewerContext;
	fonts: Awaited<ReturnType<typeof loadDocxFontDefinitions>>;
}

function DocxViewer({ DocxEditor, init, context, fonts }: DocxViewerProps): JSX.Element {
	const ref = useRef<DocxEditorRef | null>(null);
	const readOnly = !init.config.editing || init.config.forceReadOnly;

	// `state { zoom, page }`: best effort, polled — the ref exposes getters only.
	useEffect(() => {
		const timer = setInterval(() => {
			const editor = ref.current;
			if (!editor) return;
			try {
				context.reportState({
					zoom: editor.getZoom(),
					page: editor.getCurrentPage(),
					pageCount: editor.getTotalPages(),
				});
			} catch {
				/* editor is mid-teardown */
			}
		}, STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [context]);

	// Restore the previous zoom/page once the document has laid out (best effort: the eigenpal
	// ref has no layout-complete promise, so retry until the page count is non-zero).
	useEffect(() => {
		const editor = ref.current;
		if (!editor) return;
		if (!context.hasSavedZoom() && context.getSavedPage(1) === 1) return;
		let attempts = 0;
		const timer = setInterval(() => {
			attempts += 1;
			const ready = editor.getTotalPages() > 0;
			if (!ready && attempts < 60) return;
			clearInterval(timer);
			if (!ready) return;
			if (context.hasSavedZoom()) editor.setZoom(context.getInitialZoom(1));
			const page = context.getSavedPage(1);
			if (page > 1) editor.scrollToPage(page);
		}, 500);
		return () => clearInterval(timer);
	}, [context]);

	return (
		<DocxEditor
			ref={ref}
			documentBuffer={init.bytes}
			documentName={init.fileName}
			readOnly={readOnly}
			mode={readOnly ? 'viewing' : 'editing'}
			// Word documents are white-paper artifacts; keep the editing surface light even in dark
			// VS Code themes (the surrounding chrome still follows the editor theme).
			colorMode="light"
			showZoomControl
			showRuler={!readOnly}
			showOutline
			showFileOpen={false}
			showHelpMenu={false}
			fonts={fonts}
			onSave={(buffer) => context.saveBytes(buffer)}
			onError={(error) => context.fail('render', error)}
		/>
	);
}

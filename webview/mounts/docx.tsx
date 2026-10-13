/**
 * docx adapter: mounts `DocxEditor` (from `@betteroffice/docx-react`) with the default chrome.
 *
 * Prop names verified against `node_modules/@betteroffice/docx-react/dist/index.d.mts` and
 * https://docs.betteroffice.dev/docs/javascript:
 *   documentBuffer?: DocxInput (ArrayBuffer | Uint8Array | Blob | File)   readOnly?: boolean
 *   mode?: EditorMode ('editing' default | 'viewing' | 'suggesting')      showZoomControl?: boolean
 *   showRuler? showOutline? showToolbar? (omit = default chrome, null = none, false = hidden)
 *   showFileOpen?: boolean  showHelpMenu?: boolean  onSave?: (buffer: ArrayBuffer) => void
 *   onError?: (error: Error) => void  disableFindReplaceShortcuts?: boolean
 *   ref: DocxEditorRef { getZoom/setZoom, getCurrentPage, getTotalPages, findInDocument,
 *                        scrollToParaId, whenLayoutComplete, print }
 *
 * Omitting `toolbar` renders the built-in toolbar (incl. its find/replace dialog, review and
 * outline chrome), which also renders in read-only mode; `showToolbar={false}` would hide the
 * whole region (the regression this file once had). Editing defaults on per `officeFileViewer.editing`;
 * saves arrive through `onSave` and are written by the extension host (lossless engine round-trip).
 */
import '@betteroffice/docx-react/styles.css';
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocxEditorRef } from '@betteroffice/docx-react';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { configureDocxFonts } from '../fonts';

type DocxEditorComponent = typeof import('@betteroffice/docx-react')['DocxEditor'];

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
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0';
		reactRoot = createRoot(container);
	}
	return reactRoot;
}

/** Mounts (or re-renders) the docx viewer for one `init` payload. */
export async function mountDocx(init: ViewerInit, context: ViewerContext): Promise<void> {
	// Fonts must be configured before the editor lays out (and before the dynamic import below,
	// whose module scope resolves the bundled face table).
	configureDocxFonts(init.config);
	const { DocxEditor } = await import('@betteroffice/docx-react');
	ensureReactRoot().render(<DocxViewer DocxEditor={DocxEditor} init={init} context={context} />);
}

interface DocxViewerProps {
	DocxEditor: DocxEditorComponent;
	init: ViewerInit;
	context: ViewerContext;
}

function DocxViewer({ DocxEditor, init, context }: DocxViewerProps): JSX.Element {
	const ref = useRef<DocxEditorRef | null>(null);
	const readOnly = !init.config.editing || init.config.forceReadOnly;

	// `state { zoom, page }`: best effort, polled — the docx ref exposes getters only.
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

	// Restore the previous zoom/page once the document is laid out (zoom is a factor, not the setting).
	useEffect(() => {
		const editor = ref.current;
		if (!editor) return;
		if (!context.hasSavedZoom() && context.getSavedPage(1) === 1) return;
		let cancelled = false;
		void editor
			.whenLayoutComplete({ timeoutMs: 30_000 })
			.then(() => {
				if (cancelled) return;
				if (context.hasSavedZoom()) ref.current?.setZoom(context.getInitialZoom(1));
				const page = context.getSavedPage(1);
				if (page > 1) ref.current?.scrollToPage(page);
			})
			.catch(() => {
				/* layout failures are surfaced by onError */
			});
		return () => {
			cancelled = true;
		};
	}, [context]);

	return (
		<>
			<DocxEditor
				ref={ref}
				documentBuffer={init.bytes}
				// No `fileName` prop on DocxEditor: the title bar uses `documentName`.
				documentName={init.fileName}
				readOnly={readOnly}
				{...(readOnly ? { mode: 'viewing' as const } : {})}
				showZoomControl
				showRuler
				showOutline
				showFileOpen={false}
				showHelpMenu={false}
				onSave={(buffer) => context.saveBytes(buffer)}
				onError={(error) => context.fail('render', error)}
			/>
		</>
	);
}


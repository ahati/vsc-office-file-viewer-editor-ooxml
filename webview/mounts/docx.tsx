/**
 * docx adapter: mounts `DocxEditor` (from `@betteroffice/docx-react`) in read-only viewing mode.
 *
 * Prop names verified against `node_modules/@betteroffice/docx-react/dist/index.d.mts`:
 *   documentBuffer?: DocxInput (ArrayBuffer | Uint8Array | Blob | File)   readOnly?: boolean
 *   mode?: EditorMode ('viewing')                                        showZoomControl?: boolean
 *   showRuler?: boolean  showToolbar?: boolean  showFileOpen?: boolean
 *   onError?: (error: Error) => void  disableFindReplaceShortcuts?: boolean
 *   ref: DocxEditorRef { getZoom/setZoom, getCurrentPage, getTotalPages, findInDocument,
 *                        scrollToParaId, whenLayoutComplete, print }
 *
 * The editor's own find UI is superseded by the shared find bar (`chrome/FindBar.tsx`), which uses
 * `findInDocument` + `scrollToParaId` — `DocxEditorRef.findText` needs a story/scope + view pair
 * that a plain find bar cannot supply and is meant for scripted edits.
 */
import '@betteroffice/docx-react/styles.css';
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocxEditorRef } from '@betteroffice/docx-react';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { FindBar, type FindAdapter, type FindOutcome } from '../chrome/FindBar';
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
		const container = host.querySelector<HTMLElement>('#bo-docx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'bo-docx-mount';
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
				readOnly
				mode="viewing"
				showZoomControl
				// readOnly hides the toolbar and rulers upstream, but pass them explicitly so the
				// viewer chrome survives a future read-only/editing split.
				showRuler
				showToolbar={false}
				showFileOpen={false}
				showHelpMenu={false}
				// Give Ctrl/Cmd+F to our find bar instead of the editor's inline find UI.
				disableFindReplaceShortcuts
				onError={(error) => context.fail('render', error)}
			/>
			<FindBar adapter={createDocxFindAdapter(ref)} />
		</>
	);
}

/** `findInDocument` (case-insensitive substring) + `scrollToParaId` highlight, cycling per query. */
function createDocxFindAdapter(ref: { current: DocxEditorRef | null }): FindAdapter {
	let lastQuery = '';
	let index = 0;
	return {
		async find(query: string): Promise<FindOutcome> {
			const editor = ref.current;
			if (!editor) return { count: 0, index: 0, error: 'editor not ready' };
			if (query !== lastQuery) {
				lastQuery = query;
				index = 0;
			}
			const matches = editor.findInDocument(query, { limit: 500 });
			if (matches.length === 0) return { count: 0, index: 0, truncated: false };
			const current = matches[index % matches.length]!;
			index += 1;
			editor.scrollToParaId(current.paraId, { highlight: { color: 'rgba(255, 235, 59, 0.55)' } });
			return { count: matches.length, index: ((index - 1) % matches.length) + 1, truncated: matches.length >= 500 };
		},
		clear(): void {
			lastQuery = '';
			index = 0;
		},
	};
}

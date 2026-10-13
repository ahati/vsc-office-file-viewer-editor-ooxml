/**
 * docx adapter: mounts the `@docx-editor.dev/react` `DocxEditor` (2.29.0).
 *
 * OFFLINE CONTRACT (critical): unlike 1.x there is no Google Fonts lookup to disable — the CDN
 * origin is an opt-in package (`@docx-editor.dev/fonts/google`) we do not install, and every
 * font we hand to the engine is byte-backed (see webview/fonts.ts), so there is no URL for the
 * engine to fetch on demand. HarfBuzz shaping loads `harfbuzz.wasm` as a same-origin extension
 * asset from the build's asset manifest; the engine dists contain no workers, no dynamic
 * imports and no telemetry (docs/MIGRATION-DOCX-EDITOR-2X.md §2). Readers are: (1) no egress by
 * construction — bytes-only sources, no modules, no resolver that fetches; (2) the webview CSP
 * (`script-src 'wasm-unsafe-eval'`, `connect-src <ext-origin> data: blob:`);
 * (3) the build's no-egress/no-collaboration bundle postcheck.
 *
 * Prop mapping verified against `node_modules/@docx-editor.dev/react/dist/index.d.ts` (2.29.0):
 *   document?: DocumentSource (ArrayBuffer | Uint8Array | DocumentHandle | 'blank')
 *   title?: string                         mode?: 'edit' | 'view' | 'suggesting'
 *   colorMode?: 'light' | 'dark' | 'system' (chrome only; the canvas stays Word-faithful)
 *   chrome?: boolean (default true)        navigation?: boolean (default true — outline parity)
 *   rulers?: boolean                       menu?: boolean | DocxEditorMenuProps
 *   fonts?: FontConfiguration | FontConfigurationFragment | FontResolver
 *   zoom?: number   zoomMode?: ZoomMode | 'auto'
 *   onSave?: () => void                    onFontError?: (error: EditorFontError) => void
 *   ref: load/save/getDocumentHandle/getEditor/focus/exec/snapshot — zoom and paging live on
 *   the `Editor` facade reached through `getEditor()`.
 */
import '@docx-editor.dev/react/styles.css';
import type { ZoomMode } from '@docx-editor.dev/core/contracts/editor';
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocxEditorRef } from '@docx-editor.dev/react';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { loadDocxFontDefinitions } from '../fonts';

type DocxEditorComponent = typeof import('@docx-editor.dev/react')['DocxEditor'];

/** State polling interval for `state { zoom, page }` (the debounce in the entry runtime is 500 ms). */
const STATE_POLL_MS = 1_000;

/** How many 500 ms ticks the zoom/page restore waits for the first layout before giving up. */
const RESTORE_MAX_ATTEMPTS = 60;

let reactRoot: ReturnType<typeof createRoot> | undefined;
/** The container style element that forces the light chrome, when `colorMode === 'light'`. */
let lightSchemeStyle: HTMLStyleElement | undefined;

function ensureReactRoot(colorMode: 'light' | 'dark' | 'system'): ReturnType<typeof createRoot> {
	const host = resolveHost();
	if (!host) throw new Error('webview host element (#viewer-root) is missing');
	if (!reactRoot) {
		// Keep the host's #status overlay in place: mount into a dedicated child.
		const container = host.querySelector<HTMLElement>('#office-docx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'office-docx-mount';
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0';
		reactRoot = createRoot(container);
	}
	applyLightChromeScheme(host.ownerDocument, colorMode);
	return reactRoot;
}

/**
 * `officeFileViewer.colorMode` (plan §6): the 2.x engine themes the **chrome** only — the page
 * canvas stays Word-faithful white in every mode.
 *
 * - `light` (default): keep forcing `color-scheme: light` plus light native scrollbars, exactly
 *   as before the setting existed.
 * - `dark` / `system`: drop those overrides so the chrome (and its radix popups/scrollbars)
 *   follows the setting/OS theme instead of fighting it.
 */
function applyLightChromeScheme(doc: Document, colorMode: 'light' | 'dark' | 'system'): void {
	const scope = '#office-docx-mount';
	const container = doc.querySelector<HTMLElement>(scope);
	if (colorMode !== 'light') {
		lightSchemeStyle?.remove();
		lightSchemeStyle = undefined;
		if (container) container.style.colorScheme = 'normal';
		return;
	}
	if (container) container.style.colorScheme = 'light';
	if (lightSchemeStyle) return;
	const scheme = doc.createElement('style');
	scheme.textContent = [
		`${scope}, ${scope} * { color-scheme: light; }`,
		`${scope} { scrollbar-color: #c4ccd6 #f3f5f8; }`,
		`${scope} ::-webkit-scrollbar { width: 12px; height: 12px; background: #f5f6f8; }`,
		`${scope} ::-webkit-scrollbar-thumb { background: #c4ccd6; border-radius: 6px; border: 3px solid #f5f6f8; }`,
		`${scope} ::-webkit-scrollbar-thumb:hover { background: #aab3c0; }`,
		`${scope} ::-webkit-scrollbar-corner { background: #f5f6f8; }`,
	].join('\n');
	doc.head.appendChild(scheme);
	lightSchemeStyle = scheme;
}

/** Mounts (or re-renders) the docx editor for one `init` payload. */
export async function mountDocx(init: ViewerInit, context: ViewerContext): Promise<void> {
	const { DocxEditor } = await import('@docx-editor.dev/react');
	ensureReactRoot(init.config.colorMode).render(
		<DocxViewer DocxEditor={DocxEditor} init={init} context={context} fonts={await loadDocxFontDefinitions(init.config)} />,
	);
}

interface DocxViewerProps {
	DocxEditor: DocxEditorComponent;
	init: ViewerInit;
	context: ViewerContext;
	fonts: Awaited<ReturnType<typeof loadDocxFontDefinitions>>;
}

/** The `zoom`/`zoomMode` pair 2.x takes, derived from `ViewerWebviewConfig.initialZoom`. */
interface DocxZoomProps {
	zoom?: number;
	zoomMode: ZoomMode | 'auto';
}

/**
 * `initialZoom` → 2.x zoom props.
 *
 * 2.29.0's `ZoomFitTarget` has a single member, `'pageWidth'` (the page-height fit is not part
 * of this line), so `fitPage` uses the same width fit as `fitWidth`; `'auto'` is the engine's
 * bounded 50–100% width fit. A saved zoom still wins at restore time (`Editor.setZoom` leaves
 * the fit mode). `ZoomMode` literals verified in
 * `node_modules/@docx-editor.dev/core/dist/editor-CZQZmTIU.d.ts`.
 */
function resolveZoom(initialZoom: ViewerInit['config']['initialZoom']): DocxZoomProps {
	switch (initialZoom) {
		case 'fitPage':
		case 'fitWidth':
			return { zoomMode: { type: 'fit', fit: 'pageWidth' } };
		case '100':
			return { zoom: 1, zoomMode: { type: 'fixed' } };
	}
}

function DocxViewer({ DocxEditor, init, context, fonts }: DocxViewerProps): JSX.Element {
	const ref = useRef<DocxEditorRef | null>(null);
	const readOnly = !init.config.editing || init.config.forceReadOnly;
	const { zoom, zoomMode } = resolveZoom(init.config.initialZoom);

	// `state { zoom, page }`: best effort, polled. The ref only exposes `getEditor()`; the
	// facade behind it owns zoom and paging and is `null` until the editor has mounted.
	useEffect(() => {
		const timer = setInterval(() => {
			try {
				const editor = ref.current?.getEditor();
				if (!editor) return;
				context.reportState({
					zoom: editor.getZoom(),
					page: editor.getCurrentPage(),
					// `getPageGeometry()` is empty until the first layout, the honest answer.
					pageCount: editor.getPageGeometry().length,
				});
			} catch {
				/* editor is mid-teardown */
			}
		}, STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [context]);

	// 2.x has no `onError`: a failed open lands in the snapshot's `parseError` (a
	// `document.open` diagnostic only reaches a module registered at construction, and the
	// document we pass at construction opens before `onReady` can subscribe). Poll the
	// snapshot and surface the first failure through the host error panel; dedupe so one
	// failure is reported once even if it stays set.
	useEffect(() => {
		let reported: string | null = null;
		const timer = setInterval(() => {
			try {
				const parseError = ref.current?.snapshot().parseError ?? null;
				if (!parseError || parseError === reported) return;
				reported = parseError;
				context.fail('render', new Error(parseError));
			} catch {
				/* editor is mid-teardown */
			}
		}, STATE_POLL_MS);
		return () => clearInterval(timer);
	}, [context]);

	// Restore the previous zoom/page once the document has laid out. The layout-ready signal is
	// `getPageGeometry().length > 0` (the engine has no layout-complete promise); retry until it
	// is non-empty, then prefer the saved zoom over the configured one.
	useEffect(() => {
		if (!context.hasSavedZoom() && context.getSavedPage(1) === 1) return;
		let attempts = 0;
		const timer = setInterval(() => {
			attempts += 1;
			const editor = ref.current?.getEditor();
			const ready = (editor?.getPageGeometry().length ?? 0) > 0;
			if (!ready && attempts < RESTORE_MAX_ATTEMPTS) return;
			clearInterval(timer);
			if (!editor || !ready) return;
			if (context.hasSavedZoom()) editor.setZoom(context.getInitialZoom(1));
			const page = context.getSavedPage(1);
			if (page > 1) editor.scrollToPage(page);
		}, 500);
		return () => clearInterval(timer);
	}, [context]);

	return (
		<DocxEditor
			ref={ref}
			document={init.bytes}
			title={init.fileName}
			mode={readOnly ? 'view' : 'edit'}
			// 2.x themes the chrome only; the canvas stays Word-faithful white. Follows
			// `officeFileViewer.colorMode` (default 'light'; see applyLightChromeScheme for the
			// container/scrollbar overrides that stay light-only).
			colorMode={init.config.colorMode}
			rulers={!readOnly}
			// chrome + navigation keep their 2.x defaults (both true) — same frame + outline
			// visibility as the 1.x `showToolbar`/`showOutline` pair.
			menu={{
				// An offline product must not offer the upstream issue tracker (plan §2, M3).
				reportIssue: false,
				// VS Code owns opening files; drop the packaged File › Open row (the one
				// remaining way to reach the menu's own file picker). Hiding the row does
				// NOT unbind the bar's Ctrl+O — the keydown prefers menu.onOpen over the
				// packaged hidden file input, so a no-op handler neutralizes it.
				onOpen: () => {},
				children: (
					<DocxEditor.Menu.File>
						<DocxEditor.Menu.Open hidden />
					</DocxEditor.Menu.File>
				),
			}}
			zoom={zoom}
			zoomMode={zoomMode}
			fonts={fonts}
			onSave={() => {
				void ref.current?.save().then((buffer) => {
					if (buffer) context.saveBytes(buffer);
				});
			}}
			// Font failures are non-fatal: the engine falls back to a fixed-width measurer, so
			// layout degrades but the document still opens. Report and keep going.
			onFontError={(error) => {
				console.warn(`[office-file-viewer] docx font ${error.code}: ${error.message}`);
			}}
		/>
	);
}

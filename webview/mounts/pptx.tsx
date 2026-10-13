/**
 * pptx adapter: mounts `PptxEditor` (from `@betteroffice/pptx-react`) in read-only mode.
 *
 * pptx has **no worker anywhere** in the published package: the presentation session runs in-thread
 * and `initWasm(input)` accepts bytes, so the webview main thread compiles the module first (globally
 * memoized). `fonts` is a *required* prop — see `webview/fonts.ts` (`loadPptxFontFaces`).
 *
 * Prop/API names verified against `node_modules/@betteroffice/pptx-react/dist/index.d.ts`:
 *   PptxEditorProps: file?: Uint8Array, fonts: ReadonlyArray<PptxFontFace>, readOnly?: boolean,
 *                    fileName?: string, initialSlide?: number (1-based), showToolbar?: boolean,
 *                    onReady?: (api: PptxEditorApi) => void, onError?: (error: Error) => void,
 *                    onChange?: (snapshot: DeckSnapshot) => void
 *   PptxEditorApi:   findText({ text, within?, limit? }), selectText({ slide, shapeId, storyId,
 *                    start, end }), goToSlide(1-based), handle.snapshot(): DeckSnapshot
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { PptxFontFace } from '@betteroffice/pptx';
import type { PptxEditorApi } from '@betteroffice/pptx-react';
import { getAssetBytes, getAssetUrl, recordTiming } from '../bootstrap/assetBootstrap';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { FindBar, type FindAdapter, type FindOutcome } from '../chrome/FindBar';
import { loadPptxFontFaces } from '../fonts';

type PptxEditorComponent = typeof import('@betteroffice/pptx-react')['PptxEditor'];

const WASM_ASSET = 'pptx_wasm_bg.wasm';

let reactRoot: ReturnType<typeof createRoot> | undefined;

function ensureReactRoot(): ReturnType<typeof createRoot> {
	const host = resolveHost();
	if (!host) throw new Error('webview host element (#viewer-root) is missing');
	if (!reactRoot) {
		const container = host.querySelector<HTMLElement>('#office-pptx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'office-pptx-mount';
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0';
		reactRoot = createRoot(container);
	}
	return reactRoot;
}

/** Mounts (or re-renders) the pptx viewer for one `init` payload. */
export async function mountPptx(init: ViewerInit, context: ViewerContext): Promise<void> {
	const engine = await import('@betteroffice/pptx');
	if (!engine.isWasmAvailable()) {
		const bytes = getAssetBytes(WASM_ASSET) ?? (await (await fetch(getAssetUrl(WASM_ASSET))).arrayBuffer());
		await engine.initWasm(new Uint8Array(bytes));
	}
	recordTiming('wasm-ready');

	const fonts: PptxFontFace[] = await loadPptxFontFaces(init.config);
	const { PptxEditor } = await import('@betteroffice/pptx-react');
	ensureReactRoot().render(<PptxViewer PptxEditor={PptxEditor} fonts={fonts} init={init} context={context} />);
}

interface PptxViewerProps {
	PptxEditor: PptxEditorComponent;
	fonts: PptxFontFace[];
	init: ViewerInit;
	context: ViewerContext;
}

function PptxViewer({ PptxEditor, fonts, init, context }: PptxViewerProps): JSX.Element {
	const apiRef = useRef<PptxEditorApi | null>(null);
	const slideRef = useRef(1);
	const slideCountRef = useRef(0);

	// `onChange` only fires on deck changes, so `state { page }` is polled while editing is off but
	// navigation still moves the current slide.
	useEffect(() => {
		const timer = setInterval(() => {
			const api = apiRef.current;
			if (!api) return;
			try {
				const slides = api.handle.snapshot().slides.length;
				slideCountRef.current = slides;
				context.reportState({ page: slideRef.current, pageCount: slides });
			} catch {
				/* presentation is mid-teardown */
			}
		}, 1_000);
		return () => clearInterval(timer);
	}, [context]);

	// Restore the previous slide (`state { page }`) once the deck opens; `initialSlide` is 1-based and
	// clamped by the engine.
	return (
		<>
			<PptxEditor
				file={new Uint8Array(init.bytes)}
				fonts={fonts}
				fileName={init.fileName}
				initialSlide={context.getSavedPage(1)}
				readOnly={!init.config.editing || init.config.forceReadOnly}
				onSave={(bytes) => context.saveBytes(bytes)}
				onReady={(api) => {
					apiRef.current = api;
				}}
				onError={(error) => context.fail('render', error)}
				onChange={() => {
					const api = apiRef.current;
					if (!api) return;
					try {
						slideCountRef.current = api.handle.snapshot().slides.length;
					} catch {
						/* ignore */
					}
				}}
			/>
			<FindBar adapter={createPptxFindAdapter(apiRef, slideRef)} />
		</>
	);
}

/**
 * `findText` + `selectText`. The find result identifies the slide by `slideId`, while `selectText`
 * wants a 1-based slide number, so the id is resolved through `handle.snapshot()`.
 */
function createPptxFindAdapter(
	apiRef: { current: PptxEditorApi | null },
	slideRef: { current: number },
): FindAdapter {
	let lastQuery = '';
	let index = 0;
	return {
		async find(query: string): Promise<FindOutcome> {
			const api = apiRef.current;
			if (!api) return { count: 0, index: 0, error: 'editor not ready' };
			if (query !== lastQuery) {
				lastQuery = query;
				index = 0;
			}
			const result = await api.findText({ text: query, limit: 200 });
			if (!result.ok) {
				const failure = (result as { failure?: { message?: string } }).failure;
				return { count: 0, index: 0, error: failure?.message ?? 'search refused' };
			}
			if (result.matches.length === 0) return { count: 0, index: 0, truncated: result.truncated };

			const match = result.matches[index % result.matches.length]!;
			index += 1;
			const slides = api.handle.snapshot().slides;
			const slideIndex = slides.findIndex((slide) => slide.id === match.range.slideId);
			const slide = slideIndex >= 0 ? slideIndex + 1 : 1;
			slideRef.current = slide;
			api.selectText({
				slide,
				shapeId: match.range.shapeId,
				storyId: match.range.storyId,
				start: match.range.start,
				end: match.range.end,
			});
			return {
				count: result.matches.length,
				index: ((index - 1) % result.matches.length) + 1,
				truncated: result.truncated,
			};
		},
		clear(): void {
			lastQuery = '';
			index = 0;
		},
	};
}

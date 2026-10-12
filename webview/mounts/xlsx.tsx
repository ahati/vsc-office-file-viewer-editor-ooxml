/**
 * xlsx adapter: mounts `XlsxEditor` (from `@betteroffice/xlsx-react`) in read-only mode.
 *
 * xlsx has **no worker anywhere** in the published package and **no font API at all** (SCOPING R8):
 * the engine runs in-thread and its `initWasm(input)` accepts bytes, so the webview main thread
 * compiles the module before mounting (module-global + memoized, so the editor reuses it).
 *
 * Prop/API names verified against `node_modules/@betteroffice/xlsx-react/dist/index.d.ts`:
 *   XlsxEditorProps: file?: Uint8Array, fileName?: string, readOnly?: boolean,
 *                    showToolbar?: boolean, onReady?: (api: XlsxEditorApi) => void | (() => void)
 *   XlsxEditorApi:   findText({ text, sheetIds?, limit? }), selectCells(sheet: number, Selection),
 *                    handle: WorkbookHandle { sheetInfo(): { sheetIds, sheetNames, activeSheet } }
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { XlsxEditorApi } from '@betteroffice/xlsx-react';
import { getAssetBytes, getAssetUrl, recordTiming } from '../bootstrap/assetBootstrap';
import type { ViewerContext, ViewerInit } from '../bootstrap/entryRuntime';
import { resolveHost } from '../chrome/errorPanel';
import { FindBar, type FindAdapter, type FindOutcome } from '../chrome/FindBar';

type XlsxEditorComponent = typeof import('@betteroffice/xlsx-react')['XlsxEditor'];

const WASM_ASSET = 'xlsx_wasm_bg.wasm';

let reactRoot: ReturnType<typeof createRoot> | undefined;

function ensureReactRoot(): ReturnType<typeof createRoot> {
	const host = resolveHost();
	if (!host) throw new Error('webview host element (#viewer-root) is missing');
	if (!reactRoot) {
		const container = host.querySelector<HTMLElement>('#bo-xlsx-mount') ?? host.appendChild(document.createElement('div'));
		container.id = 'bo-xlsx-mount';
		container.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0';
		reactRoot = createRoot(container);
	}
	return reactRoot;
}

/** Mounts (or re-renders) the xlsx viewer for one `init` payload. */
export async function mountXlsx(init: ViewerInit, context: ViewerContext): Promise<void> {
	const engine = await import('@betteroffice/xlsx');
	if (!engine.isWasmAvailable()) {
		const bytes = getAssetBytes(WASM_ASSET) ?? (await (await fetch(getAssetUrl(WASM_ASSET))).arrayBuffer());
		await engine.initWasm(new Uint8Array(bytes));
	}
	recordTiming('wasm-ready');

	const { XlsxEditor } = await import('@betteroffice/xlsx-react');
	ensureReactRoot().render(<XlsxViewer XlsxEditor={XlsxEditor} init={init} context={context} />);
}

interface XlsxViewerProps {
	XlsxEditor: XlsxEditorComponent;
	init: ViewerInit;
	context: ViewerContext;
}

function XlsxViewer({ XlsxEditor, init, context }: XlsxViewerProps): JSX.Element {
	const apiRef = useRef<XlsxEditorApi | null>(null);

	// `state { zoom, page }`: xlsx has no zoom/page getters on the editor API; the active sheet
	// index is the closest equivalent, reported once the workbook opens.
	useEffect(() => {
		const api = apiRef.current;
		if (!api) return;
		try {
			const info = api.handle.sheetInfo();
			context.reportState({ page: info.activeSheet + 1, pageCount: info.sheetIds.length });
		} catch {
			/* workbook not ready yet */
		}
	}, [context]);

	return (
		<>
			<XlsxEditor
				file={new Uint8Array(init.bytes)}
				fileName={init.fileName}
				readOnly
				showToolbar={false}
				onReady={(api) => {
					apiRef.current = api;
				}}
			/>
			<FindBar adapter={createXlsxFindAdapter(apiRef)} />
		</>
	);
}

/** `findText` + `selectCells`; the find result carries the sheet id, `selectCells` wants an index. */
function createXlsxFindAdapter(apiRef: { current: XlsxEditorApi | null }): FindAdapter {
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
			const info = api.handle.sheetInfo();
			const sheet = info.sheetIds.indexOf(match.cell.sheetId);
			api.selectCells(sheet >= 0 ? sheet : info.activeSheet, {
				anchor: { row: match.cell.row, col: match.cell.col },
				focus: { row: match.cell.row, col: match.cell.col },
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

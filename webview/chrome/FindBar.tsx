/**
 * Thin, theme-aware find bar shared by the three React mounts.
 *
 * It owns only the UI (Ctrl/Cmd+F toggling, query entry, match counter, Escape) and delegates the
 * actual search to a per-format {@link FindAdapter}, because the three engines expose different find
 * shapes (all verified against the installed `.d.ts` files):
 *
 *   - docx   `DocxEditorRef.findInDocument(query)` + `scrollToParaId(paraId, { highlight })`
 *            (`findText` needs a `within` scope + `view`, which a find bar does not have)
 *   - xlsx   `XlsxEditorApi.findText({ text })` + `selectCells(sheet, { ... })`
 *   - pptx   `PptxEditorApi.findText({ text })` + `selectText({ slide, shapeId, storyId, start, end })`
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

/** One search pass, performed by the format adapter. */
export interface FindOutcome {
	/** Total matches reported by the engine (may be capped by the engine's `limit`). */
	count: number;
	/** 1-based index of the match the adapter navigated to, or 0 when nothing was found. */
	index: number;
	/** True when the engine reported more matches than it returned. */
	truncated?: boolean;
	/** Failure text (refusal or thrown error); when set the counter shows it instead of `n of m`. */
	error?: string;
}

/**
 * Format-specific search. `find(query)` performs a fresh search for a new query, or advances to the
 * next match when called again with the same query (so Enter keeps cycling).
 */
export interface FindAdapter {
	find(query: string): Promise<FindOutcome>;
	/** Clears search highlights/selection when the bar closes. */
	clear(): void;
}

interface FindBarProps {
	adapter: FindAdapter;
	/** Focus the document again after closing. */
	onClose?: () => void;
}

const BAR_ID = 'bo-find-bar';

export function FindBar({ adapter, onClose }: FindBarProps): JSX.Element | null {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [outcome, setOutcome] = useState<FindOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const busyRef = useRef(false);

	// Ctrl/Cmd+F opens, Escape closes. Engine editors also bind Ctrl+F (docx appends its own
	// find UI); we only run while our bar has focus/our state, and `capture` keeps us first.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				event.stopPropagation();
				setOpen(true);
			} else if (event.key === 'Escape' && open) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		};
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
		// `open` is intentionally captured so Escape only closes an open bar.
	});

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	/** Runs `query`; repeating the same query cycles to the next match (adapter-owned state). */
	const run = (nextQuery: string): void => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		void adapter
			.find(nextQuery)
			.then((result) => setOutcome(result))
			.catch((error: unknown) => {
				setOutcome({ count: 0, index: 0, error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				busyRef.current = false;
				setBusy(false);
			});
	};

	const close = (): void => {
		setOpen(false);
		setOutcome(null);
		adapter.clear();
		onClose?.();
	};

	if (!open) return null;

	const label = busy
		? 'searching…'
		: outcome?.error
			? outcome.error
			: outcome
				? outcome.count === 0
					? 'No results'
					: `${outcome.index} of ${outcome.count}${outcome.truncated ? '+' : ''}`
				: '';

	return (
		<div id={BAR_ID} role="search" style={BAR_STYLE}>
			<input
				ref={inputRef}
				type="text"
				value={query}
				aria-label="Find in document"
				placeholder="Find"
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						// Same query + Enter: next match (adapter cycles internally).
						run(query);
					}
				}}
				style={INPUT_STYLE}
			/>
			<span aria-live="polite" style={COUNTER_STYLE}>
				{label}
			</span>
			<button type="button" style={BUTTON_STYLE} onClick={() => run(query)} disabled={query.length === 0}>
				Next
			</button>
			<button type="button" style={BUTTON_STYLE} onClick={close} aria-label="Close find">
				✕
			</button>
		</div>
	);
}

const PANEL_BG = 'var(--vscode-editorWidget-background, var(--vscode-editor-background))';

const BAR_STYLE = {
	position: 'absolute',
	top: '8px',
	right: '16px',
	zIndex: 20,
	display: 'flex',
	alignItems: 'center',
	gap: '6px',
	padding: '4px 6px',
	border: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, transparent))',
	borderRadius: '4px',
	background: PANEL_BG,
	color: 'var(--vscode-foreground)',
	boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
	fontFamily: 'var(--vscode-font-family, sans-serif)',
	fontSize: '12px',
} as const;

const INPUT_STYLE = {
	width: '180px',
	padding: '2px 6px',
	border: '1px solid var(--vscode-input-border, transparent)',
	borderRadius: '2px',
	background: 'var(--vscode-input-background)',
	color: 'var(--vscode-input-foreground)',
	fontFamily: 'inherit',
	fontSize: 'inherit',
	outline: 'none',
} as const;

const COUNTER_STYLE = {
	minWidth: '64px',
	textAlign: 'center',
	opacity: 0.85,
	fontVariantNumeric: 'tabular-nums',
} as const;

const BUTTON_STYLE = {
	padding: '2px 8px',
	border: '1px solid var(--vscode-button-border, transparent)',
	borderRadius: '2px',
	background: 'var(--vscode-button-background)',
	color: 'var(--vscode-button-foreground)',
	fontFamily: 'inherit',
	fontSize: 'inherit',
	cursor: 'pointer',
} as const;

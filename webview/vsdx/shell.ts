/**
 * Viewer shell for vsdx diagrams (M1, read-only, van DOM — no React).
 *
 * Layout mirrors the other viewer chrome (DESIGN §7.3 / predecessor):
 *
 *   ┌ toolbar (35px): page nav · fit width · fit page · zoom select · − % + · layers ┐
 *   ├ page tab strip (one tab per `snapshot().pages[]`)                              ┤
 *   ├ canvas viewport (scrollable, pan with middle-drag or space+drag)               ┤
 *   │   ├ overlay: busy spinner / error banner                                       │
 *   │   └ layers panel (absolute, toggled from the toolbar)                          │
 *   └ status strip: page x/y · zoom % · hint                                          ┘
 *
 * Only the active page is laid out and painted (`PageRenderer`); the tab strip switches pages.
 */
import type { DiagramHandle } from '../../vendor/betteroffice/vsdx/src/wasm/loader';
import type { PageSnapshot } from '../../vendor/betteroffice/vsdx/src/types';
import type { ViewerWebviewConfig } from '../protocol';
import { LayersPanel } from './layersPanel';
import { PageRenderer } from './pageRenderer';
import { installShellStyles } from './styles';
import { errorText } from './util';
import { ZoomController } from './zoomController';

export type VsdxErrorPhase = 'init' | 'wasm' | 'open' | 'render';

export interface VsdxShellState {
	page: number;
	pageCount: number;
	zoom: number;
	scrollLeft: number;
	scrollTop: number;
}

export interface VsdxShellOptions {
	handle: DiagramHandle;
	config: ViewerWebviewConfig;
	fileName: string;
	onError?(phase: VsdxErrorPhase, message: string): void;
	onState?(state: VsdxShellState): void;
}

export interface VsdxShell {
	readonly element: HTMLElement;
	/** Builds page 0 at the configured initial zoom and resolves after its first frame. */
	renderInitial(): Promise<void>;
	dispose(): void;
}

const ZOOM_SELECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: 'fitPage', label: 'Fit page' },
	{ value: 'fitWidth', label: 'Fit width' },
	{ value: '50', label: '50%' },
	{ value: '100', label: '100%' },
	{ value: '150', label: '150%' },
	{ value: '200', label: '200%' },
];

export function mountVsdxShell(root: HTMLElement, options: VsdxShellOptions): VsdxShell {
	const doc = root.ownerDocument;
	installShellStyles(doc);

	const snapshot = options.handle.snapshot();
	const pages: PageSnapshot[] = snapshot.pages;
	if (pages.length === 0) throw new Error('the diagram contains no pages');

	/* ------------------------------------------------------------------ DOM */

	const shell = make(doc, 'div', 'vsdx-shell');
	shell.setAttribute('aria-label', `Visio diagram: ${options.fileName}`);

	const toolbar = make(doc, 'div', 'vsdx-toolbar');
	toolbar.setAttribute('role', 'toolbar');
	toolbar.setAttribute('aria-label', 'Visio viewer controls');

	const previousButton = toolbarButton(doc, '◀', 'Previous page (Left arrow)', () => void selectPage(activePage - 1));
	const positionLabel = make(doc, 'span', 'vsdx-position');
	positionLabel.setAttribute('aria-live', 'polite');
	const nextButton = toolbarButton(doc, '▶', 'Next page (Right arrow)', () => void selectPage(activePage + 1));
	const fitWidthButton = toolbarButton(doc, '↔', 'Fit width', () => zoom.fitWidth());
	const fitPageButton = toolbarButton(doc, '⤢', 'Fit page', () => zoom.fitPage());
	const zoomOutButton = toolbarButton(doc, '−', 'Zoom out (Ctrl+-)', () => zoom.zoomOut());
	const zoomLabel = make(doc, 'span', 'vsdx-zoom-label');
	zoomLabel.setAttribute('aria-live', 'polite');
	const zoomInButton = toolbarButton(doc, '+', 'Zoom in (Ctrl+=)', () => zoom.zoomIn());
	const layersButton = toolbarButton(doc, 'Layers', 'Show or hide layer visibility', () => {
		layers.setOpen(!layers.open);
		layersButton.setAttribute('aria-expanded', layers.open ? 'true' : 'false');
	});
	layersButton.setAttribute('aria-expanded', 'false');

	const zoomSelect = doc.createElement('select');
	zoomSelect.className = 'vsdx-zoom-select';
	zoomSelect.setAttribute('aria-label', 'Zoom level');
	for (const option of ZOOM_SELECT_OPTIONS) {
		const element = doc.createElement('option');
		element.value = option.value;
		element.textContent = option.label;
		zoomSelect.appendChild(element);
	}
	const customOption = doc.createElement('option');
	customOption.value = 'custom';
	customOption.disabled = true;
	zoomSelect.appendChild(customOption);
	zoomSelect.addEventListener('change', () => zoom.applySelectValue(zoomSelect.value));

	const separator = (): HTMLElement => make(doc, 'div', 'vsdx-separator');
	toolbar.append(
		previousButton,
		positionLabel,
		nextButton,
		separator(),
		fitWidthButton,
		fitPageButton,
		separator(),
		zoomOutButton,
		zoomLabel,
		zoomInButton,
		zoomSelect,
		separator(),
		layersButton,
	);

	const tabs = make(doc, 'div', 'vsdx-tabs');
	tabs.setAttribute('role', 'tablist');
	tabs.setAttribute('aria-label', 'Pages');
	const tabButtons = pages.map((page, index) => {
		const tab = doc.createElement('button');
		tab.type = 'button';
		tab.className = 'vsdx-tab';
		tab.setAttribute('role', 'tab');
		tab.textContent = pageTitle(page, index);
		tab.title = pageTitle(page, index);
		tab.addEventListener('click', () => void selectPage(index));
		tabs.appendChild(tab);
		return tab;
	});

	const body = make(doc, 'div', 'vsdx-body');
	const viewport = make(doc, 'div', 'vsdx-viewport');
	viewport.tabIndex = 0;
	viewport.setAttribute('role', 'region');
	viewport.setAttribute('aria-label', 'Diagram page');

	const overlay = make(doc, 'div', 'vsdx-overlay');
	const spinner = make(doc, 'div', 'vsdx-spinner');
	spinner.hidden = true;
	spinner.setAttribute('aria-hidden', 'true');
	const banner = make(doc, 'div', 'vsdx-banner');
	banner.hidden = true;
	banner.setAttribute('role', 'alert');
	overlay.append(spinner, banner);

	body.append(viewport, overlay);

	const status = make(doc, 'div', 'vsdx-status');
	status.setAttribute('role', 'status');
	const statusPage = make(doc, 'span', 'vsdx-status-page');
	const statusZoom = make(doc, 'span', 'vsdx-status-zoom');
	const statusHint = make(doc, 'span', 'vsdx-status-hint');
	statusHint.textContent = 'Ctrl+wheel zoom · middle-drag or Space+drag pan';
	status.append(statusPage, statusZoom, statusHint);

	shell.append(toolbar, tabs, body, status);
	positionLabel.textContent = `Page 1 of ${pages.length}`;
	statusPage.textContent = `Page 1 / ${pages.length}`;
	root.replaceChildren(shell);

	/* -------------------------------------------------------------- engines */

	let disposed = false;
	let activePage = 0;
	let spaceHeld = false;
	let stateFrame = 0;
	let detachPan: (() => void) | undefined;

	const renderer = new PageRenderer(options.handle, viewport, {
		onBusyChange: (busy) => {
			if (disposed) return;
			spinner.hidden = !busy;
			if (busy) hideBanner();
		},
		onWarning: (message) => console.warn(`[office-file-viewer] vsdx: ${message}`),
	});

	const zoom = new ZoomController(viewport, renderer, {
		onChange: () => {
			if (!disposed) syncZoom();
		},
		onError: (error) => reportRenderError(error),
		onWarning: (message) => console.warn(`[office-file-viewer] vsdx: ${message}`),
	});

	const layers = new LayersPanel(
		doc,
		options.handle,
		(index) => pages[index]?.sourcePartPath ?? '',
		{
			onLayersChanged: (pageIndex) => {
				renderer.invalidateLayout(pageIndex === 'all' ? undefined : pageIndex);
				refreshLayers();
				paint();
			},
			onError: (error) => {
				showBanner(errorText(error));
				options.onError?.('render', errorText(error));
			},
			onWarning: (message) => console.warn(`[office-file-viewer] vsdx: ${message}`),
		},
	);
	body.appendChild(layers.root);

	/* ------------------------------------------------------------- behavior */

	function pageTitle(page: PageSnapshot, index: number): string {
		const name = page.name?.trim();
		return name && name.length > 0 ? name : `Page ${index + 1}`;
	}

	function hideBanner(): void {
		banner.hidden = true;
		banner.textContent = '';
	}

	function showBanner(message: string): void {
		banner.textContent = message;
		banner.hidden = false;
	}

	function reportRenderError(error: unknown): void {
		if (disposed) return;
		const message = errorText(error);
		showBanner(message);
		options.onError?.('render', message);
	}

	function paint(): void {
		void renderer
			.render()
			.then(() => {
				if (!disposed) hideBanner();
			})
			.catch((error: unknown) => reportRenderError(error));
	}

	function syncTabs(): void {
		tabButtons.forEach((tab, index) => {
			tab.setAttribute('aria-selected', index === activePage ? 'true' : 'false');
			tab.tabIndex = index === activePage ? 0 : -1;
		});
		positionLabel.textContent = `Page ${activePage + 1} of ${pages.length}`;
		statusPage.textContent = `Page ${activePage + 1} / ${pages.length}`;
		previousButton.disabled = activePage <= 0;
		nextButton.disabled = activePage >= pages.length - 1;
	}

	function syncZoom(): void {
		const state = zoom.state();
		zoomLabel.textContent = `${state.percent}%`;
		statusZoom.textContent = `${state.percent}%`;
		if (state.mode === 'fitPage' || state.mode === 'fitWidth') {
			zoomSelect.value = state.mode;
		} else if (ZOOM_SELECT_OPTIONS.some((option) => option.value === String(state.percent))) {
			zoomSelect.value = String(state.percent);
		} else {
			customOption.textContent = `${state.percent}%`;
			zoomSelect.value = 'custom';
		}
		syncStatusTitle();
	}

	function syncStatusTitle(): void {
		status.title = `Page ${activePage + 1} of ${pages.length} · ${zoom.percent}%`;
	}

	function refreshLayers(): void {
		layers.refresh(activePage);
		layersButton.disabled = !layers.hasLayers;
		layersButton.setAttribute('aria-expanded', layers.open ? 'true' : 'false');
	}

	function syncAll(): void {
		syncTabs();
		syncZoom();
		refreshLayers();
	}

	async function selectPage(index: number): Promise<void> {
		if (disposed || index === activePage || index < 0 || index >= pages.length) return;
		activePage = index;
		syncTabs();
		try {
			renderer.setPageIndex(index);
			zoom.syncAfterPageChange();
			await renderer.render();
			syncAll();
			scheduleState();
		} catch (error) {
			reportRenderError(error);
		}
	}

	function scheduleState(): void {
		if (disposed || !options.onState || stateFrame !== 0) return;
		stateFrame = requestAnimationFrame(() => {
			stateFrame = 0;
			if (disposed) return;
			options.onState?.({
				page: activePage,
				pageCount: pages.length,
				zoom: zoom.percent,
				scrollLeft: viewport.scrollLeft,
				scrollTop: viewport.scrollTop,
			});
		});
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		if (isEditableTarget(event.target)) return;
		switch (event.key) {
			case ' ':
				if (!spaceHeld) {
					spaceHeld = true;
					viewport.classList.add('vsdx-grab');
					event.preventDefault();
				}
				return;
			case 'ArrowLeft':
			case 'PageUp':
				void selectPage(activePage - 1);
				return;
			case 'ArrowRight':
			case 'PageDown':
				void selectPage(activePage + 1);
				return;
			case '+':
			case '=':
				if (event.ctrlKey || event.metaKey) zoom.zoomIn();
				return;
			case '-':
				if (event.ctrlKey || event.metaKey) zoom.zoomOut();
				return;
			case '0':
				if (event.ctrlKey || event.metaKey) zoom.setPercent(100);
				return;
			default:
				return;
		}
	};

	const onKeyUp = (event: KeyboardEvent): void => {
		if (event.key !== ' ') return;
		spaceHeld = false;
		viewport.classList.remove('vsdx-grab');
	};

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 1 && !(event.button === 0 && spaceHeld)) return;
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const startLeft = viewport.scrollLeft;
		const startTop = viewport.scrollTop;
		viewport.classList.add('vsdx-panning');
		const onMove = (move: PointerEvent): void => {
			viewport.scrollLeft = startLeft - (move.clientX - startX);
			viewport.scrollTop = startTop - (move.clientY - startY);
		};
		const onUp = (): void => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			viewport.classList.remove('vsdx-panning');
			detachPan = undefined;
		};
		detachPan = onUp;
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	};

	const onAuxClick = (event: MouseEvent): void => {
		if (event.button === 1) event.preventDefault();
	};

	const onDocumentPointerDown = (event: Event): void => {
		if (!layers.open) return;
		const target = event.target;
		if (target instanceof Node && (layers.root.contains(target) || layersButton.contains(target))) return;
		layers.setOpen(false);
		layersButton.setAttribute('aria-expanded', 'false');
	};

	const onScroll = (): void => scheduleState();
	viewport.addEventListener('scroll', onScroll, { passive: true });
	viewport.addEventListener('pointerdown', onPointerDown);
	viewport.addEventListener('auxclick', onAuxClick);
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	doc.addEventListener('pointerdown', onDocumentPointerDown, true);

	/* ------------------------------------------------------------- lifecycle */

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		detachPan?.();
		if (stateFrame !== 0) cancelAnimationFrame(stateFrame);
		viewport.removeEventListener('scroll', onScroll);
		viewport.removeEventListener('pointerdown', onPointerDown);
		viewport.removeEventListener('auxclick', onAuxClick);
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
		layers.dispose();
		zoom.dispose();
		renderer.dispose();
		shell.remove();
	};

	return {
		element: shell,
		async renderInitial(): Promise<void> {
			renderer.setPageIndex(0);
			zoom.setInitial(options.config.initialZoom);
			await renderer.render();
			if (disposed) return;
			syncAll();
			scheduleState();
		},
		dispose,
	};
}

/* ------------------------------------------------------------------ helpers */

function make(doc: Document, tag: string, className: string): HTMLElement {
	const element = doc.createElement(tag);
	element.className = className;
	return element;
}

function toolbarButton(doc: Document, label: string, title: string, action: () => void): HTMLButtonElement {
	const button = doc.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.addEventListener('click', action);
	return button;
}

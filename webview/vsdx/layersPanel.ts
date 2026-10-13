/**
 * Layers panel for the vsdx shell.
 *
 * `handle.pageLayers(i)` returns the Visio layers of a page; `handle.setLayerVisible(pagePartPath,
 * layerIndex, visible)` toggles one and `handle.clearLayerVisibility()` restores the document
 * default for every page. Toggling changes the display list, so the owner must invalidate the
 * layout and repaint (`onLayersChanged`).
 */
import type { DiagramHandle } from '../../vendor/betteroffice/vsdx/src/wasm/loader';
import type { PageLayer } from '../../vendor/betteroffice/vsdx/src/types';
import { asError, errorText } from './util';

export interface LayersPanelCallbacks {
	/** `'all'` after `clearLayerVisibility()`, otherwise the page whose display list is stale. */
	onLayersChanged(pageIndex: number | 'all'): void;
	onError(error: Error): void;
	onWarning(message: string): void;
}

export class LayersPanel {
	private readonly handle: DiagramHandle;
	private readonly pagePartPath: (pageIndex: number) => string;
	private readonly callbacks: LayersPanelCallbacks;
	private readonly rootElement: HTMLElement;
	private readonly listElement: HTMLElement;
	private readonly resetButton: HTMLButtonElement;
	private readonly titleElement: HTMLElement;
	private pageIndexValue = 0;
	private layersValue: PageLayer[] = [];
	private disposed = false;

	constructor(
		doc: Document,
		handle: DiagramHandle,
		pagePartPath: (pageIndex: number) => string,
		callbacks: LayersPanelCallbacks,
	) {
		this.handle = handle;
		this.pagePartPath = pagePartPath;
		this.callbacks = callbacks;

		this.rootElement = doc.createElement('div');
		this.rootElement.className = 'vsdx-layers';
		this.rootElement.setAttribute('role', 'group');
		this.rootElement.setAttribute('aria-label', 'Layers');
		this.rootElement.hidden = true;

		const header = doc.createElement('div');
		header.className = 'vsdx-layers-header';
		this.titleElement = doc.createElement('span');
		this.titleElement.textContent = 'Layers';
		this.resetButton = doc.createElement('button');
		this.resetButton.type = 'button';
		this.resetButton.textContent = 'Reset';
		this.resetButton.title = 'Restore the document layer visibility';
		this.resetButton.addEventListener('click', () => this.reset());
		header.append(this.titleElement, this.resetButton);

		this.listElement = doc.createElement('div');
		this.listElement.className = 'vsdx-layers-list';
		this.rootElement.append(header, this.listElement);
	}

	get root(): HTMLElement {
		return this.rootElement;
	}

	get pageIndex(): number {
		return this.pageIndexValue;
	}

	get hasLayers(): boolean {
		return this.layersValue.length > 0;
	}

	/** Re-reads the layer table of `pageIndex` and rebuilds the checkbox list. */
	refresh(pageIndex: number): void {
		if (this.disposed) return;
		this.pageIndexValue = pageIndex;
		let layers: PageLayer[] = [];
		try {
			layers = this.handle.pageLayers(pageIndex);
		} catch (error) {
			this.callbacks.onWarning(`layer list unavailable for page ${pageIndex + 1}: ${errorText(error)}`);
		}
		this.layersValue = layers;
		this.titleElement.textContent = `Layers (${layers.length})`;
		this.rootElement.hidden = layers.length === 0;
		this.listElement.replaceChildren(...layers.map((layer) => this.row(layer)));
	}

	/** Shows/hides the panel without touching engine state (toolbar toggle). */
	setOpen(open: boolean): void {
		this.rootElement.hidden = !open || this.layersValue.length === 0;
	}

	get open(): boolean {
		return !this.rootElement.hidden;
	}

	dispose(): void {
		this.disposed = true;
		this.layersValue = [];
		this.rootElement.remove();
	}

	private row(layer: PageLayer): HTMLElement {
		const doc = this.rootElement.ownerDocument;
		const row = doc.createElement('label');
		row.className = 'vsdx-layer-row';
		row.title = layer.status ? `${layer.name} — ${layer.status}` : layer.name;

		const checkbox = doc.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = layer.visible;
		checkbox.disabled = layer.lock;
		checkbox.addEventListener('change', () => this.setVisible(layer, checkbox.checked));

		const name = doc.createElement('span');
		name.className = 'vsdx-layer-name';
		name.textContent = layer.name;
		row.append(checkbox, name);

		const meta = [layer.lock ? 'locked' : '', layer.print ? 'print' : '']
			.filter((part) => part.length > 0)
			.join(' · ');
		if (meta) {
			const metaElement = doc.createElement('span');
			metaElement.className = 'vsdx-layer-meta';
			metaElement.textContent = meta;
			row.appendChild(metaElement);
		}
		return row;
	}

	private setVisible(layer: PageLayer, visible: boolean): void {
		try {
			this.handle.setLayerVisible(this.pagePartPath(this.pageIndexValue), layer.index, visible);
			this.callbacks.onLayersChanged(this.pageIndexValue);
			this.refresh(this.pageIndexValue);
		} catch (error) {
			this.callbacks.onError(asError(error));
			this.refresh(this.pageIndexValue);
		}
	}

	private reset(): void {
		try {
			this.handle.clearLayerVisibility();
			this.callbacks.onLayersChanged('all');
			this.refresh(this.pageIndexValue);
		} catch (error) {
			this.callbacks.onError(asError(error));
		}
	}
}

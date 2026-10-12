/**
 * Zoom and fit math for the vsdx shell.
 *
 * Zoom is a plain scale factor applied to the page's display list; `canvasPointToModel` /
 * `modelPointToCanvas` (vendored, `vendor/betteroffice/vsdx/src/render/canvas.ts`) convert between
 * canvas-local CSS pixels and model units, which is what lets Ctrl+wheel keep the point under the
 * cursor fixed: the model point under the cursor is computed at the old scale, the canvas is
 * resized synchronously, and the viewport scroll offset is corrected so the same model point lands
 * under the cursor again at the new scale.
 */
import {
	canvasPointToModel,
	modelPointToCanvas,
	type ModelPoint,
} from '../../vendor/betteroffice/vsdx/src/index';
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, type PageRenderer } from './pageRenderer';
import { asError, clamp, errorText } from './util';

export type ZoomMode = 'fitPage' | 'fitWidth' | 'custom';

export interface ZoomState {
	scale: number;
	percent: number;
	mode: ZoomMode;
}

export interface ZoomCallbacks {
	onChange(state: ZoomState): void;
	onError(error: Error): void;
	onWarning(message: string): void;
}

/** Padding of `.vsdx-viewport` on both axes (16px each side, see styles.ts). */
const FIT_PADDING = 32;
/** Click step for the +/- buttons. */
const STEP_FACTOR = 1.25;
/** Wheel sensitivity per delta unit (pixel / line / page delta modes). */
const WHEEL_SENSITIVITY = { pixel: 0.0015, line: 0.05, page: 0.5 } as const;

export class ZoomController {
	private readonly viewport: HTMLElement;
	private readonly renderer: PageRenderer;
	private readonly callbacks: ZoomCallbacks;
	private modeValue: ZoomMode = 'custom';
	private disposeResizeObserver: (() => void) | undefined;

	constructor(viewport: HTMLElement, renderer: PageRenderer, callbacks: ZoomCallbacks) {
		this.viewport = viewport;
		this.renderer = renderer;
		this.callbacks = callbacks;
		viewport.addEventListener('wheel', this.onWheel, { passive: false });
		if (typeof ResizeObserver === 'function') {
			let lastWidth = viewport.clientWidth;
			let lastHeight = viewport.clientHeight;
			const observer = new ResizeObserver(() => {
				if (viewport.clientWidth === lastWidth && viewport.clientHeight === lastHeight) return;
				lastWidth = viewport.clientWidth;
				lastHeight = viewport.clientHeight;
				this.refit();
			});
			observer.observe(viewport);
			this.disposeResizeObserver = () => observer.disconnect();
		}
	}

	get mode(): ZoomMode {
		return this.modeValue;
	}

	get percent(): number {
		return Math.round(this.renderer.scale * 100);
	}

	state(): ZoomState {
		return { scale: this.renderer.scale, percent: this.percent, mode: this.modeValue };
	}

	/** Initial zoom requested by `officeFileViewer.initialZoom`. Does not paint. */
	setInitial(value: 'fitPage' | 'fitWidth' | '100'): void {
		if (value === 'fitPage') this.applyScale(this.fitScale('fitPage'), undefined, 'fitPage', false);
		else if (value === 'fitWidth') this.applyScale(this.fitScale('fitWidth'), undefined, 'fitWidth', false);
		else {
			this.modeValue = 'custom';
			this.renderer.setScale(1);
			this.emit();
		}
	}

	/** Re-applies fit mode after a page switch (or just re-emits for custom scale). */
	syncAfterPageChange(): void {
		if (this.modeValue === 'custom') return;
		this.applyScale(this.fitScale(this.modeValue), undefined, this.modeValue, false);
	}

	fitPage(): void {
		this.applyScale(this.fitScale('fitPage'), undefined, 'fitPage');
	}

	fitWidth(): void {
		this.applyScale(this.fitScale('fitWidth'), undefined, 'fitWidth');
	}

	/** Select value: `'fitPage' | 'fitWidth' | '50' | '100' | '150' | '200'`. */
	applySelectValue(value: string): void {
		if (value === 'fitPage') this.fitPage();
		else if (value === 'fitWidth') this.fitWidth();
		else {
			const percent = Number(value);
			if (!Number.isFinite(percent) || percent <= 0) return;
			this.setPercent(percent);
		}
	}

	setPercent(percent: number): void {
		this.applyScale(percent / 100, undefined, 'custom');
	}

	zoomIn(): void {
		this.applyScale(this.renderer.scale * STEP_FACTOR, undefined, 'custom');
	}

	zoomOut(): void {
		this.applyScale(this.renderer.scale / STEP_FACTOR, undefined, 'custom');
	}

	dispose(): void {
		this.viewport.removeEventListener('wheel', this.onWheel);
		this.disposeResizeObserver?.();
		this.disposeResizeObserver = undefined;
	}

	/** Fit scale for the active page: `fitWidth` only constrains width, `fitPage` also height. */
	private fitScale(mode: 'fitPage' | 'fitWidth'): number {
		const size = this.renderer.pageSize();
		const availableWidth = Math.max(1, this.viewport.clientWidth - FIT_PADDING);
		const availableHeight = Math.max(1, this.viewport.clientHeight - FIT_PADDING);
		const byWidth = size.width > 0 ? availableWidth / size.width : 1;
		if (mode === 'fitWidth' || !(size.height > 0)) return byWidth;
		return Math.min(byWidth, availableHeight / size.height);
	}

	private refit(): void {
		if (this.modeValue === 'custom') return;
		this.applyScale(this.fitScale(this.modeValue), undefined, this.modeValue, true);
	}

	private readonly onWheel = (event: WheelEvent): void => {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const sensitivity =
			event.deltaMode === 1 ? WHEEL_SENSITIVITY.line : event.deltaMode === 2 ? WHEEL_SENSITIVITY.page : WHEEL_SENSITIVITY.pixel;
		const factor = Math.exp(-event.deltaY * sensitivity);
		this.applyScale(this.renderer.scale * factor, { x: event.clientX, y: event.clientY }, 'custom', true);
	};

	private emit(): void {
		this.callbacks.onChange(this.state());
	}

	private paint(): void {
		void this.renderer.render().catch((error) => this.callbacks.onError(asError(error)));
	}

	/**
	 * Applies `target` (clamped), anchoring the viewport on `anchorClient` (client coordinates) or on
	 * the canvas center when omitted. `render: false` lets the caller batch the repaint.
	 */
	private applyScale(target: number, anchorClient: { x: number; y: number } | undefined, mode: ZoomMode, render = true): void {
		const clamped = clamp(target, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
		const anchor = anchorClient;		let model: ModelPoint | undefined;
		const list = this.renderer.layout();
		const before = this.renderer.canvasRect();
		const center = anchor ?? (before ? { x: before.left + before.width / 2, y: before.top + before.height / 2 } : undefined);
		if (before && center) {
			const x = center.x - before.left;
			const y = center.y - before.top;
			if (x >= -0.5 && y >= -0.5 && x <= before.width + 0.5 && y <= before.height + 0.5) {
				try {
					model = canvasPointToModel(list.paintTransform, x, y, this.renderer.scale);
				} catch (error) {
					this.callbacks.onWarning(`zoom anchor ignored: ${errorText(error)}`);
					model = undefined;
				}
			}
		}

		const scale = this.renderer.setScale(clamped);
		if (model && center) {
			const after = this.renderer.canvasRect();
			if (after) {
				const point = modelPointToCanvas(list.paintTransform, model.x, model.y, scale);
				this.viewport.scrollLeft += after.left + point.x - center.x;
				this.viewport.scrollTop += after.top + point.y - center.y;
			}
		}

		this.modeValue = mode;
		this.emit();
		if (render) this.paint();
	}
}

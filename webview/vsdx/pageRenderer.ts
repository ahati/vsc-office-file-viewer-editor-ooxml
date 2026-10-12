/**
 * Page renderer for the vsdx shell.
 *
 * Owns exactly one canvas (the active page) plus:
 *  - a small per-page cache of `PageDisplayList`s, because `handle.layoutPage(i)` re-runs the
 *    renderer in wasm and is the expensive half of a frame; the cache is invalidated when layer
 *    visibility changes (the display list depends on it),
 *  - a media (image) decode cache keyed by the engine's `assetId` (`handle.mediaBytes`).
 *
 * Sizing/painting follow the vendored helpers exactly: `sizeCanvasForPage(canvas, list, dpr, scale)`
 * returns the effective DPR (already clamped by `effectiveDprForSurface` to MAX_CANVAS_DIMENSION /
 * MAX_CANVAS_AREA) and must be handed to `paintPage(ctx, list, dpr, scale)` so the backing store and
 * the paint transform agree.
 */
import {
	MAX_CANVAS_AREA,
	MAX_CANVAS_DIMENSION,
	paintPage,
	sizeCanvasForPage,
	type DiagramHandle,
	type PageDisplayList,
} from '../../vendor/betteroffice/vsdx/src/index';
import { errorText } from './util';

/** Lowest zoom we ever hand to the canvas (pages can be arbitrarily large). */
export const MIN_ZOOM_SCALE = 0.02;
/** Highest user zoom; fit/step math clamps to `maxScale()` as well. */
export const MAX_ZOOM_SCALE = 4;
/** Display lists are large; keep a few around for fast page flips, not the whole document. */
const MAX_CACHED_LAYOUTS = 4;

export interface PageRendererCallbacks {
	/** Fired around an actual `paintPage` call so the shell can show its spinner. */
	onBusyChange?(busy: boolean): void;
	/** Non-fatal issues (undecodable image, aborted paint) — the frame still completes. */
	onWarning?(message: string): void;
}

interface SurfaceSize {
	width: number;
	height: number;
}

export class PageRenderer {
	private readonly handle: DiagramHandle;
	private readonly host: HTMLElement;
	private readonly callbacks: PageRendererCallbacks;
	private readonly layouts = new Map<number, PageDisplayList>();
	private readonly images = new Map<string, CanvasImageSource | null>();
	private readonly pendingImages = new Map<string, Promise<CanvasImageSource | null>>();
	private canvas: HTMLCanvasElement | undefined;
	private context: CanvasRenderingContext2D | null = null;
	private paintAbort: AbortController | undefined;
	private renderToken = 0;
	private pageIndexValue = 0;
	private scaleValue = 1;
	private pixelRatioValue = 1;
	private disposed = false;

	constructor(handle: DiagramHandle, host: HTMLElement, callbacks: PageRendererCallbacks = {}) {
		this.handle = handle;
		this.host = host;
		this.callbacks = callbacks;
	}

	get pageIndex(): number {
		return this.pageIndexValue;
	}

	get scale(): number {
		return this.scaleValue;
	}

	/** Effective (possibly clamped) DPR used by the last canvas sizing. */
	get pixelRatio(): number {
		return this.pixelRatioValue;
	}

	get canvasElement(): HTMLCanvasElement | undefined {
		return this.canvas;
	}

	/** Bounding box of the canvas in client coordinates; `null` before the first sizing. */
	canvasRect(): DOMRect | null {
		return this.canvas?.getBoundingClientRect() ?? null;
	}

	/** Display list for `pageIndex`, laid out on first use and cached afterwards. */
	layout(pageIndex: number = this.pageIndexValue): PageDisplayList {
		if (this.disposed) throw new Error('vsdx page renderer is disposed');
		const cached = this.layouts.get(pageIndex);
		if (cached) return cached;
		const list = this.handle.layoutPage(pageIndex);
		this.rememberLayout(pageIndex, list);
		return list;
	}

	pageSize(pageIndex: number = this.pageIndexValue): SurfaceSize {
		const list = this.layout(pageIndex);
		return { width: list.width, height: list.height };
	}

	/**
	 * Largest zoom whose canvas stays inside the backing-store budgets. `sizeCanvasForPage` clamps
	 * the DPR too, so this only bounds the CSS surface (blurry instead of broken beyond it).
	 */
	maxScale(pageIndex: number = this.pageIndexValue): number {
		const size = this.pageSize(pageIndex);
		if (!(size.width > 0) || !(size.height > 0)) return MAX_ZOOM_SCALE;
		const bySide = Math.min(MAX_CANVAS_DIMENSION / size.width, MAX_CANVAS_DIMENSION / size.height);
		const byArea = Math.sqrt(MAX_CANVAS_AREA / (size.width * size.height));
		const budget = Math.min(bySide, byArea);
		return Math.max(Math.min(MAX_ZOOM_SCALE, budget), MIN_ZOOM_SCALE);
	}

	/** Clamps `scale` into `[MIN_ZOOM_SCALE, maxScale()]`. */
	clampScale(scale: number): number {
		const max = this.maxScale();
		const min = Math.min(MIN_ZOOM_SCALE, max);
		if (!Number.isFinite(scale)) return min;
		return Math.min(Math.max(scale, min), max);
	}

	/** Switches the active page without painting (the caller drives `render()`). */
	setPageIndex(pageIndex: number): void {
		this.pageIndexValue = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
	}

	/**
	 * Applies `scale` synchronously: the canvas CSS box and backing store are resized immediately
	 * (so anchor-preserving zoom can measure the new layout), then the caller repaints.
	 * Returns the clamped scale that was applied.
	 */
	setScale(scale: number): number {
		const clamped = this.clampScale(scale);
		this.scaleValue = clamped;
		const canvas = this.ensureCanvas();
		const list = this.layout();
		this.pixelRatioValue = sizeCanvasForPage(canvas, surfaceSize(list), currentDevicePixelRatio(), clamped);
		return clamped;
	}

	/** Lays out (if needed) and paints the active page; rejects on layout/paint failure. */
	async render(): Promise<void> {
		if (this.disposed) return;
		const token = ++this.renderToken;
		this.paintAbort?.abort();
		const abort = new AbortController();
		this.paintAbort = abort;
		const list = this.layout();
		const canvas = this.ensureCanvas();
		this.pixelRatioValue = sizeCanvasForPage(canvas, surfaceSize(list), currentDevicePixelRatio(), this.scaleValue);
		const context = this.context ?? canvas.getContext('2d');
		if (!context) throw new Error('failed to acquire a 2D canvas context');
		this.context = context;
		this.callbacks.onBusyChange?.(true);
		try {
			await paintPage(context, list, this.pixelRatioValue, this.scaleValue, {
				signal: abort.signal,
				resolveImage: (assetId) => this.resolveImage(assetId),
			});
		} finally {
			if (token === this.renderToken) this.callbacks.onBusyChange?.(false);
		}
	}

	/**
	 * Drops cached display lists. `pageIndex` limits the invalidation to one page; omit it to drop
	 * everything (used after `clearLayerVisibility()`).
	 */
	invalidateLayout(pageIndex?: number): void {
		if (pageIndex === undefined) this.layouts.clear();
		else this.layouts.delete(pageIndex);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.renderToken += 1;
		this.paintAbort?.abort();
		this.paintAbort = undefined;
		for (const image of this.images.values()) closeImage(image);
		this.images.clear();
		this.pendingImages.clear();
		this.layouts.clear();
		this.context = null;
		this.canvas?.remove();
		this.canvas = undefined;
	}

	private ensureCanvas(): HTMLCanvasElement {
		if (this.canvas) return this.canvas;
		const canvas = this.host.ownerDocument.createElement('canvas');
		canvas.className = 'vsdx-canvas';
		canvas.setAttribute('role', 'img');
		canvas.setAttribute('aria-label', 'Visio page');
		this.host.appendChild(canvas);
		this.canvas = canvas;
		return canvas;
	}

	private rememberLayout(pageIndex: number, list: PageDisplayList): void {
		this.layouts.delete(pageIndex);
		this.layouts.set(pageIndex, list);
		while (this.layouts.size > MAX_CACHED_LAYOUTS) {
			const oldest = this.layouts.keys().next().value;
			if (oldest === undefined || oldest === this.pageIndexValue) break;
			this.layouts.delete(oldest);
		}
	}

	private resolveImage(assetId: string): CanvasImageSource | null | Promise<CanvasImageSource | null> {
		const cached = this.images.get(assetId);
		if (cached !== undefined) return cached;
		let pending = this.pendingImages.get(assetId);
		if (!pending) {
			pending = this.decodeImage(assetId);
			this.pendingImages.set(assetId, pending);
			void pending.finally(() => this.pendingImages.delete(assetId));
		}
		return pending;
	}

	private async decodeImage(assetId: string): Promise<CanvasImageSource | null> {
		try {
			const bytes = this.handle.mediaBytes(assetId);
			const mime = sniffImageMime(bytes);
			if (!mime) {
				this.callbacks.onWarning?.(`unsupported media asset ${assetId} (not a decodable raster image)`);
				this.images.set(assetId, null);
				return null;
			}
			const bitmap = await createImageBitmap(new Blob([toArrayBuffer(bytes)], { type: mime }));
			if (this.disposed) {
				closeImage(bitmap);
				return null;
			}
			this.images.set(assetId, bitmap);
			return bitmap;
		} catch (error) {
			this.callbacks.onWarning?.(`failed to decode media asset ${assetId}: ${errorText(error)}`);
			this.images.set(assetId, null);
			return null;
		}
	}
}

/** `sizeCanvasForPage` rejects non-positive sizes; a degenerate page still gets a 1px surface. */
function surfaceSize(list: Pick<PageDisplayList, 'width' | 'height'>): SurfaceSize {
	return { width: Math.max(1, list.width), height: Math.max(1, list.height) };
}

function currentDevicePixelRatio(): number {
	const value = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
	return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Blob parts must own an `ArrayBuffer` (wasm views may alias the wasm memory). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

/** Raster formats `createImageBitmap` can decode; Visio metafiles (EMF/WMF) cannot and are skipped. */
function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength < 12) return undefined;
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
	return undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	let value = '';
	for (let index = offset; index < offset + length && index < bytes.byteLength; index += 1) {
		value += String.fromCharCode(bytes[index]);
	}
	return value;
}

function closeImage(image: CanvasImageSource | null): void {
	if (image && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
}

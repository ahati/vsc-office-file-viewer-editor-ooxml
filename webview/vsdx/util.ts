/**
 * Small shared helpers for the vsdx viewer shell.
 */

/** Normalizes an unknown thrown value to an Error (for `instanceof`-free reporting). */
export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(errorText(error));
}

/** Human-readable message for an unknown thrown value. */
export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === 'string') return error;
	try {
		const text = JSON.stringify(error);
		return text === undefined ? String(error) : text;
	} catch {
		return String(error);
	}
}

/** Clamps a number into `[min, max]`; non-finite input falls back to `min`. */
export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(value, min), max);
}

/** Rounds to one decimal place for timing payloads. */
export function roundMs(value: number): number {
	return Math.round(value * 10) / 10;
}

import * as vscode from 'vscode';

/**
 * Settings snapshot handed to the webview. Mirrors `ViewerWebviewConfig` in `src/protocol.ts`
 * (keep the two in sync) so the host never imports webview sources.
 */
export interface ViewerWebviewConfig {
	editing: boolean;
	forceReadOnly: boolean;
	fonts: 'bundled' | 'off';
	cjkFonts: 'off' | 'cdn';
	initialZoom: 'fitPage' | 'fitWidth' | '100';
}

/** Reads `officeFileViewer.*` once per editor resolution. */
export function getViewerWebviewConfig(): ViewerWebviewConfig {
	const config = vscode.workspace.getConfiguration('officeFileViewer');
	const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
		const value = config.get<string>(key, fallback);
		return allowed.includes(value as T) ? (value as T) : fallback;
	};
	return {
		editing: config.get<boolean>('editing', true),
		forceReadOnly: config.get<boolean>('forceReadOnly', false),
		fonts: pick('fonts', ['bundled', 'off'] as const, 'bundled'),
		cjkFonts: pick('cjkFonts', ['off', 'cdn'] as const, 'off'),
		initialZoom: pick('initialZoom', ['fitPage', 'fitWidth', '100'] as const, 'fitPage'),
	};
}

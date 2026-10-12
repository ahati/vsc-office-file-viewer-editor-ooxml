/**
 * Theme-aware stylesheet for the vsdx viewer shell.
 *
 * All colors come from `var(--vscode-*)` so the shell follows the active VS Code theme; the layout
 * mirrors the predecessor viewer's chrome (35px toolbar, scrollable canvas viewport, status strip).
 * The sheet is injected once per webview document by `installShellStyles`.
 */

const STYLE_ELEMENT_ID = 'vsdx-shell-styles';

export const SHELL_CSS = `
.vsdx-shell {
	position: relative;
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	min-height: 0;
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family, sans-serif);
	font-size: 12px;
	overflow: hidden;
}
.vsdx-shell:focus { outline: none; }
.vsdx-shell :focus-visible {
	outline: 1px solid var(--vscode-focusBorder);
	outline-offset: -1px;
}
.vsdx-toolbar {
	flex: 0 0 35px;
	height: 35px;
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 8px;
	overflow-x: auto;
	overflow-y: hidden;
	border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
	user-select: none;
	white-space: nowrap;
}
.vsdx-toolbar button {
	min-width: 26px;
	height: 24px;
	padding: 0 6px;
	border: 1px solid transparent;
	border-radius: 3px;
	color: var(--vscode-foreground);
	background: transparent;
	font: 14px/1 var(--vscode-font-family, sans-serif);
	cursor: pointer;
}
.vsdx-toolbar button:hover:not(:disabled) {
	background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.2));
}
.vsdx-toolbar button:disabled { cursor: default; opacity: 0.4; }
.vsdx-toolbar select {
	height: 24px;
	max-width: 110px;
	padding: 0 4px;
	border: 1px solid var(--vscode-dropdown-border, transparent);
	border-radius: 3px;
	color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
	background: var(--vscode-dropdown-background, var(--vscode-editor-background));
	font: 12px/1 var(--vscode-font-family, sans-serif);
}
.vsdx-separator {
	width: 1px;
	height: 18px;
	margin: 0 4px;
	flex: 0 0 1px;
	background: var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
}
.vsdx-position, .vsdx-zoom-label {
	min-width: 78px;
	text-align: center;
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.vsdx-zoom-label { min-width: 44px; }
.vsdx-tabs {
	flex: 0 0 28px;
	height: 28px;
	display: flex;
	align-items: stretch;
	gap: 2px;
	padding: 0 6px;
	overflow-x: auto;
	overflow-y: hidden;
	border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
	user-select: none;
}
.vsdx-tab {
	max-width: 220px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding: 0 10px;
	border: 1px solid transparent;
	border-bottom: none;
	border-radius: 4px 4px 0 0;
	color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
	background: transparent;
	font: 12px/26px var(--vscode-font-family, sans-serif);
	cursor: pointer;
}
.vsdx-tab:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.2)); }
.vsdx-tab[aria-selected='true'] {
	color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
	background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
	border-color: var(--vscode-tab-activeBorderTop, var(--vscode-panel-border, transparent));
}
.vsdx-body {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
}
.vsdx-viewport {
	position: absolute;
	inset: 0;
	display: flex;
	overflow: auto;
	padding: 16px;
	background: var(--vscode-editor-background);
}
.vsdx-viewport:focus { outline: none; }
.vsdx-viewport.vsdx-grab { cursor: grab; }
.vsdx-viewport.vsdx-panning { cursor: grabbing; }
.vsdx-canvas {
	flex: none;
	display: block;
	margin: auto;
	background: #ffffff;
	box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
}
.vsdx-overlay {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	pointer-events: none;
	z-index: 10;
}
.vsdx-spinner {
	position: absolute;
	top: 50%;
	left: 50%;
	width: 28px;
	height: 28px;
	margin: -14px 0 0 -14px;
	border: 3px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
	border-top-color: var(--vscode-progressBar-background, var(--vscode-foreground));
	border-radius: 50%;
	animation: vsdx-spin 0.9s linear infinite;
}
@keyframes vsdx-spin { to { transform: rotate(360deg); } }
.vsdx-banner {
	pointer-events: auto;
	margin-top: 10px;
	max-width: min(720px, 90%);
	padding: 6px 10px;
	border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
	border-radius: 4px;
	background: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
	color: var(--vscode-errorForeground, #f44747);
	font-size: 12px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
}
.vsdx-layers {
	position: absolute;
	z-index: 20;
	top: 8px;
	right: 8px;
	width: min(280px, 80%);
	max-height: 70%;
	overflow: auto;
	padding: 6px 8px;
	border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	border-radius: 4px;
	background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
	box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
}
.vsdx-layers-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding-bottom: 4px;
	margin-bottom: 4px;
	border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
	font-weight: 600;
}
.vsdx-layers-header button {
	height: 20px;
	padding: 0 6px;
	border: 1px solid transparent;
	border-radius: 3px;
	color: inherit;
	background: transparent;
	font: 11px/1 var(--vscode-font-family, sans-serif);
	cursor: pointer;
}
.vsdx-layers-header button:hover:not(:disabled) {
	background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.2));
}
.vsdx-layer-row {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 3px 2px;
	cursor: pointer;
}
.vsdx-layer-row:hover { background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.15)); }
.vsdx-layer-name {
	flex: 1 1 auto;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.vsdx-layer-meta { opacity: 0.65; font-size: 10px; }
.vsdx-status {
	flex: 0 0 22px;
	height: 22px;
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 0 8px;
	overflow: hidden;
	border-top: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.35));
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
	color: var(--vscode-descriptionForeground, var(--vscode-foreground));
	font-size: 11px;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.vsdx-status-hint { margin-left: auto; opacity: 0.75; }
.vsdx-fatal {
	display: flex;
	flex-direction: column;
	gap: 6px;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	padding: 24px;
	text-align: center;
	color: var(--vscode-errorForeground, #f44747);
	background: var(--vscode-editor-background);
	font-family: var(--vscode-font-family, sans-serif);
}
.vsdx-fatal-phase { font-size: 11px; opacity: 0.8; }
.vsdx-fatal-message { max-width: 640px; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

/** Injects the shell stylesheet into `doc` once; safe to call from every mount. */
export function installShellStyles(doc: Document): void {
	if (doc.getElementById(STYLE_ELEMENT_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ELEMENT_ID;
	style.textContent = SHELL_CSS;
	(doc.head ?? doc.documentElement).appendChild(style);
}

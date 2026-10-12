/**
 * Structured error panel (DESIGN §4.3 / PRD V6) plus the status-overlay helpers.
 *
 * Vanilla DOM (no React): every entry uses it, including the ones whose engine failed to load, so it
 * must not depend on the engine bundles or on React being mounted. Styling is theme-aware through
 * the `--vscode-*` custom properties the webview host provides.
 */

const PANEL_ID = 'bo-error-panel';

/**
 * Renders the phase + message + "Copy diagnostics" panel into `#viewer-root` (the host HTML owns
 * that element; `#root` is accepted as a fallback for non-VS Code harnesses).
 */
export function renderErrorPanel(phase: string, message: string): void {
	const host = resolveHost();
	if (!host) return;

	setStatus('error');
	document.getElementById(PANEL_ID)?.remove();

	const panel = document.createElement('div');
	panel.id = PANEL_ID;
	panel.setAttribute('role', 'alert');
	panel.style.cssText = [
		'position:absolute',
		'inset:0',
		'display:flex',
		'flex-direction:column',
		'gap:10px',
		'align-items:flex-start',
		'justify-content:center',
		'padding:24px',
		'overflow:auto',
		'background:var(--vscode-editor-background)',
		'color:var(--vscode-foreground)',
		'font-family:var(--vscode-font-family, sans-serif)',
		'font-size:13px',
		'z-index:10',
	].join(';');

	const title = document.createElement('div');
	title.textContent = 'Unable to open this file';
	title.style.cssText = 'font-size:15px;font-weight:600;color:var(--vscode-errorForeground, #f44747)';
	panel.append(title);

	const detail = document.createElement('pre');
	detail.textContent = `phase: ${phase}\n${message}`;
	detail.style.cssText = [
		'margin:0',
		'max-width:min(880px, 100%)',
		'white-space:pre-wrap',
		'word-break:break-word',
		'font-family:var(--vscode-editor-font-family, monospace)',
		'font-size:12px',
		'opacity:0.9',
	].join(';');
	panel.append(detail);

	const copy = document.createElement('button');
	copy.type = 'button';
	copy.textContent = 'Copy diagnostics';
	copy.style.cssText = [
		'padding:4px 10px',
		'border:1px solid var(--vscode-button-border, transparent)',
		'border-radius:2px',
		'background:var(--vscode-button-background)',
		'color:var(--vscode-button-foreground)',
		'font-family:inherit',
		'font-size:12px',
		'cursor:pointer',
	].join(';');
	copy.addEventListener('click', () => {
		void navigator.clipboard
			?.writeText(diagnosticsText(phase, message))
			.then(() => {
				copy.textContent = 'Copied';
			})
			.catch(() => {
				copy.textContent = 'Copy failed';
			});
	});
	panel.append(copy);

	// The copy target also carries the raw message, for hosts without clipboard permission.
	const fallback = document.createElement('textarea');
	fallback.value = diagnosticsText(phase, message);
	fallback.setAttribute('aria-label', 'Diagnostics');
	fallback.style.cssText =
		'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;';
	panel.append(fallback);

	host.append(panel);
	// Keep the spinner out of the way while the panel is up.
	document.getElementById('status')?.setAttribute('data-state', 'idle');
}

/** The diagnostics blob the panel copies (also handy for the extension-host log). */
export function diagnosticsText(phase: string, message: string): string {
	const format = (globalThis as { __BO_FORMAT__?: unknown }).__BO_FORMAT__;
	return [
		'BetterOffice Viewer — load failure',
		`format: ${typeof format === 'string' ? format : 'unknown'}`,
		`phase: ${phase}`,
		`user agent: ${navigator.userAgent}`,
		`time: ${new Date().toISOString()}`,
		'',
		message,
	].join('\n');
}

/** Drives the host-provided `#status` overlay (`busy` | `idle` | `error`). */
export function setStatus(state: 'busy' | 'idle' | 'error', text?: string): void {
	const status = document.getElementById('status');
	if (!status) return;
	status.setAttribute('data-state', state);
	if (text !== undefined) status.textContent = text;
}

/** Removes the error panel (used when a reload succeeds after a previous failure). */
export function clearErrorPanel(): void {
	document.getElementById(PANEL_ID)?.remove();
}

/** `#viewer-root` is the host HTML's mount element; `#root` keeps headless harnesses working. */
export function resolveHost(): HTMLElement | undefined {
	return document.getElementById('viewer-root') ?? document.getElementById('root') ?? undefined;
}

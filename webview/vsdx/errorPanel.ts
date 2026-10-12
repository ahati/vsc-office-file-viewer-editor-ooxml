/**
 * Fatal-error panel for the vsdx viewer.
 *
 * Shown in `#viewer-root` when the diagram never reaches its first frame (wasm glue missing, wasm
 * compile failure, package parse failure, ...). The phase name mirrors the `load-error` message the
 * entry posts to the host so diagnostics and the UI agree.
 */
import { installShellStyles } from './styles';

export function showFatalError(root: HTMLElement, phase: string, message: string): void {
	installShellStyles(root.ownerDocument);
	const panel = root.ownerDocument.createElement('div');
	panel.className = 'vsdx-fatal';
	panel.setAttribute('role', 'alert');

	const title = root.ownerDocument.createElement('div');
	title.textContent = 'Visio diagram could not be displayed';

	const phaseLabel = root.ownerDocument.createElement('div');
	phaseLabel.className = 'vsdx-fatal-phase';
	phaseLabel.textContent = `phase: ${phase}`;

	const detail = root.ownerDocument.createElement('div');
	detail.className = 'vsdx-fatal-message';
	detail.textContent = message;

	panel.append(title, phaseLabel, detail);
	root.replaceChildren(panel);
}

import * as vscode from 'vscode';
import { OfficeProvider, type ViewerFormat } from './providers/officeProvider';

/**
 * Extension entry point.
 *
 * Registers one read-only custom editor per format family and the three diagnostics commands
 * (DESIGN §9/§10). Everything disposable goes through `context.subscriptions`.
 */
export function activate(context: vscode.ExtensionContext): void {
	for (const format of OfficeProvider.FORMATS) {
		context.subscriptions.push(OfficeProvider.register(context, format));
	}
	OfficeProvider.log(`activated (${OfficeProvider.FORMATS.join(', ')})`);

	context.subscriptions.push(
		vscode.commands.registerCommand('betterofficeViewer.getDiagnostics', () => {
			const lines = OfficeProvider.getDiagnostics();
			OfficeProvider.log(`getDiagnostics -> ${lines.length} entries`);
			OfficeProvider.getOutputChannel().show(true);
			return lines;
		}),

		vscode.commands.registerCommand('betterofficeViewer.reload', () => {
			if (!OfficeProvider.hasActiveViewers()) {
				void vscode.window.showInformationMessage('BetterOffice Viewer: no open viewer to reload.');
				return;
			}
			const count = OfficeProvider.reloadActiveViewers();
			OfficeProvider.log(`reload requested for ${count} viewer(s)`);
		}),

		vscode.commands.registerCommand('betterofficeViewer.copyDiagnostics', async () => {
			const lines = OfficeProvider.getDiagnostics();
			await vscode.env.clipboard.writeText(lines.join('\n'));
			void vscode.window.showInformationMessage(
				`BetterOffice Viewer: copied ${lines.length} diagnostics entries to the clipboard.`,
			);
		}),
	);
}

export function deactivate(): void {
	// Nothing to clean up: providers and commands are disposed via context.subscriptions.
}

export type { ViewerFormat };

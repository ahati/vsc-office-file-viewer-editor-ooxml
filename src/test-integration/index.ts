/**
 * Integration suite (DESIGN §12) — executed *inside the extension host* by `@vscode/test-electron`
 * (`scripts/run-tests.mjs` opens `samples/` as the workspace and loads
 * `out/test/integration.js`, built by the `integrationTestConfig` target in `scripts/build.mjs`).
 *
 * Scope for M1:
 *   1. every format opens its sample through `vscode.openWith` and reaches a real engine render
 *      (`loaded`) without a `load-error` — covering asset bootstrap, wasm compile, worker spawn
 *      (docx) and first-frame paint,
 *   2. an external file change (xlsx) re-renders the open viewer (host `FileSystemWatcher`),
 *   3. diagnostics/command sanity: `getDiagnostics` returns an array and `copyDiagnostics` resolves.
 *
 * The host reports every lifecycle step through the shared diagnostics ring
 * (`OfficeProvider.log`), so this suite is driven purely by the `officeFileViewer.getDiagnostics`
 * command — no test-only hooks inside the extension.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'ahati.office-file-editor-viewer';
const DIAGNOSTICS_COMMAND = 'officeFileViewer.getDiagnostics';
const COPY_DIAGNOSTICS_COMMAND = 'officeFileViewer.copyDiagnostics';

const VIEW_TYPES = {
	docx: 'officeFileViewer.docx',
	xlsx: 'officeFileViewer.xlsx',
	pptx: 'officeFileViewer.pptx',
	vsdx: 'officeFileViewer.vsdx',
} as const;
type Format = keyof typeof VIEW_TYPES;
const FORMATS: readonly Format[] = ['docx', 'xlsx', 'pptx', 'vsdx'];

/** Sample per format (workspace root = `samples/`, see scripts/run-tests.mjs). */
const SAMPLES: Record<Format, string> = {
	docx: 'sample.docx',
	xlsx: 'sample.xlsx',
	pptx: 'sample.pptx',
	vsdx: 'sample.vsdx',
};

/**
 * docx compiles four wasm modules on the main thread (~30 MB) *and* in its engine worker, so the
 * first render is the slowest path in the suite; N1 budgets are measured from the `loaded`
 * timings, not from this ceiling.
 */
const LOAD_TIMEOUT_MS = 120_000;
const RELOAD_TIMEOUT_MS = 60_000;
const TAB_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
/** If the workspace.fs write is coalesced by the watcher, force an OS-level write after this. */
const RELOAD_FALLBACK_MS = 15_000;

/** Host log lines this suite depends on (src/providers/officeProvider.ts). */
const RENDERED_MARKER = 'rendered ';
const FAILED_MARKER = 'render FAILED for ';
const FILE_CHANGED_MARKER = 'file changed on disk: ';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All diagnostics lines (oldest first) as returned by the host command. */
async function getDiagnostics(): Promise<string[]> {
	const result = (await vscode.commands.executeCommand(DIAGNOSTICS_COMMAND)) as unknown;
	if (!Array.isArray(result) || result.some((line) => typeof line !== 'string')) {
		throw new Error(`${DIAGNOSTICS_COMMAND} did not return a string[]`);
	}
	return result as string[];
}

/** `[2026-…Z] rendered sample.docx timings={…}` -> the rendered lines for `fileName`, in order. */
function renderedLines(lines: readonly string[], fileName: string): string[] {
	return lines.filter((line) => line.includes(`${RENDERED_MARKER}${fileName} `));
}

function failureLines(lines: readonly string[], fileName: string): string[] {
	return lines.filter((line) => line.includes(FAILED_MARKER) && line.includes(fileName));
}

/** Timestamp (`Date.parse`) of a host log line, or 0 when unparseable. */
function lineTimestamp(line: string): number {
	const match = line.match(/^\[([^\]]+)\]/);
	return match ? Date.parse(match[1]) : 0;
}

/** The `timings` record of a `loaded` line (empty when absent/malformed). */
export function timingsOf(line: string): Record<string, number> {
	const match = line.match(/timings=(\{.*\})\s*$/);
	if (!match) return {};
	try {
		const parsed = JSON.parse(match[1]) as Record<string, number>;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/** Compact `timings` rendering for the console report (ms values, integer-rounded). */
function formatTimings(timings: Record<string, number>): string {
	const entries = Object.entries(timings);
	if (entries.length === 0) return '(none)';
	return entries.map(([phase, ms]) => `${phase}=${Math.round(ms)}ms`).join(' ');
}

function tail(lines: readonly string[], count = 12): string {
	return lines.slice(-count).join('\n') || '(no diagnostics)';
}

/** Waits for at least `minCount` renders of `fileName`; fails fast on a `load-error` for it. */
async function waitForRender(
	fileName: string,
	minCount: number,
	timeoutMs: number,
	what: string,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	let lines: string[] = [];
	while (Date.now() < deadline) {
		lines = await getDiagnostics();
		const failures = failureLines(lines, fileName);
		if (failures.length > 0) {
			throw new Error(`${what} failed for ${fileName}:\n${failures.join('\n')}\n--- tail ---\n${tail(lines)}`);
		}
		if (renderedLines(lines, fileName).length >= minCount) return lines;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out after ${timeoutMs} ms waiting for ${what} (${fileName}).\n--- tail ---\n${tail(lines)}`,
	);
}

/** Waits for a render of `fileName` logged strictly after `since` (robust against ring rotation). */
async function waitForRenderAfter(
	fileName: string,
	since: number,
	timeoutMs: number,
	what: string,
): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	let lines: string[] = [];
	while (Date.now() < deadline) {
		lines = await getDiagnostics();
		const failures = failureLines(lines, fileName);
		if (failures.length > 0) {
			throw new Error(`${what} failed for ${fileName}:\n${failures.join('\n')}\n--- tail ---\n${tail(lines)}`);
		}
		const fresh = renderedLines(lines, fileName).filter((line) => lineTimestamp(line) >= since);
		if (fresh.length > 0) return lines;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`Timed out after ${timeoutMs} ms waiting for ${what} (${fileName}, since ${new Date(since).toISOString()}).\n` +
			`--- tail ---\n${tail(lines)}`,
	);
}

/** Open custom-editor tabs for a view type (optionally a single document URI). */
function customTabs(viewType: string, uri?: vscode.Uri): vscode.Tab[] {
	const tabs: vscode.Tab[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (!(input instanceof vscode.TabInputCustom)) continue;
			if (input.viewType !== viewType) continue;
			if (uri && input.uri.toString() !== uri.toString()) continue;
			tabs.push(tab);
		}
	}
	return tabs;
}

async function openViewer(format: Format, uri: vscode.Uri): Promise<void> {
	await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPES[format]);
	const deadline = Date.now() + TAB_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (customTabs(VIEW_TYPES[format], uri).length > 0) return;
		await sleep(200);
	}
	throw new Error(`no ${VIEW_TYPES[format]} tab appeared for ${uri.fsPath} within ${TAB_TIMEOUT_MS} ms`);
}

async function closeViewer(format: Format, uri: vscode.Uri): Promise<void> {
	const tabs = customTabs(VIEW_TYPES[format], uri);
	if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
	// Give the host a moment to log `disposed` before the next format opens.
	await sleep(250);
}

/** Opens `format`'s sample, waits for a render, records its `timings`, and closes the tab. */
async function testFormat(samplesDir: string, format: Format): Promise<string> {
	const fileName = SAMPLES[format];
	const uri = vscode.Uri.file(path.join(samplesDir, fileName));

	await openViewer(format, uri);
	const lines = await waitForRender(fileName, 1, LOAD_TIMEOUT_MS, 'the first render');
	const loaded = renderedLines(lines, fileName);
	const timings = timingsOf(loaded[loaded.length - 1]);
	const report = `${format}: loaded (${loaded.length} render${loaded.length === 1 ? '' : 's'}) timings: ${formatTimings(timings)}`;
	await closeViewer(format, uri);
	return report;
}

/**
 * External-change reload (DESIGN §3.3): rewriting the sample on disk must make the open viewer
 * re-render. The write goes through `workspace.fs`; if the watcher coalesces it (identical bytes),
 * a raw Node write after {@link RELOAD_FALLBACK_MS} forces an OS-level change event.
 */
async function testExternalChange(samplesDir: string): Promise<string> {
	const format: Format = 'xlsx';
	const fileName = SAMPLES[format];
	const uri = vscode.Uri.file(path.join(samplesDir, fileName));

	await openViewer(format, uri);
	await waitForRender(fileName, 1, LOAD_TIMEOUT_MS, 'the first render');

	const bytes = await vscode.workspace.fs.readFile(uri);
	const writeStartedAt = Date.now();
	await vscode.workspace.fs.writeFile(uri, bytes);

	const fallback = setTimeout(() => {
		void fs.promises.writeFile(uri.fsPath, bytes).catch((error: unknown) => {
			console.warn(`[integration] fallback write failed: ${String(error)}`);
		});
	}, RELOAD_FALLBACK_MS);

	try {
		const lines = await waitForRenderAfter(fileName, writeStartedAt, RELOAD_TIMEOUT_MS, 'a re-render after an external change');
		const changed = lines.filter((line) => line.includes(`${FILE_CHANGED_MARKER}${uri.toString()}`));
		if (changed.length === 0) {
			console.warn('[integration] re-render observed but no "file changed on disk" trace was in the ring (rotated?)');
		}
		const renders = renderedLines(lines, fileName);
		const timings = timingsOf(renders[renders.length - 1]);
		return `${format}: reloaded after external change (watcher events=${changed.length}) timings: ${formatTimings(timings)}`;
	} finally {
		clearTimeout(fallback);
		await closeViewer(format, uri);
	}
}

/** Command/diagnostics surface sanity (DESIGN §10). */
async function testDiagnosticsSurface(): Promise<string> {
	const lines = await getDiagnostics();
	const commands = await vscode.commands.getCommands(true);
	if (!commands.includes(DIAGNOSTICS_COMMAND)) throw new Error(`${DIAGNOSTICS_COMMAND} is not registered`);
	if (!commands.includes(COPY_DIAGNOSTICS_COMMAND)) throw new Error(`${COPY_DIAGNOSTICS_COMMAND} is not registered`);
	// Must resolve (writes the ring to the clipboard) without throwing.
	await vscode.commands.executeCommand(COPY_DIAGNOSTICS_COMMAND);
	return `diagnostics: ${lines.length} lines available, getDiagnostics + copyDiagnostics callable`;
}

/** Finds the workspace `samples/` directory (workspace root when run via scripts/run-tests.mjs). */
function resolveSamplesDir(extensionPath: string): string {
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (workspace && fs.existsSync(path.join(workspace, SAMPLES.docx))) return workspace;
	const fallback = path.join(extensionPath, 'samples');
	if (fs.existsSync(path.join(fallback, SAMPLES.docx))) return fallback;
	throw new Error(`samples/ not found (workspace=${String(workspace)}, extension=${extensionPath})`);
}

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	if (!extension) throw new Error(`extension ${EXTENSION_ID} is not present in the test host`);
	await extension.activate();

	const samplesDir = resolveSamplesDir(extension.extensionPath);
	const results: string[] = [];

	for (const format of FORMATS) {
		results.push(await testFormat(samplesDir, format));
	}
	results.push(await testExternalChange(samplesDir));
	results.push(await testDiagnosticsSurface());

	console.log(`\n=== office-file-editor-viewer integration results ===\n${results.join('\n')}\n`);
}

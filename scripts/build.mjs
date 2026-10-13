#!/usr/bin/env node
/**
 * Build pipeline for the Office File Editor & Viewer extension.
 *
 * Targets
 *   host     src/extension.ts                    -> out/extension.js        (CJS, node, external: vscode)
 *   webview  webview/entries/{docx,xlsx,pptx,vsdx}.ts -> out/media/webview-*.js (IIFE, browser)
 *   assets   every engine wasm + bundled font TTF -> out/media/assets/*       (verbatim copy, see copyAssets)
 *
 * Plugins
 *   asset-import-rewrite  rewrites the engines' `new URL('<literal>', import.meta.url)` asset/worker
 *                         lookups (they cannot survive an IIFE webview bundle) into `__extAssetUrl(name)`
 *                         / `__extWorkerUrl(logical)` global lookups resolved from out/media/manifest.json.
 *   vsdx-generated-stub   keeps the build green before `npm run build:vsdx-wasm` has produced
 *                         vendor/betteroffice/vsdx/src/wasm/generated/vsdx_wasm.js.
 *
 * Post-build
 *   out/media/manifest.json  {"assets": {<basename>: "assets/<file>"}}
 *
 * Usage: node scripts/build.mjs [--watch] [--production]
 */
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const rel = (p) => path.relative(root, p);
const fromRoot = (...parts) => path.join(root, ...parts);

/** Assets the M1 viewer needs on disk regardless of which entry imports them. */
const ASSET_GLOBS = [
	'node_modules/@betteroffice/docx/dist/generated/edit',
	'node_modules/@betteroffice/docx/dist/generated/layout',
	'node_modules/@betteroffice/docx/dist/generated/opc',
	'node_modules/@betteroffice/docx/dist/generated/parse',
	'node_modules/@betteroffice/xlsx/dist/generated',
	'node_modules/@betteroffice/pptx/dist/generated',
	'node_modules/@betteroffice/fonts/assets',
	// Vendored vsdx wasm-bindgen output (DESIGN §7.2): `vsdx_wasm_bg.wasm` is produced by
	// `npm run build:vsdx-wasm`, is loaded through the manifest by `webview/entries/vsdx.ts`
	// (`getAssetBytes('vsdx_wasm_bg.wasm')`) and is NOT reachable through the esbuild import graph
	// (the vendored loader's `new URL(..., import.meta.url)` default is rewritten away by the entry),
	// so it must be copied + manifest-listed explicitly. Missing until the Rust build has run.
	'vendor/betteroffice/vsdx/src/wasm/generated',
];
const ASSET_EXTENSIONS = new Set(['.wasm', '.ttf', '.otf', '.woff', '.woff2']);

/**
/**
 * Legacy hook: the docx engine worker (and its URL rewrite) went away when docx moved to the
 * eigenpal DOM engine. Kept as an empty map so the rewrite plugin stays generic; no engine in
 * the current dependency tree spawns a worker.
 */
const WORKER_LOGICAL_NAMES = {};

const VSDX_WASM_JS = 'vendor/betteroffice/vsdx/src/wasm/generated/vsdx_wasm.js';
const VSDX_WASM_DTS = 'vendor/betteroffice/vsdx/src/wasm/generated/vsdx_wasm.d.ts';

/* ------------------------------------------------------------------ plugins */

/**
 * Rewrites the engines' runtime asset lookups.
 *
 * The published engine bundles resolve wasm/worker/font files with
 * `new URL('<literal>', import.meta.url)`. `import.meta` and relative URLs are meaningless inside
 * an IIFE webview bundle (and VS Code webviews may not fetch from a worker context at all), so the
 * expression is replaced with a global lookup:
 *
 *   new URL('../assets/X.ttf', import.meta.url)        -> __extAssetUrl("X.ttf", <static import>)
 *   new URL('./residentEngineWorker.mjs', import.meta.url) -> __extWorkerUrl("docx")
 *
 * A static `import` of the asset is injected alongside the rewrite so esbuild actually emits the
 * bytes under out/media/assets/ and the manifest generator can see them. The imported URL is passed
 * as a fallback argument, which also keeps the import from being tree-shaken.
 */
const assetImportRewrite = {
	name: 'asset-import-rewrite',
	setup(build) {
		const filter = /[\\/](?:node_modules[\\/]@betteroffice[\\/]|vendor[\\/]).*\.(?:mjs|js|cjs)$/;
		build.onLoad({ filter }, async (args) => {
			// Non-JS files under these roots fall through to esbuild's own loaders.
			if (!/\.(?:mjs|js|cjs)$/.test(args.path)) return undefined;
			const source = await readFile(args.path, 'utf8');
			if (!source.includes('import.meta.url')) return undefined;

			const identifiers = new Map(); // resolved asset path -> import identifier
			const emittedWorkers = new Set();
			let changed = false;

			const contents = source.replace(
				/new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)(\.href)?/g,
				(match, _quote, specifier, _href) => {
					const base = path.posix.basename(specifier.replace(/\\/g, '/'));
					const extension = path.posix.extname(base).toLowerCase();

					// Engine worker spawn: worker bundles are served as blob: URLs by the webview
					// bootstrap, never as a relative URL.
					if (extension === '.mjs' || extension === '.js') {
						const workerKey = base.replace(/\.[^.]+$/, '');
						const logical = WORKER_LOGICAL_NAMES[workerKey];
						changed = true;
						if (!logical) {
							// Unknown module worker: fall back to an asset lookup so no
							// `new URL(..., import.meta.url)` survives the bundle.
							return `__extAssetUrl(${JSON.stringify(base)})`;
						}
						emittedWorkers.add(logical);
						return `__extWorkerUrl(${JSON.stringify(logical)})`;
					}

					if (!ASSET_EXTENSIONS.has(extension)) return match;

					const resolved = path.resolve(path.dirname(args.path), specifier);
					let identifier = identifiers.get(resolved);
					if (!identifier) {
						identifier = `__extAsset${identifiers.size}`;
						identifiers.set(resolved, identifier);
					}
					changed = true;
					return `__extAssetUrl(${JSON.stringify(base)}, ${identifier})`;
				},
			);

			if (!changed && identifiers.size === 0) return { contents: source, loader: 'js' };

			const prefix = [...identifiers]
				.map(([file, id]) => `import ${id} from ${JSON.stringify(file)};`)
				.join('\n');
			return { contents: prefix ? `${prefix}\n${contents}` : contents, loader: 'js' };
		});
	},
};

/**
 * Guarantees vendor/betteroffice/vsdx/src/wasm/generated/vsdx_wasm.js exists.
 *
 * The wasm-bindgen glue is produced by `npm run build:vsdx-wasm` (Rust toolchain). Until that has
 * run we synthesize a module with the same export shape so webview bundles that import the vendored
 * vsdx package still build; every generated stub throws a descriptive error when called.
 */
const vsdxGeneratedStub = {
	name: 'vsdx-generated-stub',
	setup(build) {
		build.onLoad({ filter: /vendor[\\/]betteroffice[\\/]vsdx[\\/]src[\\/]wasm[\\/]generated[\\/]vsdx_wasm\.js$/ }, async (args) => {
			if (existsSync(args.path)) return undefined; // real build output: pass through

			const dtsPath = fromRoot(VSDX_WASM_DTS);
			if (!existsSync(dtsPath)) {
				throw new Error(
					`${VSDX_WASM_JS} is missing and ${VSDX_WASM_DTS} is missing too, so no stub can be generated. ` +
						'Run `npm run build:vsdx-wasm` or restore the vendored type declarations.',
				);
			}
			const dts = await readFile(dtsPath, 'utf8');
			return {
				contents: generateVsdxWasmStub(dts),
				loader: 'js',
				resolveDir: path.dirname(args.path),
			};
		});
	},
};

/** Extracts the runtime export names from a wasm-bindgen `.d.ts` and emits throwing stubs. */
function generateVsdxWasmStub(dtsText) {
	const names = new Set();
	for (const m of dtsText.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
		names.add(m[1]);
	}
	for (const m of dtsText.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of m[1].split(',')) {
			const cleaned = part.trim().replace(/^type\s+/, '');
			if (!cleaned) continue;
			const alias = cleaned.split(/\s+as\s+/).pop()?.trim();
			if (alias && /^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
		}
	}
	const hasDefault = /^export\s+default\b/m.test(dtsText);

	const message = 'vsdx wasm not built — run npm run build:vsdx-wasm';
	const lines = [
		'/* Generated by scripts/build.mjs (vsdx-generated-stub): the real wasm-bindgen glue is not built yet. */',
		`const __boVsdxWasmMissing = () => { throw new Error(${JSON.stringify(message)}); };`,
	];
	if (hasDefault || names.size === 0) {
		lines.push(`export default function () { throw new Error(${JSON.stringify(message)}); }`);
	}
	for (const name of [...names].sort()) {
		if (name === 'default') continue;
		lines.push(`export const ${name} = __boVsdxWasmMissing;`);
	}
	return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------- configs */

/** @type {esbuild.BuildOptions} */
const hostConfig = {
	entryPoints: [{ in: fromRoot('src/extension.ts'), out: 'extension' }],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	external: ['vscode'],
	outdir: fromRoot('out'),
	entryNames: '[name]',
	sourcemap: !production,
	minify: production,
	logLevel: 'warning',
};

const webviewEntries = ['docx', 'xlsx', 'pptx', 'vsdx'].map((format) => ({
	in: fromRoot(`webview/entries/${format}.ts`),
	out: `webview-${format}`,
}));

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
	entryPoints: webviewEntries,
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2020',
	// The webview sources use the automatic JSX runtime with an explicit syntax
	// (`import { useEffect } from 'react'; import type { JSX } from 'react'`) — mirror
	// `tsconfig.webview.json`'s `"jsx": "react-jsx"`. esbuild only discovers `tsconfig.json`
	// (the webview program lives in `tsconfig.webview.json`), and its default `jsx: 'transform'`
	// emits `React.createElement(...)` with no `React` binding in scope, so the transform is set
	// explicitly here (without it every mount fails with `React is not defined`).
	jsx: 'automatic',
	jsxImportSource: 'react',
	outdir: fromRoot('out/media'),
	entryNames: '[name]',
	assetNames: 'assets/[name]',
	loader: { '.wasm': 'file', '.ttf': 'file', '.png': 'file' },
	metafile: true,
	sourcemap: !production,
	minify: production,
	logLevel: 'warning',
	plugins: [assetImportRewrite, vsdxGeneratedStub],
	// Collaboration/agent removal: the react package hard-imports AgentPanel from its agents
	// package; the product never renders it, so alias it to a no-op stub (webview/bootstrap/agentsStub.ts).
	alias: {
		'@eigenpal/docx-editor-agents': fromRoot('webview/bootstrap/agentsStub.ts'),
		'@eigenpal/docx-editor-agents/react': fromRoot('webview/bootstrap/agentsStub.ts'),
	},
};

/**
 * Integration-test bundle: `src/test-integration/index.ts` -> `out/test/integration.js`.
 *
 * `scripts/run-tests.mjs` hands this path to `@vscode/test-electron` as `extensionTestsPath`, which
 * `require()`s it inside the extension host, so the output must stay CommonJS with `vscode`
 * external. Excluded from the VSIX by `.vscodeignore` (`out/test/**`).
 */
/** @type {esbuild.BuildOptions} */
const integrationTestConfig = {
	entryPoints: [{ in: fromRoot('src/test-integration/index.ts'), out: 'test/integration' }],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	external: ['vscode'],
	outdir: fromRoot('out'),
	sourcemap: !production,
	logLevel: 'warning',
};

/** Recursively collects files with one of ASSET_EXTENSIONS under `dir`. */
async function collectAssets(dir) {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectAssets(full)));
		else if (ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
	}
	return files;
}

/**
 * Copies every engine wasm / bundled font verbatim to out/media/assets/.
 *
 * Note: esbuild's `file` loader cannot be used for this. With `bundle: false` it emits an extra
 * JS module next to each asset (`X.wasm.js`), and with bundling it only emits what a JS module
 * imports. A verbatim copy is both smaller and independent of the engine's import graph, which also
 * makes the wasm assets available before the real webview entries import their engines.
 *
 * Returns `Map<basename (manifest key), out/media-relative path>`.
 */
async function copyAssets() {
	const files = (await Promise.all(ASSET_GLOBS.map((glob) => collectAssets(fromRoot(glob))))).flat();
	if (files.length === 0) {
		throw new Error(
			'No engine assets found under node_modules/@betteroffice. Did `npm install` complete? ' +
				`Looked in: ${ASSET_GLOBS.join(', ')}`,
		);
	}

	const assets = new Map();
	const sources = new Map();
	await mkdir(fromRoot('out/media/assets'), { recursive: true });
	for (const file of files.sort()) {
		const key = path.basename(file);
		const previous = sources.get(key);
		if (previous && previous !== file) {
			throw new Error(
				`Asset basename collision: "${key}" is produced by both\n  ${rel(previous)}\n  ${rel(file)}\n` +
					'Rename one of the assets or extend the manifest key scheme.',
			);
		}
		sources.set(key, file);
		const output = path.posix.join('assets', key);
		await copyFile(file, fromRoot('out/media', output));
		assets.set(key, output);
	}
	return assets;
}

/* ------------------------------------------------------------------ manifest */

/** `docx_edit_bg-BESKFFA3.wasm` -> `docx_edit_bg.wasm` (esbuild only hashes when `[hash]` is used). */
function stripHashSuffix(fileName) {
	const extension = path.extname(fileName);
	const stem = fileName.slice(0, fileName.length - extension.length);
	return `${stem.replace(/-[A-Z0-9]{8,}$/, '')}${extension}`;
}

/**
 * Builds out/media/manifest.json from the esbuild metafiles.
 *
 * Asset keys are the *original* asset file basenames (what the engine source literals reference);
 * values are the emitted path relative to out/media/. Two different source files sharing a basename
 * would silently alias each other, so that is a hard build failure.
 */
async function writeManifest(copiedAssets, metafiles, { check = true } = {}) {
	const assets = new Map(copiedAssets);
	const sources = new Map();

	for (const metafile of metafiles) {
		for (const [outputPath, output] of Object.entries(metafile.outputs)) {
			const extension = path.extname(outputPath).toLowerCase();
			if (!ASSET_EXTENSIONS.has(extension)) continue;
			const source = Object.keys(output.inputs ?? {}).find(
				(input) => path.extname(input).toLowerCase() === extension,
			);
			if (!source) continue;
			const key = stripHashSuffix(path.basename(source));
			const previous = sources.get(key);
			if (previous && previous !== source) {
				throw new Error(
					`Asset basename collision: "${key}" is produced by both\n  ${rel(previous)}\n  ${rel(source)}\n` +
						'Rename one of the assets or extend the manifest key scheme.',
				);
			}
			sources.set(key, source);
			assets.set(key, path.relative(fromRoot('out/media'), fromRoot(outputPath)).split(path.sep).join('/'));
		}
	}

	const manifest = {
		assets: Object.fromEntries([...assets.entries()].sort(([a], [b]) => a.localeCompare(b))),
	};

	if (check) {
		const missing = [];
		for (const [key, relPath] of Object.entries(manifest.assets)) {
			if (!existsSync(fromRoot('out/media', relPath))) missing.push(`${key} -> ${relPath}`);
		}
		if (missing.length > 0) {
			throw new Error(`manifest.json references missing build outputs:\n  ${missing.join('\n  ')}`);
		}
	}

	await mkdir(fromRoot('out/media'), { recursive: true });
	await writeFile(fromRoot('out/media/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
	return manifest;
}

/* ------------------------------------------------------------------ postchecks */


/**
 * Offline + no-collaboration guard (product guarantees): shipped webview bundles must never
 * contain a realtime transport (collaboration is transport-injected by design and none is wired)
 * or beacon machinery. `fonts.googleapis` in the docx bundle is the eigenpal loader string that
 * `setGoogleFontsEnabled(false)` disables at module scope — CSP `connect-src` blocks it regardless.
 */
async function verifyNoEgressNoCollaboration() {
	const problems = [];
	for (const entry of webviewEntries) {
		const file = fromRoot('out/media', `${entry.out}.js`);
		if (!existsSync(file)) continue;
		const code = await readFile(file, 'utf8');
		for (const marker of ['new WebSocket', 'sendBeacon', 'EventSource', 'docx-editor-agents']) {
			if (code.includes(marker)) problems.push(`${path.basename(file)} contains "${marker}"`);
		}
	}
	const vsdx = fromRoot('out/media', 'webview-vsdx.js');
	if (existsSync(vsdx) && (await readFile(vsdx, 'utf8')).includes('CollaborationProvider')) {
		problems.push('webview-vsdx.js contains CollaborationProvider (vsdx barrel import regressed)');
	}
	if (problems.length > 0) {
		throw new Error(`offline/no-collaboration verification failed:\n  ${problems.join('\n  ')}`);
	}
}

/* -------------------------------------------------------------------- driver */

async function buildOnce() {
	const copiedAssets = await copyAssets();

	const host = await esbuild.build(hostConfig);
	const webviews = await esbuild.build(webviewConfig);
	await esbuild.build(integrationTestConfig);

	const manifest = await writeManifest(copiedAssets, [webviews.metafile]);
	await verifyNoEgressNoCollaboration();

	const assetCount = Object.keys(manifest.assets).length;
	console.log(
		`[build]${production ? ' production' : ''} host + ${webviewEntries.length} webviews + ` +
			`${assetCount} assets -> out/`,
	);
	return { host, manifest };
}

async function startWatch() {
	// Assets are copied once; they only change with the checked-in dependency tree, so a watching
	// rebuild is not needed (restart the watcher after `npm install`).
	await copyAssets();

	const contexts = await Promise.all([
		esbuild.context(hostConfig),
		esbuild.context(webviewConfig),
		esbuild.context(integrationTestConfig),
	]);
	await Promise.all(contexts.map((context) => context.watch()));
	console.log('[build] watching (host, webviews, integration tests)');
}

try {
	if (watch) await startWatch();
	else await buildOnce();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

/**
 * Engine worker bundle — docx.
 *
 * Verified path (npm install, @betteroffice/docx 0.4.3):
 *   node_modules/@betteroffice/docx/dist/yrs/residentEngineWorker.mjs
 * The relative import deliberately bypasses the package `exports` map: the worker is an internal
 * chunk, not an exported subpath.
 *
 * Contract: this bundle is self-contained (all chunks inlined) and starts with the
 * `workerFetchShim` preamble, because the webview spawns it from a `blob:` URL and injects the wasm
 * bytes over postMessage (DESIGN §4.2). It must never resolve a URL of its own.
 */
import '../bootstrap/workerFetchShim';
import '../../node_modules/@betteroffice/docx/dist/yrs/residentEngineWorker.mjs';

import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';

const workspaceRoot = resolve(new URL('..', import.meta.url).pathname);

try {
	await runTests({
		extensionDevelopmentPath: workspaceRoot,
		extensionTestsPath: resolve(workspaceRoot, 'out/test/integration.js'),
		launchArgs: [
			'--disable-workspace-trust',
			'--disable-extensions',
			resolve(workspaceRoot, 'samples'),
		],
	});
	console.log('INTEGRATION TESTS PASSED');
	process.exit(0);
} catch (err) {
	console.error('INTEGRATION TESTS FAILED');
	console.error(err);
	process.exit(1);
}

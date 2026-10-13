/**
 * Collaboration/agent surface removal (product decision): `@eigenpal/docx-editor-react`
 * hard-imports `AgentPanel` from its agents package, but this extension never renders it and
 * never wires an LLM/collaboration transport. esbuild aliases the agents packages to this stub
 * (scripts/build.mjs) so none of that code ships in the bundle.
 */
export function AgentPanel(): null {
	return null;
}
export default AgentPanel;

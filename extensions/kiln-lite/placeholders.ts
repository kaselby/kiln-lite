/**
 * Placeholder expansion for agent config fields.
 *
 * Placeholders use the {name} syntax and are expanded across system prompts,
 * cleanup templates, and context injection content. The base set is provided
 * by kiln-lite; custom harnesses extend it by adding entries to state.vars
 * in their session_start handler.
 *
 * Base placeholders (kl-level):
 *   {today}         — YYYY-MM-DD
 *   {agent_id}      — this session's agent id
 *   {agent_home}    — resolved $AGENT_HOME path
 *   {session_uuid}  — pi session UUID
 *   {pi_readme}     — absolute path to pi's README.md
 *   {pi_docs}       — absolute path to pi's docs/ directory
 *   {pi_examples}   — absolute path to pi's examples/ directory
 *
 * Unknown placeholders are left as-is (no error, no removal).
 */


/**
 * Expand {key} placeholders in a string using the provided vars map.
 * Unknown keys are left verbatim.
 */
export function expandPlaceholders(text: string, vars: Record<string, string>): string {
	return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
		return key in vars ? vars[key] : match;
	});
}

/**
 * Build the base placeholder set from session state.
 * Custom harnesses merge additional entries on top.
 */
export function buildBasePlaceholders(opts: {
	agentId: string;
	agentHome: string;
	sessionUuid: string;
	/** Resolved pi doc paths, injected by the caller (kept out of this module
	 * so it stays free of a pi-package import — see install.ts). */
	piPaths?: { readme: string; docs: string; examples: string };
}): Record<string, string> {
	const now = new Date();
	return {
		today: now.toISOString().slice(0, 10),
		agent_id: opts.agentId,
		agent_home: opts.agentHome,
		session_uuid: opts.sessionUuid,
		pi_readme: opts.piPaths?.readme ?? "",
		pi_docs: opts.piPaths?.docs ?? "",
		pi_examples: opts.piPaths?.examples ?? "",
	};
}

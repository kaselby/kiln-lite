/**
 * Build and export the environment variables read by spawned scripts.
 *
 * Written to `process.env` at session_start so they're inherited by ALL
 * child processes kiln-lite or Pi launches (the agent's bash tool, section
 * commands, messaging scripts).
 */

import type { AgentConfig } from "./types.ts";

export interface EnvInputs {
	agentHome: string;
	agentId: string;
	sessionUuid: string;
	config: AgentConfig;
	/** ~/.kl/run/<uuid>/inbox. */
	inboxDir: string;
}

/** Compute the kiln-lite env map for the given session. */
export function buildEnv(inputs: EnvInputs): Record<string, string> {
	const { agentHome, agentId, sessionUuid, config, inboxDir } = inputs;
	return {
		AGENT_HOME: agentHome,
		AGENT_ID: agentId,
		AGENT_NAME: config.name,
		SESSION_UUID: sessionUuid,
		KL_INBOX: inboxDir,
	};
}

/** Apply the env map to `process.env` so every child process inherits it. Idempotent. */
export function applyEnv(env: Record<string, string>): void {
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

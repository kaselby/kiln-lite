/**
 * Build and export the environment variables read by spawned scripts.
 *
 * Written to `process.env` at session_start so they're inherited by ALL
 * child processes kiln-lite or Pi launches (the agent's bash tool, section
 * commands, messaging scripts).
 */

import { join } from "node:path";

import type { AgentConfig } from "./types.ts";

export interface EnvInputs {
	agentHome: string;
	agentId: string;
	sessionUuid: string;
	config: AgentConfig;
}

/** Compute the kiln-lite env map for the given session. */
export function buildEnv(inputs: EnvInputs): Record<string, string> {
	const { agentHome, agentId, sessionUuid, config } = inputs;
	return {
		AGENT_HOME: agentHome,
		AGENT_ID: agentId,
		AGENT_NAME: config.name,
		SESSION_UUID: sessionUuid,
		INBOX: join(agentHome, config.inbox_dir, agentId),
	};
}

/** Apply the env map to `process.env` so every child process inherits it. Idempotent. */
export function applyEnv(env: Record<string, string>): void {
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

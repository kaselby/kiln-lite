/**
 * Build and export the environment variables read by spawned scripts.
 *
 * Written to `process.env` at session_start so they're inherited by ALL
 * child processes kiln-lite or Pi launches — registered shell tools,
 * startup commands, messaging scripts invoked by the agent via Pi's
 * built-in `bash` tool, etc. Keep this list in sync with design spec §6.
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

/**
 * Apply the env map to `process.env` so every child process inherits it.
 * Idempotent — re-applying overwrites prior values (useful if agent.yml is reloaded).
 *
 * Also prepends $AGENT_HOME/venv/bin to PATH if the venv exists, so that
 * shell tools using `#!/usr/bin/env python3` resolve to the venv's python
 * (which has the bundled-tools deps installed by bootstrap.sh). This is a
 * no-op if the venv isn't set up — system python3 handles those cases.
 */
export function applyEnv(env: Record<string, string>): void {
	for (const [k, v] of Object.entries(env)) {
		process.env[k] = v;
	}
	const agentHome = env.AGENT_HOME;
	if (agentHome) {
		const venvBin = join(agentHome, "venv", "bin");
		const existing = process.env.PATH ?? "";
		// Only prepend if not already first — avoids unbounded growth on reloads.
		if (!existing.startsWith(`${venvBin}:`) && existing !== venvBin) {
			process.env.PATH = existing ? `${venvBin}:${existing}` : venvBin;
		}
	}
}

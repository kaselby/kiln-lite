/**
 * Build and export the environment variables read by spawned scripts.
 *
 * Written to `process.env` at session_start so they're inherited by ALL
 * child processes kiln-lite or Pi launches — startup commands, shell tools
 * invoked by the agent via Pi's built-in `bash` tool, messaging scripts,
 * etc. Keep this list in sync with design spec §6.
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
 * Also prepends two directories to PATH (if not already at the front):
 *   1. $AGENT_HOME/<tools_dir> — so the agent can invoke shell tools by
 *      bare name via Pi's built-in `bash` tool (e.g. `seek foo` instead of
 *      `~/.agent/tools/seek foo`). This is the primary path for agent
 *      interaction with bundled/user scripts.
 *   2. $AGENT_HOME/venv/bin — so scripts with `#!/usr/bin/env python3`
 *      resolve to the venv's python (which has bundled-tool deps installed
 *      by bootstrap.sh). No-op if the venv isn't set up.
 *
 * `toolsDir` is the config's `tools_dir` value; pass it in from index.ts
 * where AgentConfig is already resolved.
 */
export function applyEnv(env: Record<string, string>, toolsDir: string): void {
	for (const [k, v] of Object.entries(env)) {
		process.env[k] = v;
	}
	const agentHome = env.AGENT_HOME;
	if (!agentHome) return;

	// Build list of PATH entries to ensure are at the front, in priority order.
	// Earlier entries end up first after the loop below.
	const toPrepend = [
		join(agentHome, toolsDir),
		join(agentHome, "venv", "bin"),
	];

	// Prepend in reverse so that toPrepend[0] ends up leftmost.
	for (let i = toPrepend.length - 1; i >= 0; i--) {
		const dir = toPrepend[i];
		const existing = process.env.PATH ?? "";
		if (existing.startsWith(`${dir}:`) || existing === dir) continue;
		process.env.PATH = existing ? `${dir}:${existing}` : dir;
	}
}

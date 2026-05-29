/**
 * Agent-ID resolution.
 *
 * Three-way fall-through (matches the order kiln-lite has used since v0.1):
 *
 *   1. Explicit AGENT_ID env var (set by `kl run` / `kl resume`).
 *      Validated against /^[a-z0-9_-]+$/i; uniquified against the snapshot
 *      store so two different pi sessions can't fight over the same id.
 *   2. Reverse-lookup of pi-session-uuid in the snapshot store. Handles the
 *      plain `pi --continue` / `pi --resume` / `/resume` path where the
 *      tmux env never gets AGENT_ID set but a prior session bound the uuid.
 *   3. Deterministic UUID-derivation (legacy default — same uuid + name
 *      yields the same id).
 *
 * Pulled out of index.ts so the priority order can be tested in isolation
 * and so a custom harness can opt into the same logic (or override one
 * branch) without copy-pasting it.
 */

import { findAgentIdForUuid, uniquifyAgentId } from "../snapshot.ts";
import { generateAgentId } from "../identity.ts";

const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/i;

export interface ResolveAgentIdOptions {
	/** $AGENT_HOME (used for snapshot lookups). */
	agentHome: string;
	/** Raw value of process.env.AGENT_ID (may be undefined / empty / invalid). */
	envAgentId: string | undefined;
	/** Pi session UUID for this session — used for collision check + derivation. */
	sessionUuid: string;
	/** Name prefix for derivation (the agent.yml `name` field). */
	namePrefix: string;
	/** Optional warn channel for collision notices. */
	warn?: (msg: string) => void;
}

export interface ResolvedAgentId {
	/** Final agent id (always non-empty). */
	agentId: string;
	/** Which branch produced it — useful for telemetry / debugging. */
	source: "env" | "env-collision" | "recovered" | "derived";
}

export function resolveAgentId(opts: ResolveAgentIdOptions): ResolvedAgentId {
	const { agentHome, envAgentId, sessionUuid, namePrefix, warn } = opts;

	if (envAgentId && AGENT_ID_PATTERN.test(envAgentId)) {
		const resolved = uniquifyAgentId(agentHome, envAgentId, sessionUuid);
		if (resolved !== envAgentId) {
			warn?.(
				`kiln-lite: AGENT_ID '${envAgentId}' is already bound to a different pi session — using '${resolved}' instead`,
			);
			return { agentId: resolved, source: "env-collision" };
		}
		return { agentId: resolved, source: "env" };
	}

	const recovered = findAgentIdForUuid(agentHome, sessionUuid, warn);
	if (recovered) return { agentId: recovered, source: "recovered" };

	return { agentId: generateAgentId(namePrefix, sessionUuid), source: "derived" };
}

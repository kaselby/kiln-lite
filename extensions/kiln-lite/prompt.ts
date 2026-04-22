/**
 * System prompt assembly.
 *
 * Called from before_agent_start. Composes:
 *   1. Base prompt (agent.yml:system_prompt contents OR Pi's passed prompt)
 *   2. Each context_injection entry, labeled
 *   3. Rendered tool index (scanned from agent.yml:tools_dir)
 *
 * Static injection contents are cached on SessionState at session_start.
 * Dynamic entries are re-read every turn.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

import type { ContextInjectionEntry, SessionState } from "./types.ts";

/**
 * Read and cache static context_injection entries on SessionState.
 * Called once at session_start, after config is loaded.
 */
export function preloadStaticInjection(state: SessionState, warn: (msg: string) => void): void {
	for (const entry of state.config.context_injection) {
		if (entry.dynamic) continue;
		const content = readInjectionFile(state.agentHome, entry, warn);
		if (content !== null) {
			state.staticInjection.set(entry.path, content);
		}
	}
}

/**
 * Resolve the base system prompt.
 * If agent.yml:system_prompt is set, read that file and use its contents verbatim.
 * Otherwise use whatever Pi passed us (event.systemPrompt).
 *
 * Cached on state.systemPromptBase so we only read the file once per session.
 */
export function resolveBasePrompt(
	state: SessionState,
	fallback: string,
	warn: (msg: string) => void,
): string {
	if (state.systemPromptBase !== null) return state.systemPromptBase;

	const configured = state.config.system_prompt;
	if (!configured) {
		state.systemPromptBase = fallback;
		return fallback;
	}

	const path = resolvePath(state.agentHome, configured);
	if (!existsSync(path)) {
		warn(`kiln-lite: system_prompt file not found at ${path} — using Pi's base prompt`);
		state.systemPromptBase = fallback;
		return fallback;
	}
	try {
		const contents = readFileSync(path, "utf8");
		state.systemPromptBase = contents;
		return contents;
	} catch (err) {
		warn(`kiln-lite: failed to read system_prompt (${path}): ${(err as Error).message} — using Pi's base prompt`);
		state.systemPromptBase = fallback;
		return fallback;
	}
}

/**
 * Assemble the full system prompt for a turn.
 *
 * @param toolIndex Rendered tool index block (may be empty string if no tools).
 */
export function composeSystemPrompt(
	state: SessionState,
	fallback: string,
	toolIndex: string,
	warn: (msg: string) => void,
): string {
	const parts: string[] = [];
	parts.push(resolveBasePrompt(state, fallback, warn));

	for (const entry of state.config.context_injection) {
		const body = entry.dynamic
			? readInjectionFile(state.agentHome, entry, warn)
			: state.staticInjection.get(entry.path) ?? null;
		if (body === null) continue;
		parts.push(`\n\n---\n\n## ${entry.label}\n\n${body}`);
	}

	if (toolIndex.trim()) {
		parts.push(`\n\n---\n\n## Tool Index\n\n${toolIndex}`);
	}

	return parts.join("");
}

function readInjectionFile(
	agentHome: string,
	entry: ContextInjectionEntry,
	warn: (msg: string) => void,
): string | null {
	const path = resolvePath(agentHome, entry.path);
	if (!existsSync(path)) {
		warn(`kiln-lite: context_injection file not found: ${path} — skipping`);
		return null;
	}
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		warn(`kiln-lite: failed to read context_injection file ${path}: ${(err as Error).message}`);
		return null;
	}
}

function resolvePath(agentHome: string, p: string): string {
	return isAbsolute(p) ? p : join(agentHome, p);
}

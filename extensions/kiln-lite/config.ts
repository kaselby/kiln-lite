/**
 * agent.yml loader.
 *
 * Resolves $AGENT_HOME (env var or default ~/.agent/), loads agent.yml if present,
 * merges with defaults, and validates the shape.
 *
 * Missing agent.yml => defaults. Missing required files in context_injection =>
 * warned but non-fatal (skipped at inject time).
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import yaml from "js-yaml";

import type { AgentConfig, ContextInjectionEntry } from "./types.ts";

const DEFAULT_CONFIG: AgentConfig = {
	name: "pi",
	context_injection: [],
	startup: [],
	cleanup: "",
	tools_dir: "tools",
	inbox_dir: "inbox",
	sessions_dir: "sessions",
	session_state_interval: 15,
};

/**
 * Resolve $AGENT_HOME. Env var if set, else ~/.agent/.
 * Does NOT create the directory — the caller (or startup commands) can mkdir.
 */
export function resolveAgentHome(): string {
	return resolveAgentHomeDetailed().path;
}

/**
 * Resolve $AGENT_HOME, reporting whether it came from the env or the default.
 * The auto-scaffolder uses `explicit` to decide whether it's safe to create
 * files under the resolved path.
 */
export function resolveAgentHomeDetailed(): { path: string; explicit: boolean } {
	const fromEnv = process.env.AGENT_HOME;
	if (fromEnv && fromEnv.trim()) {
		return { path: resolve(fromEnv), explicit: true };
	}
	return { path: resolve(join(homedir(), ".agent")), explicit: false };
}

/**
 * Resolve the kiln-lite root (`~/.kl/`) — the directory that holds
 * kl-global state (the daemon dir, guardrails.yml, and the per-agent
 * `agents/<name>/` homes). Honors the `KL_ROOT` env var for testability,
 * else defaults to `~/.kl`, matching the daemon/client convention.
 *
 * Deliberately NOT derived from $AGENT_HOME: under the multi-agent layout
 * an agent home is `~/.kl/agents/<name>/`, two levels deep, so relative
 * `..` resolution is fragile and layout-dependent.
 */
export function resolveKlRoot(): string {
	const fromEnv = process.env.KL_ROOT;
	if (fromEnv && fromEnv.trim()) {
		return resolve(fromEnv);
	}
	return resolve(join(homedir(), ".kl"));
}

/**
 * Load agent.yml from $AGENT_HOME. Returns merged config.
 *
 * @param agentHome Resolved $AGENT_HOME
 * @param warn Called with a human-readable message for any non-fatal issue
 *             (missing file, unknown field, invalid shape for a field). The caller
 *             decides how to surface the warning (ctx.ui.notify, console, etc).
 */
export function loadAgentConfig(agentHome: string, warn: (msg: string) => void): AgentConfig {
	const configPath = join(agentHome, "agent.yml");
	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	let raw: unknown;
	try {
		const contents = readFileSync(configPath, "utf8");
		raw = yaml.load(contents);
	} catch (err) {
		warn(`kiln-lite: failed to parse agent.yml: ${(err as Error).message} — using defaults`);
		return { ...DEFAULT_CONFIG };
	}

	if (raw === null || raw === undefined) {
		return { ...DEFAULT_CONFIG };
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warn(`kiln-lite: agent.yml must be a YAML mapping — using defaults`);
		return { ...DEFAULT_CONFIG };
	}

	const obj = raw as Record<string, unknown>;
	const known = new Set([
		"name",
		"description",
		"model",
		"system_prompt",
		"context_injection",
		"startup",
		"cleanup",
		"tools_dir",
		"inbox_dir",
		"sessions_dir",
		"session_state_interval",
	]);
	for (const key of Object.keys(obj)) {
		if (!known.has(key)) {
			warn(`kiln-lite: agent.yml has unknown field '${key}' — ignoring`);
		}
	}

	const config: AgentConfig = { ...DEFAULT_CONFIG };

	if (typeof obj.name === "string" && obj.name.trim()) {
		config.name = obj.name.trim();
	}

	if (typeof obj.system_prompt === "string" && obj.system_prompt.trim()) {
		config.system_prompt = obj.system_prompt.trim();
	}

	if (Array.isArray(obj.context_injection)) {
		const entries: ContextInjectionEntry[] = [];
		for (const [i, e] of obj.context_injection.entries()) {
			if (e === null || typeof e !== "object" || Array.isArray(e)) {
				warn(`kiln-lite: agent.yml context_injection[${i}] is not a mapping — skipping`);
				continue;
			}
			const entry = e as Record<string, unknown>;
			const hasPath = typeof entry.path === "string" && (entry.path as string).trim() !== "";
			const hasCommand = typeof entry.command === "string" && (entry.command as string).trim() !== "";
			if (!hasPath && !hasCommand) {
				warn(`kiln-lite: agent.yml context_injection[${i}] needs either 'path' or 'command' — skipping`);
				continue;
			}
			if (hasPath && hasCommand) {
				warn(`kiln-lite: agent.yml context_injection[${i}] has both 'path' and 'command' — skipping (they're mutually exclusive)`);
				continue;
			}
			if (typeof entry.label !== "string" || !entry.label.trim()) {
				warn(`kiln-lite: agent.yml context_injection[${i}] missing 'label' — skipping`);
				continue;
			}
			const parsed: ContextInjectionEntry = {
				label: entry.label.trim(),
			};
			if (hasPath) parsed.path = (entry.path as string).trim();
			if (hasCommand) parsed.command = (entry.command as string).trim();
			if (typeof entry.dynamic === "boolean") {
				parsed.dynamic = entry.dynamic;
			}
			entries.push(parsed);
		}
		config.context_injection = entries;
	}

	if (Array.isArray(obj.startup)) {
		const cmds: string[] = [];
		for (const [i, c] of obj.startup.entries()) {
			if (typeof c !== "string") {
				warn(`kiln-lite: agent.yml startup[${i}] is not a string — skipping`);
				continue;
			}
			cmds.push(c);
		}
		config.startup = cmds;
	}

	if (typeof obj.cleanup === "string") {
		config.cleanup = obj.cleanup;
	}

	if (typeof obj.tools_dir === "string" && obj.tools_dir.trim()) {
		config.tools_dir = obj.tools_dir.trim();
	}
	if (typeof obj.inbox_dir === "string" && obj.inbox_dir.trim()) {
		config.inbox_dir = obj.inbox_dir.trim();
	}
	if (typeof obj.sessions_dir === "string" && obj.sessions_dir.trim()) {
		config.sessions_dir = obj.sessions_dir.trim();
	}
	if (typeof obj.session_state_interval === "number" && Number.isFinite(obj.session_state_interval)) {
		const n = Math.floor(obj.session_state_interval);
		if (n >= 0) {
			config.session_state_interval = n;
		} else {
			warn(`kiln-lite: agent.yml session_state_interval must be >= 0 — using default ${DEFAULT_CONFIG.session_state_interval}`);
		}
	} else if (obj.session_state_interval !== undefined) {
		warn(`kiln-lite: agent.yml session_state_interval must be a number — using default ${DEFAULT_CONFIG.session_state_interval}`);
	}
	return config;
}

/**
 * kl configuration.
 *
 * Two layers, merged key by key:
 *   1. `<kl root>/config.yml`   — global defaults for every kl agent
 *                                 (kl root = $KL_ROOT or ~/.kl)
 *   2. `<agent home>/agent.yml` — per agent; any top-level key it sets
 *                                 replaces the global value outright
 *
 * Relative paths (`system_prompt`, `sections[].path`) resolve against the
 * dir of the file that declared them, so a global section can point into
 * ~/.kl and an agent's into its own folder.
 *
 * Minimal schema: name, description, model, thinking, system_prompt,
 * sections, project_context, timestamps. A few more keys are recognized for
 * modules outside the core slice (cleanup,
 * session_state_interval); anything else warns and is ignored.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, join } from "node:path";
import yaml from "js-yaml";

import type { AgentConfig, SectionEntry, TimestampConfig } from "./types.ts";
import { parsePromptSource } from "./prompt-source.ts";

/** Pi rejects section names outside this grammar (system-prompt.js). */
export const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Section names kl must not let agents take: Pi's built-ins (a same-named
 * custom section replaces the built-in in place) and kl's own `session`.
 */
export const RESERVED_SECTIONS = new Set([
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"project_context",
	"skills",
	"cwd",
	"session",
]);

export const DEFAULT_TIMESTAMPS: TimestampConfig = { per_turn: true, every_calls: 20, every_minutes: 10 };

const KNOWN_KEYS = new Set([
	"name",
	"description",
	"model",
	"thinking",
	"system_prompt",
	"sections",
	"project_context",
	"timestamps",
	"cleanup",
	"session_state_interval",
]);

/** Keys that only make sense per agent; ignored (with a warning) in the global file. */
const AGENT_ONLY_KEYS = new Set(["name", "description"]);

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Resolve $AGENT_HOME, reporting whether it came from the env. */
export function resolveAgentHomeDetailed(): { path: string; explicit: boolean } {
	const fromEnv = process.env.AGENT_HOME;
	if (fromEnv && fromEnv.trim()) {
		return { path: resolve(fromEnv), explicit: true };
	}
	return { path: resolve(join(homedir(), ".agent")), explicit: false };
}

export function resolveAgentHome(): string {
	return resolveAgentHomeDetailed().path;
}

/** kl root: $KL_ROOT (tests, alternate installs) or ~/.kl. */
export function resolveKlRoot(): string {
	const fromEnv = process.env.KL_ROOT;
	if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
	return resolve(join(homedir(), ".kl"));
}

export function defaultConfig(agentHome: string): AgentConfig {
	return {
		name: basename(agentHome) || "agent",
		system_prompt_base: agentHome,
		sections: [],
		project_context: true,
		timestamps: { ...DEFAULT_TIMESTAMPS },
		cleanup: "",
		session_state_interval: 15,
	};
}

/** Read a YAML file that must be a mapping. Missing file → null; bad file → warn + null. */
export function readYamlMapping(
	path: string,
	label: string,
	warn: (msg: string) => void,
): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = yaml.load(readFileSync(path, "utf8"));
	} catch (err) {
		warn(`kiln-lite: failed to parse ${label} (${path}): ${(err as Error).message} — ignoring it`);
		return null;
	}
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warn(`kiln-lite: ${label} must be a YAML mapping — ignoring it`);
		return null;
	}
	return raw as Record<string, unknown>;
}

export interface LoadConfigOptions {
	agentHome: string;
	/** Defaults to resolveKlRoot(). */
	klRoot?: string;
	warn: (msg: string) => void;
}

/** Load `<klRoot>/config.yml`, then `<agentHome>/agent.yml` over it. */
export function loadConfig(opts: LoadConfigOptions): AgentConfig {
	const { agentHome, warn } = opts;
	const klRoot = opts.klRoot ?? resolveKlRoot();
	const config = defaultConfig(agentHome);

	const globalPath = join(klRoot, "config.yml");
	const global = readYamlMapping(globalPath, "kl config.yml", warn);
	if (global) applyLayer(config, global, { baseDir: klRoot, label: globalPath, isGlobal: true, warn });

	const agentPath = join(agentHome, "agent.yml");
	const agent = readYamlMapping(agentPath, "agent.yml", warn);
	if (agent) applyLayer(config, agent, { baseDir: agentHome, label: agentPath, isGlobal: false, warn });

	if (config.system_prompt === undefined && existsSync(join(agentHome, "SYSTEM.md"))) {
		config.system_prompt = "SYSTEM.md";
		config.system_prompt_base = agentHome;
	}
	return config;
}

/** Back-compat shim: load with the default kl root. */
export function loadAgentConfig(agentHome: string, warn: (msg: string) => void): AgentConfig {
	return loadConfig({ agentHome, warn });
}

interface LayerOptions {
	baseDir: string;
	label: string;
	isGlobal: boolean;
	warn: (msg: string) => void;
}

function applyLayer(config: AgentConfig, obj: Record<string, unknown>, layer: LayerOptions): void {
	const { baseDir, label, isGlobal, warn } = layer;
	const has = (k: string) => Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;

	for (const key of Object.keys(obj)) {
		if (!KNOWN_KEYS.has(key)) warn(`kiln-lite: ${label} has unknown field '${key}' — ignoring`);
		else if (isGlobal && AGENT_ONLY_KEYS.has(key)) warn(`kiln-lite: ${label}: '${key}' is per-agent only — ignoring`);
	}

	if (!isGlobal && has("name")) {
		const v = str(obj.name);
		if (v && /^[a-z][a-z0-9_]*$/.test(v)) config.name = v;
		else warn(`kiln-lite: ${label}: name must match [a-z][a-z0-9_]* — using '${config.name}'`);
	}
	if (!isGlobal && has("description")) {
		const v = str(obj.description);
		if (v !== undefined) config.description = v;
	}
	if (has("model")) {
		const v = str(obj.model);
		if (v) config.model = v;
		else warn(`kiln-lite: ${label}: model must be a non-empty string — ignoring`);
	}
	if (has("thinking")) {
		const v = str(obj.thinking);
		if (v && THINKING_LEVELS.includes(v)) config.thinking = v;
		else warn(`kiln-lite: ${label}: thinking must be one of ${THINKING_LEVELS.join(", ")} — ignoring`);
	}
	if (has("system_prompt")) {
		const v = str(obj.system_prompt);
		if (v) {
			config.system_prompt = v;
			config.system_prompt_base = baseDir;
		} else warn(`kiln-lite: ${label}: system_prompt must be a path string — ignoring`);
	}
	if (has("sections")) {
		const parsed = parseSections(obj.sections, baseDir, label, warn);
		if (parsed) config.sections = parsed;
	}
	if (has("project_context")) {
		if (typeof obj.project_context === "boolean") config.project_context = obj.project_context;
		else warn(`kiln-lite: ${label}: project_context must be true or false — ignoring`);
	}
	if (has("timestamps")) {
		const t = parseTimestamps(obj.timestamps, label, warn);
		if (t !== undefined) config.timestamps = t;
	}
	if (has("cleanup")) {
		const c = parsePromptSource(obj.cleanup, `${label} cleanup`, warn);
		if (c !== undefined) config.cleanup = c;
	}
	if (has("session_state_interval")) {
		const n = obj.session_state_interval;
		if (typeof n === "number" && Number.isFinite(n) && n >= 0) config.session_state_interval = Math.floor(n);
		else warn(`kiln-lite: ${label}: session_state_interval must be a number >= 0 — ignoring`);
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v.trim() : undefined;
}

/** Parse `sections:`. Returns undefined (keep the lower layer) when the value isn't a list. */
export function parseSections(
	raw: unknown,
	baseDir: string,
	label: string,
	warn: (msg: string) => void,
): SectionEntry[] | undefined {
	if (!Array.isArray(raw)) {
		warn(`kiln-lite: ${label}: sections must be a list of {name, path} or {name, command} — ignoring`);
		return undefined;
	}
	const out: SectionEntry[] = [];
	const seen = new Set<string>();
	for (const [i, e] of raw.entries()) {
		const where = `${label}: sections[${i}]`;
		if (e === null || typeof e !== "object" || Array.isArray(e)) {
			warn(`kiln-lite: ${where} is not a mapping — skipping`);
			continue;
		}
		const entry = e as Record<string, unknown>;
		const name = str(entry.name);
		const path = str(entry.path);
		const command = str(entry.command);
		if (!name || !SECTION_NAME.test(name)) {
			warn(`kiln-lite: ${where}: name must match [a-z][a-z0-9_-]* — skipping`);
			continue;
		}
		if (RESERVED_SECTIONS.has(name)) {
			warn(`kiln-lite: ${where}: '${name}' is a reserved section name — skipping`);
			continue;
		}
		if (seen.has(name)) {
			warn(`kiln-lite: ${where}: duplicate section name '${name}' — skipping`);
			continue;
		}
		if (!!path === !!command) {
			warn(`kiln-lite: ${where} ('${name}') needs exactly one of 'path' or 'command' — skipping`);
			continue;
		}
		seen.add(name);
		out.push(path ? { name, path, baseDir } : { name, command, baseDir });
	}
	return out;
}

/**
 * `timestamps:` accepts `true` / `false`, or a mapping overriding any of
 * per_turn / every_calls / every_minutes on top of the defaults.
 */
export function parseTimestamps(
	raw: unknown,
	label: string,
	warn: (msg: string) => void,
): TimestampConfig | false | undefined {
	if (raw === false) return false;
	if (raw === true) return { ...DEFAULT_TIMESTAMPS };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warn(`kiln-lite: ${label}: timestamps must be true, false, or a mapping — ignoring`);
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const out: TimestampConfig = { ...DEFAULT_TIMESTAMPS };
	for (const key of Object.keys(obj)) {
		if (key === "per_turn") {
			if (typeof obj.per_turn === "boolean") out.per_turn = obj.per_turn;
			else warn(`kiln-lite: ${label}: timestamps.per_turn must be true or false — ignoring`);
		} else if (key === "every_calls" || key === "every_minutes") {
			const n = obj[key];
			if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
			else warn(`kiln-lite: ${label}: timestamps.${key} must be a number >= 0 — ignoring`);
		} else {
			warn(`kiln-lite: ${label}: unknown timestamps field '${key}' — ignoring`);
		}
	}
	return out;
}

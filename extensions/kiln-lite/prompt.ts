/**
 * System prompt assembly.
 *
 * kiln-lite owns the entire system prompt composition — pi's assembled
 * `event.systemPrompt` is ignored. We build from scratch each turn using
 * `event.systemPromptOptions` (for skills, appendSystemPrompt, cwd, etc.)
 * plus kiln-lite state and the current model id.
 *
 * Final structure, separated by `\n\n---\n\n`:
 *
 *   1. IDENTITY            — contents of agent.yml:system_prompt, or the
 *                            bundled default-identity.md if missing/unset
 *   2. ## Session          — agent id, model, date, cwd, home, inbox, session uuid
 *   3. ## Skills           — formatSkillsForPrompt output (header prefixed)
 *   4. ## Tools            — rendered shell-tool index
 *   5. ## Context          — unified: agent.yml context_injection entries
 *                            followed by options.appendSystemPrompt
 *
 * Any section with nothing to render (no skills, no tools, no context) is
 * skipped entirely — header and separator included.
 *
 * HTML comments are stripped from IDENTITY.md contents so it can carry
 * human-facing notes without leaking them to the model.
 *
 * Pi's project context files (AGENTS.md etc.) are intentionally NOT included.
 * If they're needed, point a context_injection entry at them.
 */

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import type { BuildSystemPromptOptions } from "@mariozechner/pi-coding-agent";

import type { ContextInjectionEntry, SessionState } from "./types.ts";

// ---------------------------------------------------------------------------
// Bundled default identity (used when agent.yml system_prompt is unset or
// the configured file is missing/unreadable). Loaded lazily on first miss.
// ---------------------------------------------------------------------------

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_IDENTITY_PATH = join(EXT_DIR, "default-identity.md");
const HARDCODED_FALLBACK = "You are a coding assistant operating inside pi, a coding agent harness.";

/** null = not yet attempted; string = loaded; undefined = attempted and failed */
let bundledDefault: string | null | undefined = null;

function getBundledDefault(warn: (msg: string) => void): string {
	if (bundledDefault === undefined) return HARDCODED_FALLBACK;
	if (bundledDefault !== null) return bundledDefault;
	try {
		bundledDefault = readFileSync(DEFAULT_IDENTITY_PATH, "utf8");
		return bundledDefault;
	} catch (err) {
		warn(
			`kiln-lite: failed to read bundled default-identity.md (${DEFAULT_IDENTITY_PATH}): ${(err as Error).message}`,
		);
		bundledDefault = undefined;
		return HARDCODED_FALLBACK;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * Assemble the full system prompt for a turn. See file header for structure.
 */
export function composeSystemPrompt(
	state: SessionState,
	options: BuildSystemPromptOptions,
	modelId: string | undefined,
	toolIndex: string,
	warn: (msg: string) => void,
): string {
	const sections: string[] = [];

	sections.push(resolveIdentity(state, warn));
	sections.push(renderSession(state, options, modelId));

	const skills = renderSkills(options);
	if (skills) sections.push(skills);

	const tools = renderTools(toolIndex);
	if (tools) sections.push(tools);

	const context = renderContext(state, options, warn);
	if (context) sections.push(context);

	return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function resolveIdentity(state: SessionState, warn: (msg: string) => void): string {
	if (state.systemPromptBase !== null) return state.systemPromptBase;

	const configured = state.config.system_prompt;
	if (configured) {
		const path = resolvePath(state.agentHome, configured);
		if (existsSync(path)) {
			try {
				const raw = readFileSync(path, "utf8");
				const cleaned = stripIdentityArtifacts(raw);
				state.systemPromptBase = cleaned;
				return cleaned;
			} catch (err) {
				warn(
					`kiln-lite: failed to read system_prompt (${path}): ${(err as Error).message} — using bundled default identity`,
				);
			}
		} else {
			warn(`kiln-lite: system_prompt file not found at ${path} — using bundled default identity`);
		}
	}

	// Fall back to bundled default. Cache it so we don't re-read on every turn
	// (the file does not change mid-session).
	const fallback = getBundledDefault(warn);
	state.systemPromptBase = fallback;
	return fallback;
}

/**
 * Strip HTML comments and leading whitespace so a stripped header comment
 * doesn't leave blank lines at the top of the prompt.
 */
function stripIdentityArtifacts(raw: string): string {
	return raw.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s+/, "");
}

function renderSession(
	state: SessionState,
	options: BuildSystemPromptOptions,
	modelId: string | undefined,
): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;
	const cwd = options.cwd.replace(/\\/g, "/");
	const inbox = join(state.agentHome, state.config.inbox_dir, state.agentId);

	const lines = [
		"## Session",
		"",
		`- Agent ID: ${state.agentId}`,
		`- Model: ${modelId ?? "(not set)"}`,
		`- Current date: ${date}`,
		`- Current working directory: ${cwd}`,
		`- Agent home: ${state.agentHome}`,
		`- Inbox: ${inbox}`,
		`- Session UUID: ${state.sessionUuid}`,
	];
	return lines.join("\n");
}

function renderSkills(options: BuildSystemPromptOptions): string | null {
	const hasRead = !options.selectedTools || options.selectedTools.includes("read");
	const skills = options.skills ?? [];
	if (!hasRead || skills.length === 0) return null;

	// formatSkillsForPrompt returns "\n\n<preamble>\n\n<xml>"; strip leading
	// whitespace and prepend our section header.
	const body = formatSkillsForPrompt(skills).replace(/^\s+/, "");
	return `## Skills\n\n${body}`;
}

function renderTools(toolIndex: string): string | null {
	const trimmed = toolIndex.trim();
	if (!trimmed) return null;
	return `## Tools\n\n${trimmed}`;
}

function renderContext(
	state: SessionState,
	options: BuildSystemPromptOptions,
	warn: (msg: string) => void,
): string | null {
	const entries: Array<{ label: string; body: string }> = [];

	for (const entry of state.config.context_injection) {
		const body = entry.dynamic
			? readInjectionFile(state.agentHome, entry, warn)
			: state.staticInjection.get(entry.path) ?? null;
		if (body !== null) entries.push({ label: entry.label, body });
	}

	const appended = options.appendSystemPrompt?.trim();
	if (appended) entries.push({ label: "Appended system prompt", body: appended });

	if (entries.length === 0) return null;

	const parts = ["## Context"];
	for (const entry of entries) {
		parts.push(`### ${entry.label}\n\n${entry.body.trim()}`);
	}
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

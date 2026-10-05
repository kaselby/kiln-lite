/**
 * System prompt composition.
 *
 * kl never builds the whole prompt and never returns `systemPrompt` or sets
 * `forceSystemPrompt`. From a `before_agent_start` handler it edits Pi's
 * mutable `event.systemPromptOptions`, and Pi renders the rest:
 *
 *   preamble        = customPrompt = agent identity (SYSTEM.md / agent.yml
 *                     system_prompt) + kl baseline (prompts/kl-baseline.md)
 *                     + tool rules rendered from toolGuidelines /
 *                     promptGuidelines (Pi drops them once customPrompt is set)
 *   <addendum>        Pi: APPEND_SYSTEM.md / --append-system-prompt
 *   <project_context> Pi: AGENTS.md etc. (`project_context: false` empties it)
 *   <skills>          Pi
 *   <cwd>             Pi (always rendered)
 *   <session>         kl: agent, session id, model, home (no uuid, no cwd)
 *   <name>…           agent.yml `sections:`, rendered once at session start
 *
 * Pi records sections in the transcript and sends later changes as deltas,
 * so sections other extensions add survive, and a changed `session` (e.g.
 * after /model) costs one section update, not a new prompt.
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentConfig, SectionEntry } from "./types.ts";

/** Hard caps for `sections:` commands (carried over from context_injection). */
export const SECTION_COMMAND_TIMEOUT_MS = 1000;
export const SECTION_COMMAND_MAX_BYTES = 64 * 1024;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KL_BASELINE_PATH = join(PACKAGE_ROOT, "prompts", "kl-baseline.md");

/** The subset of Pi's NormalizedBuildSystemPromptOptions kl touches. */
export interface PromptOptionsLike {
	customPrompt?: string;
	selectedTools: string[];
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
}

/** Everything resolved once at session start. */
export interface PromptParts {
	/** Agent identity text, or null when the agent has none. */
	identity: string | null;
	/** kl baseline text, or null if the file couldn't be read. */
	baseline: string | null;
	/** Rendered agent.yml sections, in order. */
	sections: Array<{ name: string; content: string }>;
	projectContext: boolean;
}

export interface SessionInfo {
	agentName: string;
	sessionId: string;
	/** `provider/id`, or undefined if no model is selected. */
	model?: string;
	home: string;
}

/** Strip HTML comments (human notes) and leading blank space. */
export function stripComments(raw: string): string {
	return raw.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s+/, "").replace(/\s+$/, "");
}

function readPromptFile(path: string, label: string, warn: (msg: string) => void): string | null {
	if (!existsSync(path)) {
		warn(`kiln-lite: ${label} not found at ${path}`);
		return null;
	}
	try {
		return stripComments(readFileSync(path, "utf8"));
	} catch (err) {
		warn(`kiln-lite: failed to read ${label} (${path}): ${(err as Error).message}`);
		return null;
	}
}

/** Agent identity from config.system_prompt (SYSTEM.md is defaulted in by loadConfig). */
export function loadIdentity(config: AgentConfig, warn: (msg: string) => void): string | null {
	if (!config.system_prompt) return null;
	const path = resolvePath(config.system_prompt_base, config.system_prompt);
	const text = readPromptFile(path, "system_prompt", warn);
	return text ? text : null;
}

export function loadBaseline(warn: (msg: string) => void, path = KL_BASELINE_PATH): string | null {
	const text = readPromptFile(path, "kl baseline prompt", warn);
	return text ? text : null;
}

/**
 * Tool rules as Pi would have rendered them in its `rules` section: the
 * guidelines of each selected tool, then promptGuidelines, trimmed and
 * deduped. Pi's two hard-coded rules ("Be concise…", "Show file paths…")
 * and its bash-for-file-ops rule are NOT included — those are prompt text,
 * and belong in the kl baseline if wanted.
 */
export function renderToolRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const seen = new Set<string>();
	const rules: string[] = [];
	const add = (rule: string) => {
		const r = rule.trim();
		if (!r || seen.has(r)) return;
		seen.add(r);
		rules.push(`- ${r}`);
	};
	for (const name of selectedTools) for (const r of toolGuidelines[name] ?? []) add(r);
	for (const r of promptGuidelines) add(r);
	return rules.join("\n");
}

export function buildCustomPrompt(
	identity: string | null,
	baseline: string | null,
	toolRules: string,
): string {
	const parts: string[] = [];
	if (identity) parts.push(identity);
	if (baseline) parts.push(baseline);
	if (toolRules) parts.push(`Tool guidelines:\n${toolRules}`);
	return parts.join("\n\n");
}

export function renderSessionSection(info: SessionInfo): string {
	return [
		`agent: ${info.agentName}`,
		`session: ${info.sessionId}`,
		`model: ${info.model ?? "(none)"}`,
		`home: ${info.home}`,
	].join("\n");
}

/**
 * Render agent.yml `sections:` once. Each failure (missing file, failing or
 * slow command, oversized output) warns and drops that section; the caller
 * routes warnings to the UI so they're visible at startup.
 */
export function renderSections(
	entries: SectionEntry[],
	env: Record<string, string>,
	warn: (msg: string) => void,
): Array<{ name: string; content: string }> {
	const out: Array<{ name: string; content: string }> = [];
	for (const entry of entries) {
		const content = entry.command
			? runSectionCommand(entry, env, warn)
			: readSectionFile(entry, warn);
		if (content === null) continue;
		const trimmed = content.replace(/\s+$/, "");
		if (trimmed) out.push({ name: entry.name, content: trimmed });
	}
	return out;
}

function readSectionFile(entry: SectionEntry, warn: (msg: string) => void): string | null {
	const path = resolvePath(entry.baseDir, entry.path!);
	if (!existsSync(path)) {
		warn(`kiln-lite: section '${entry.name}': file not found: ${path} — section omitted`);
		return null;
	}
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		warn(`kiln-lite: section '${entry.name}': failed to read ${path}: ${(err as Error).message} — section omitted`);
		return null;
	}
}

function runSectionCommand(
	entry: SectionEntry,
	env: Record<string, string>,
	warn: (msg: string) => void,
): string | null {
	const command = entry.command!;
	const label = command.length > 60 ? `${command.slice(0, 57)}…` : command;
	try {
		return execSync(command, {
			encoding: "utf8",
			timeout: SECTION_COMMAND_TIMEOUT_MS,
			maxBuffer: SECTION_COMMAND_MAX_BYTES,
			cwd: entry.baseDir,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string };
		let why: string;
		if (e.code === "ENOBUFS") why = `output exceeded ${SECTION_COMMAND_MAX_BYTES} bytes`;
		else if (e.signal === "SIGTERM") why = `timed out after ${SECTION_COMMAND_TIMEOUT_MS}ms`;
		else {
			const stderr = e.stderr ? String(e.stderr).trim().slice(0, 200) : "";
			why = `${e.message.split("\n")[0]}${stderr ? ` — stderr: ${stderr}` : ""}`;
		}
		warn(`kiln-lite: section '${entry.name}': command failed (${label}): ${why} — section omitted`);
		return null;
	}
}

/**
 * Apply kl's prompt edits to Pi's mutable systemPromptOptions. Pure apart
 * from mutating `options`; safe to call every turn (idempotent for the same
 * inputs). `session` is (re)inserted first among kl's sections so the order
 * is session → agent sections, after anything Pi or earlier handlers added.
 *
 * `selectedTools`: the tools whose guidelines to render. Pass the live
 * active set (pi.getActiveTools()): when no handler edits
 * `options.selectedTools`, Pi replaces it with the active set after the
 * before_agent_start handlers run, so the incoming value can be stale.
 */
export function applyPrompt(
	options: PromptOptionsLike,
	parts: PromptParts,
	session: SessionInfo,
	selectedTools: string[] = options.selectedTools,
): void {
	const toolRules = renderToolRules(selectedTools, options.toolGuidelines, options.promptGuidelines);
	options.customPrompt = buildCustomPrompt(parts.identity, parts.baseline, toolRules);

	if (!parts.projectContext) options.contextFiles = [];

	delete options.sections.session;
	for (const s of parts.sections) delete options.sections[s.name];
	options.sections.session = renderSessionSection(session);
	for (const s of parts.sections) options.sections[s.name] = s.content;
}

function resolvePath(base: string, p: string): string {
	return isAbsolute(p) ? p : join(base, p);
}

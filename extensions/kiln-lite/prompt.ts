/**
 * System prompt composition.
 *
 * kl never builds the whole prompt and never returns `systemPrompt` or sets
 * `forceSystemPrompt`. From a `before_agent_start` handler it edits Pi's
 * mutable `event.systemPromptOptions`, and Pi renders the rest:
 *
 *   preamble        = customPrompt = agent identity (prompt.identity, else
 *                     IDENTITY.md, else defaultIdentity) + <harness>: the
 *                     baseline (prompts/kl-baseline.md, {{placeholders}}
 *                     filled), <tools> (active tools' snippets), <rules>
 *                     (their guidelines + promptGuidelines). Pi drops its own
 *                     tools/rules/docs once customPrompt is set, so kl
 *                     re-renders the first two in Pi's format.
 *                     `include_kl_prompt: false` drops the whole <harness>.
 *   <addendum>        Pi: APPEND_SYSTEM.md / --append-system-prompt
 *                     (`include_appended_prompt: false` empties it)
 *   <project_context> Pi: AGENTS.md etc. (`include_project_context: false` empties it)
 *   <skills>          Pi
 *   <cwd>             Pi (always rendered)
 *   <session>         kl: agent, session id, model, home (no uuid, no cwd)
 *   <name>…           `prompt.extra_sections`
 *
 * The identity, baseline and extra sections (PromptParts) are read at session
 * start and again after a reset (exit_session continue).
 *
 * Pi records the prompt's sections in the transcript and appends only changed
 * sections later, so sections other extensions add survive, and a resumed
 * session whose files changed gets a section update, not a new prompt.
 */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentConfig, SectionEntry } from "./types.ts";

/** Hard caps for `extra_sections` commands (carried over from context_injection). */
export const SECTION_COMMAND_TIMEOUT_MS = 1000;
export const SECTION_COMMAND_MAX_BYTES = 64 * 1024;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KL_BASELINE_PATH = join(PACKAGE_ROOT, "prompts", "kl-baseline.md");

/** The subset of Pi's NormalizedBuildSystemPromptOptions kl touches. */
export interface PromptOptionsLike {
	customPrompt?: string;
	selectedTools: string[];
	toolSnippets?: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	appendSystemPrompt?: string;
}

/** The prompt text kl reads from files: at session start and after a reset. */
export interface PromptParts {
	/** Agent identity text, or null when the agent has none. */
	identity: string | null;
	/** kl baseline text, or null if the file couldn't be read. */
	baseline: string | null;
	/** Rendered `prompt.extra_sections`, in order. */
	sections: Array<{ name: string; content: string }>;
	/** false: no <harness> block (baseline, <tools>, <rules>). */
	klPrompt: boolean;
	/** false: no <addendum>. */
	appendedPrompt: boolean;
	/** false: no <project_context>. */
	projectContext: boolean;
}

export interface SessionInfo {
	agentName: string;
	sessionId: string;
	/** `provider/id`, or undefined if no model is selected. */
	model?: string;
	home: string;
	/** This session's inbox dir (~/.kl/run/inbox/<uuid>): the one place a UUID reaches the model. */
	inbox?: string;
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

/** The built-in identity: Pi's default, with the agent's name. */
export function defaultIdentity(name: string): string {
	return `You are ${name} - an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;
}

/**
 * Agent identity from config.prompt.identity (IDENTITY.md is defaulted in by
 * loadConfig). Missing (warns) or empty file: the built-in identity.
 */
export function loadIdentity(config: AgentConfig, warn: (msg: string) => void): string {
	const { identity, identity_base } = config.prompt;
	if (!identity) return defaultIdentity(config.name);
	const text = readPromptFile(resolvePath(identity_base, identity), "identity file", warn);
	return text ? text : defaultIdentity(config.name);
}

/** Everything applyPrompt needs from files. */
export function loadPromptParts(config: AgentConfig, env: Record<string, string>, warn: (msg: string) => void): PromptParts {
	const p = config.prompt;
	return {
		identity: loadIdentity(config, warn),
		baseline: p.include_kl_prompt ? loadBaseline(warn) : null,
		sections: renderSections(p.extra_sections, env, warn),
		klPrompt: p.include_kl_prompt,
		appendedPrompt: p.include_appended_prompt,
		projectContext: p.include_project_context,
	};
}

export function loadBaseline(
	warn: (msg: string) => void,
	path = KL_BASELINE_PATH,
	vars: Record<string, string | null> = baselineVars(),
): string | null {
	const text = readPromptFile(path, "kl baseline prompt", warn);
	return text ? fillPlaceholders(text, vars, warn) : null;
}

/**
 * The pi package dir, for the {{pi_*}} placeholders. Prefer the running pi
 * (walk up from process.argv[1], pi's cli.js), else PI_PACKAGE_DIR, else the
 * copy in kl's own node_modules. null if none is found.
 */
export function findPiPackageDir(): string | null {
	const isPi = (dir: string): boolean => {
		try {
			return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent";
		} catch {
			return false;
		}
	};
	try {
		let dir = dirname(realpathSync(process.argv[1] ?? ""));
		for (let i = 0; i < 6; i++, dir = dirname(dir)) if (isPi(dir)) return dir;
	} catch {
		// argv[1] missing or not a file
	}
	const env = process.env.PI_PACKAGE_DIR?.trim();
	if (env && isPi(env)) return env;
	const local = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
	return isPi(local) ? local : null;
}

/** Values for the baseline's {{placeholders}}: absolute doc paths. null = unknown. */
export function baselineVars(piDir: string | null = findPiPackageDir()): Record<string, string | null> {
	return {
		kl_docs: join(PACKAGE_ROOT, "docs"),
		pi_readme: piDir && join(piDir, "README.md"),
		pi_docs: piDir && join(piDir, "docs"),
		pi_examples: piDir && join(piDir, "examples"),
	};
}

/** Replace {{name}} with vars[name]. Unknown or unresolved names warn and stay as written. */
export function fillPlaceholders(text: string, vars: Record<string, string | null>, warn: (msg: string) => void): string {
	const warned = new Set<string>();
	return text.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
		const v = vars[name];
		if (typeof v === "string") return v;
		if (!warned.has(name)) {
			warned.add(name);
			warn(`kiln-lite: baseline placeholder {{${name}}} ${name in vars ? "could not be resolved" : "is unknown"} — left as written`);
		}
		return whole;
	});
}

/** The active tools with a snippet, in Pi's `<tools>` format: "- name: snippet". */
export function renderToolList(selectedTools: string[], toolSnippets: Record<string, string> = {}): string {
	return selectedTools
		.filter((name) => toolSnippets[name]?.trim())
		.map((name) => `- ${name}: ${toolSnippets[name].trim()}`)
		.join("\n");
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
	toolList = "",
): string {
	const harness: string[] = [];
	if (baseline) harness.push(baseline);
	if (toolList) harness.push(`<tools>\n${toolList}\n</tools>`);
	if (toolRules) harness.push(`<rules>\n${toolRules}\n</rules>`);
	const parts: string[] = [];
	if (identity) parts.push(identity);
	if (harness.length) parts.push(`<harness>\n${harness.join("\n\n")}\n</harness>`);
	return parts.join("\n\n");
}

export function renderSessionSection(info: SessionInfo): string {
	return [
		`agent: ${info.agentName}`,
		`session: ${info.sessionId}`,
		`model: ${info.model ?? "(none)"}`,
		`home: ${info.home}`,
		...(info.inbox ? [`inbox: ${info.inbox}`] : []),
	].join("\n");
}

/**
 * Render `prompt.extra_sections`. Each failure (missing file, failing or
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
	if (parts.klPrompt) {
		const toolRules = renderToolRules(selectedTools, options.toolGuidelines, options.promptGuidelines);
		const toolList = renderToolList(selectedTools, options.toolSnippets);
		options.customPrompt = buildCustomPrompt(parts.identity, parts.baseline, toolRules, toolList);
	} else {
		options.customPrompt = buildCustomPrompt(parts.identity, null, "");
	}

	if (!parts.appendedPrompt) options.appendSystemPrompt = "";
	if (!parts.projectContext) options.contextFiles = [];

	delete options.sections.session;
	for (const s of parts.sections) delete options.sections[s.name];
	options.sections.session = renderSessionSection(session);
	for (const s of parts.sections) options.sections[s.name] = s.content;
}

function resolvePath(base: string, p: string): string {
	return isAbsolute(p) ? p : join(base, p);
}

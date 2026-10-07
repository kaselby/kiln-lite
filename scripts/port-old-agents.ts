/**
 * One-off script, not part of kl: convert agent homes from the old
 * kiln-lite to the rewrite's schema, in place. kl itself keeps no
 * backward compatibility; this exists to port existing agents once.
 *
 *   npx tsx scripts/port-old-agents.ts [--dry-run] [agent-home…]
 *
 * With no arguments, <kl root>/config.yml and every agent under
 * $KL_AGENTS_DIR. Old homes at ~/.agent or ~/.kl/agent aren't moved:
 * mv them to $KL_AGENTS_DIR/<name>/ first. If an old install.sh ran
 * `pi install` on this repo, undo it with `pi remove <repo path>`.
 *
 * agent.yml (a copy goes to agent.yml.bak first):
 *   system_prompt, harness_prompt, sections → inside `prompt:`
 *     (identity, include_kl_prompt, extra_sections).
 *   project_context → external.project_context
 *     system_prompt naming a missing file is dropped (warn); harness_prompt
 *     naming a file is dropped (warn), false becomes include_kl_prompt: false.
 *   context_injection → prompt.extra_sections ({name: slug of label, path}); `dynamic` dropped (warn)
 *   startup, tools_dir, sessions_dir, inbox_dir → removed (warn)
 *   cleanup → {summary_path} becomes memory/sessions/<date>-<session name>.md
 *             wording; any other {placeholder} warns (kl expands none)
 * Files: SYSTEM.md → IDENTITY.md when it is the identity file in use; a
 * harness/pre-launch is left in place with a warning (kl has no pre-launch hook).
 * config.yml (config.yml.bak first): the same prompt keys move into `prompt:`.
 *
 * Edits are line-based so comments elsewhere survive: a removed key takes
 * its own lines, its indented body and the comment block directly above it.
 * Prints one line per key saying what it became.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";

import { DEFAULT_IDENTITY_FILE, RESERVED_SECTIONS, SECTION_NAME, resolveKlRoot } from "../extensions/kiln-lite/config.ts";
import { agentsDir, listAgents } from "../src/sessions/agents.ts";

const DROPPED: Record<string, string> = {
	startup: "kl runs no startup commands; use an extension",
	tools_dir: "kl no longer discovers shell tools",
	sessions_dir: "session ids live in the kl registry; summaries go to memory/sessions/",
	inbox_dir: "inboxes live at <kl root>/run/<uuid>/inbox/",
};

/** Top-level keys that now live inside `prompt:`. */
const OLD_PROMPT_KEYS = ["system_prompt", "harness_prompt", "sections"];
const PROMPT_KEY_ORDER = ["identity", "include_kl_prompt", "extra_sections"];
const PROMPT_COMMENT = "# System prompt: identity file, which parts to include, extra sections.";

/** null = remove the key (and the comment block above it); otherwise replace it with `lines`. */
type Edit = { lines: string[]; keepComments: boolean } | null;

export const SUMMARY_WORDING = "memory/sessions/<date>-<session name>.md (date as YYYY-MM-DD)";

export interface MigrateResult {
	home: string;
	changed: boolean;
	/** One line per key or file: what it became. */
	report: string[];
	warnings: string[];
	backup?: string;
}

export function slugify(label: string): string {
	let s = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
	if (!/^[a-z]/.test(s)) s = `s-${s}`.replace(/-+$/, "");
	return s;
}

/** Line ranges [start, end) of each top-level key, start including the comment block directly above. */
function keyBlocks(lines: string[]): Map<string, [number, number]> {
	const out = new Map<string, [number, number]>();
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(lines[i]);
		if (!m) continue;
		let start = i;
		while (start > 0 && /^#/.test(lines[start - 1])) start--;
		let end = i + 1;
		// Body: indented lines; blank lines count only if more indented lines follow.
		while (end < lines.length) {
			if (/^[ \t]/.test(lines[end])) end++;
			else if (lines[end].trim() === "") {
				let j = end;
				while (j < lines.length && lines[j].trim() === "") j++;
				if (j < lines.length && /^[ \t]/.test(lines[j])) end = j;
				else break;
			} else break;
		}
		out.set(m[1], [start, end]);
	}
	return out;
}

function dumpKey(key: string, value: unknown): string[] {
	return yaml.dump({ [key]: value }, { lineWidth: -1 }).replace(/\n$/, "").split("\n");
}

/** The commented `prompt:` and `external:` examples `kl init` writes (keep in step with bin/kl). */
export const INIT_PROMPT_COMMENTS = [
	"# prompt:",
	"#   identity: IDENTITY.md          # the default; a missing or empty file gives the built-in identity",
	"#   include_kl_prompt: true        # false drops kl's <harness> block (baseline, <tools>, <rules>)",
	"#   extra_sections:                # rendered once at session start, after <session>",
	"#     - {name: notes, path: notes.md}",
	'#     - {name: today, command: "date +%A"}',
	"# external:                  # what the agent picks up from outside itself and kl",
	"#   extensions: true         # base Pi's ~/.pi/agent/extensions",
	"#   skills: true             # false: only the agent's skills/ (no base Pi, global, project or installed skills)",
	"#   appended_prompt: true    # false drops APPEND_SYSTEM.md / --append-system-prompt",
	"#   project_context: true    # false drops AGENTS.md / CLAUDE.md",
].join("\n");

/**
 * Comments from older kl templates that describe behaviour kl no longer has.
 * Exact-text rewrites, so a user's own comments are never touched.
 */
const STALE_COMMENTS: Array<[RegExp, string]> = [
	[
		/^# Optional: path \(relative to \$AGENT_HOME\) of a file that replaces Pi's\n# built-in system prompt\. Omit to use Pi's default\.$/m,
		"# Identity prompt (prompt.identity): opens the system prompt.\n# Default: IDENTITY.md in this folder if present. Relative to this file.",
	],
	[
		// `kl init`'s commented examples before the prompt: block.
		/^# project_context: true     # false drops AGENTS.md\/CLAUDE.md from the prompt\n(# timestamps: true .*\n)# sections:                 # rendered once at session start, after <session>\n#   - \{name: notes, path: notes.md\}\n#   - \{name: today, command: "date \+%A"\}$/m,
		`$1${INIT_PROMPT_COMMENTS}`,
	],
	[/^# Cleanup turn dispatched when the session wraps via \/exit or \/wrapup\.$/m, "# Cleanup turn on /cleanup and the exit_session tool."],
	[/^# Supports template vars: \{today\} \{agent_id\} \{session_uuid\} \{summary_path\}$/m, "# Plain text: kl expands no {placeholders}."],
];

/** Rewrite stale template comments, and {summary_path} inside comment lines. */
export function refreshComments(text: string): string {
	let out = text;
	for (const [re, repl] of STALE_COMMENTS) out = out.replace(re, repl);
	return out
		.split("\n")
		.map((l) => (/^\s*#/.test(l) ? l.replace(/\{summary_path\}/g, SUMMARY_WORDING) : l))
		.join("\n");
}

/** Rewrite {summary_path}; return the new text and any other placeholders. */
export function migrateCleanupText(text: string): { text: string; others: string[] } {
	const out = text.replace(/\{summary_path\}/g, SUMMARY_WORDING);
	const others = [...new Set(out.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? [])];
	return { text: out, others };
}

function isMapping(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readDoc(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const raw = yaml.load(readFileSync(path, "utf8"));
		return isMapping(raw) ? raw : null;
	} catch {
		return null;
	}
}

/** The identity file <kl root>/config.yml sets, under the old or the new key. */
function globalIdentity(klRoot: string): string | undefined {
	const g = readDoc(join(klRoot, "config.yml"));
	if (!g) return undefined;
	if (typeof g.system_prompt === "string" && g.system_prompt.trim()) return g.system_prompt;
	if (isMapping(g.prompt) && typeof g.prompt.identity === "string" && g.prompt.identity.trim()) return g.prompt.identity;
	return undefined;
}

/**
 * Build the `prompt:` block from the old top-level keys (system_prompt is
 * the caller's: it passes the resolved `identity`), any existing `prompt:`
 * (its keys win), and sections converted from context_injection.
 * Returns null when there is nothing to write.
 */
function buildPromptBlock(
	doc: Record<string, unknown>,
	identity: string | undefined,
	addSections: Array<{ name: string; path: string }>,
	res: MigrateResult,
): Record<string, unknown> | null {
	const moved: Record<string, unknown> = {};
	if (identity !== undefined) moved.identity = identity;
	if ("harness_prompt" in doc) {
		const h = doc.harness_prompt;
		if (h === false || h === "") {
			moved.include_kl_prompt = false;
			res.report.push("harness_prompt: false → prompt.include_kl_prompt: false");
		} else {
			res.report.push("harness_prompt → removed");
			res.warnings.push(
				`harness_prompt dropped (${JSON.stringify(h)}): kl's prompt can't be swapped for another file. ` +
					"To replace it, move that text into the identity file and set prompt.include_kl_prompt: false",
			);
		}
	}
	if ("sections" in doc) {
		if (Array.isArray(doc.sections)) {
			moved.extra_sections = doc.sections;
			res.report.push("sections → prompt.extra_sections");
		} else res.warnings.push(`sections dropped (${JSON.stringify(doc.sections)}): not a list`);
	}

	// Nothing to move in: leave the file's prompt: (or its absence) alone.
	if (Object.keys(moved).length === 0 && !addSections.length) return null;
	const existing = isMapping(doc.prompt) ? doc.prompt : {};
	if ("prompt" in doc && !isMapping(doc.prompt)) res.warnings.push(`prompt was not a mapping (${JSON.stringify(doc.prompt)}): replaced`);
	const merged: Record<string, unknown> = { ...moved };
	for (const [k, v] of Object.entries(existing)) {
		if (k in moved) res.warnings.push(`prompt.${k} is already set: kept it, dropped the old key's value`);
		merged[k] = v;
	}
	if (addSections.length) {
		const list = Array.isArray(merged.extra_sections) ? merged.extra_sections : [];
		merged.extra_sections = [...list, ...addSections];
	}
	const ordered: Record<string, unknown> = {};
	for (const k of PROMPT_KEY_ORDER) if (k in merged) ordered[k] = merged[k];
	for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
	return ordered;
}

/**
 * Remove `remove` keys; write `block` as `prompt:` (in place of an existing
 * prompt:, else where the first removed key was, else at the end).
 */
function promptEdits(
	lines: string[],
	doc: Record<string, unknown>,
	remove: string[],
	block: Record<string, unknown> | null,
	edits: Map<string, Edit>,
): string[] | null {
	for (const k of remove) edits.set(k, null);
	if (!block) return null;
	const dumped = dumpKey("prompt", block);
	if ("prompt" in doc) {
		edits.set("prompt", { lines: dumped, keepComments: true });
		return null;
	}
	const blocks = keyBlocks(lines);
	const first = remove.filter((k) => blocks.has(k)).sort((a, b) => blocks.get(a)![0] - blocks.get(b)![0])[0];
	if (first) {
		edits.set(first, { lines: [PROMPT_COMMENT, ...dumped], keepComments: false });
		return null;
	}
	return [PROMPT_COMMENT, ...dumped];
}

/**
 * Apply edits bottom-up, reword stale comments, append `append`. Throws if
 * a removed key survived or the result doesn't parse.
 */
function rewrite(original: string, edits: Map<string, Edit>, append: string[] | null, path: string): string {
	const lines = original.split("\n");
	const blocks = keyBlocks(lines);
	const ordered = [...edits.entries()]
		.filter(([k]) => blocks.has(k))
		.sort((a, b) => blocks.get(b[0])![0] - blocks.get(a[0])![0]);
	for (const [key, edit] of ordered) {
		const [start, end] = blocks.get(key)!;
		const keyLine = lines.slice(start, end).findIndex((l) => l.startsWith(key)) + start;
		if (edit === null) lines.splice(start, end - start);
		else if (!edit.keepComments) lines.splice(start, end - start, ...edit.lines);
		else {
			lines.splice(keyLine, end - keyLine, ...edit.lines);
			// Drop comment lines above it that document the old placeholders.
			for (let i = keyLine - 1; i >= start; i--) if (/template vars|\{summary_path\}/.test(lines[i])) lines.splice(i, 1);
		}
	}
	let out = refreshComments(lines.join("\n")).replace(/\n{3,}/g, "\n\n");
	if (append) out = `${out.replace(/\n*$/, "\n")}\n${append.join("\n")}\n`;
	const check = (yaml.load(out) ?? {}) as Record<string, unknown>;
	for (const [k, v] of edits) if ((v === null || !v.keepComments) && k !== "prompt" && k in check) throw new Error(`migrate: failed to remove ${k} from ${path}`);
	return out;
}

function writeWithBackup(path: string, text: string): string {
	let bak = `${path}.bak`;
	for (let i = 1; existsSync(bak); i++) bak = `${path}.bak.${i}`;
	copyFileSync(path, bak);
	writeFileSync(path, text);
	return bak;
}

export function migrateHome(homeArg: string, opts: { dryRun?: boolean; klRoot?: string } = {}): MigrateResult {
	const home = resolve(homeArg);
	const res: MigrateResult = { home, changed: false, report: [], warnings: [] };
	const ymlPath = join(home, "agent.yml");
	if (!existsSync(ymlPath)) {
		res.warnings.push(`no agent.yml in ${home}`);
		return res;
	}
	const original = readFileSync(ymlPath, "utf8");
	let doc: Record<string, unknown>;
	try {
		const raw = yaml.load(original);
		doc = isMapping(raw) ? raw : {};
	} catch (e) {
		res.warnings.push(`agent.yml is not valid YAML, not touched: ${(e as Error).message}`);
		return res;
	}

	const lines = original.split("\n");
	const edits = new Map<string, Edit>();

	// context_injection → prompt.extra_sections
	const ciSections: Array<{ name: string; path: string }> = [];
	if ("context_injection" in doc) {
		const ci = Array.isArray(doc.context_injection) ? doc.context_injection : [];
		const existing = [
			...(Array.isArray(doc.sections) ? doc.sections : []),
			...(isMapping(doc.prompt) && Array.isArray(doc.prompt.extra_sections) ? doc.prompt.extra_sections : []),
		] as Array<Record<string, unknown>>;
		const taken = new Set(existing.map((s) => String(s?.name ?? "")));
		for (const [i, e] of ci.entries()) {
			const entry = (e ?? {}) as Record<string, unknown>;
			const path = typeof entry.path === "string" ? entry.path : "";
			if (!path) {
				res.warnings.push(`context_injection[${i}] has no path: dropped`);
				continue;
			}
			const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : path.replace(/\.[^/.]+$/, "").split("/").pop()!;
			let name = slugify(label);
			if (RESERVED_SECTIONS.has(name) || !SECTION_NAME.test(name)) name = `${name}-file`;
			let n = name;
			for (let k = 2; taken.has(n); k++) n = `${name}-${k}`;
			taken.add(n);
			if (entry.dynamic) res.warnings.push(`context_injection '${label}': dynamic dropped (sections render once at session start)`);
			ciSections.push({ name: n, path });
		}
		if (ciSections.length === 0) {
			res.report.push(ci.length === 0 ? "context_injection: [] → removed (nothing to inject)" : "context_injection → removed (no usable entries)");
		} else {
			res.report.push(`context_injection → prompt.extra_sections: ${ciSections.map((a) => `${a.name} (${a.path})`).join(", ")}`);
		}
	}

	for (const [key, why] of Object.entries(DROPPED)) {
		if (!(key in doc)) continue;
		edits.set(key, null);
		res.report.push(`${key} → removed`);
		const v = doc[key];
		const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
		if (!empty || key !== "startup") res.warnings.push(`${key} dropped (${JSON.stringify(v)}): ${why}`);
	}

	// Identity: system_prompt → prompt.identity; SYSTEM.md → IDENTITY.md when it's the one in use.
	const systemMd = join(home, "SYSTEM.md");
	const identityMd = join(home, DEFAULT_IDENTITY_FILE);
	let identity: string | undefined;
	let renameSystemMd = false;
	if (typeof doc.system_prompt === "string") {
		const p = resolve(home, doc.system_prompt);
		if (!existsSync(p)) {
			res.report.push("system_prompt → removed");
			res.warnings.push(`system_prompt dropped: ${p} does not exist (${DEFAULT_IDENTITY_FILE} in the agent folder is used if present)`);
		} else if (p === systemMd) {
			renameSystemMd = true;
			identity = DEFAULT_IDENTITY_FILE;
		} else {
			identity = doc.system_prompt;
			res.report.push(`system_prompt → prompt.identity: ${identity}`);
		}
	} else if (!("system_prompt" in doc) && !(isMapping(doc.prompt) && "identity" in doc.prompt) && existsSync(systemMd)) {
		const klRoot = opts.klRoot ?? resolveKlRoot();
		if (globalIdentity(klRoot) !== undefined) {
			res.report.push(`SYSTEM.md → left as is (not in use: ${join(klRoot, "config.yml")} sets the identity)`);
		} else renameSystemMd = true;
	}
	if (renameSystemMd) {
		if (existsSync(identityMd)) {
			identity = "SYSTEM.md";
			res.report.push("system_prompt → prompt.identity: SYSTEM.md");
			res.warnings.push(`both SYSTEM.md and ${DEFAULT_IDENTITY_FILE} exist: left both, prompt.identity: SYSTEM.md keeps the one in use`);
		} else {
			if (!opts.dryRun) {
				renameSync(systemMd, identityMd);
				const text = readFileSync(identityMd, "utf8");
				const fixed = text.replace(/an empty file means no identity prompt\./, "an empty file gives the built-in identity.");
				if (fixed !== text) writeFileSync(identityMd, fixed);
			}
			res.changed = true;
			res.report.push(`SYSTEM.md → ${DEFAULT_IDENTITY_FILE}${identity ? ` (prompt.identity: ${identity})` : ""}`);
		}
	}

	if ("project_context" in doc) {
		edits.set("project_context", { lines: dumpKey("external", { project_context: doc.project_context }), keepComments: true });
		res.report.push("project_context → external.project_context");
	}

	const remove = [...OLD_PROMPT_KEYS, "context_injection"].filter((k) => k in doc);
	const block = buildPromptBlock(doc, identity, ciSections, res);
	const append = promptEdits(lines, doc, remove, block, edits);

	if ("cleanup" in doc) {
		const c = doc.cleanup;
		if (typeof c === "string") {
			const { text, others } = migrateCleanupText(c);
			if (text !== c) {
				edits.set("cleanup", { lines: dumpKey("cleanup", text), keepComments: true });
				res.report.push(`cleanup: {summary_path} → "${SUMMARY_WORDING}"`);
			} else res.report.push("cleanup → kept");
			if (others.length) res.warnings.push(`cleanup still has ${others.join(" ")}: kl expands no placeholders; reword them`);
		} else if (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string") {
			const file = resolve(home, (c as { path: string }).path);
			if (existsSync(file)) {
				const before = readFileSync(file, "utf8");
				const { text, others } = migrateCleanupText(before);
				if (text !== before) {
					if (!opts.dryRun) {
						copyFileSync(file, `${file}.bak`);
						writeFileSync(file, text);
					}
					res.changed = true;
					res.report.push(`cleanup file ${file}: {summary_path} rewritten (backup ${file}.bak)`);
				} else res.report.push(`cleanup: path ${file} → kept`);
				if (others.length) res.warnings.push(`${file} still has ${others.join(" ")}: kl expands no placeholders; reword them`);
			} else res.report.push(`cleanup: path ${file} → kept (file missing; kl will warn)`);
		}
	}

	const commentsStale = refreshComments(original) !== original;
	if (edits.size > 0 || append || commentsStale) {
		const out = rewrite(original, edits, append, ymlPath);
		if (commentsStale) res.report.push("comments from the old template → reworded");
		if (!opts.dryRun) res.backup = writeWithBackup(ymlPath, out);
		res.changed = true;
	}

	const oldHook = join(home, "harness", "pre-launch");
	if (existsSync(oldHook)) res.warnings.push(`${oldHook} is no longer run: kl has no pre-launch hook; use an extension`);

	if (!res.changed && res.report.length === 0) res.report.push("nothing to migrate");
	return res;
}

/** Move the old prompt keys in <kl root>/config.yml into `prompt:`. Null when there's no config.yml. */
export function migrateGlobalConfig(klRoot: string, opts: { dryRun?: boolean } = {}): MigrateResult | null {
	const path = join(klRoot, "config.yml");
	if (!existsSync(path)) return null;
	const res: MigrateResult = { home: path, changed: false, report: [], warnings: [] };
	const original = readFileSync(path, "utf8");
	let doc: Record<string, unknown>;
	try {
		const raw = yaml.load(original);
		doc = isMapping(raw) ? raw : {};
	} catch (e) {
		res.warnings.push(`config.yml is not valid YAML, not touched: ${(e as Error).message}`);
		return res;
	}
	let identity: string | undefined;
	if (typeof doc.system_prompt === "string") {
		identity = doc.system_prompt;
		res.report.push(`system_prompt → prompt.identity: ${identity}`);
	}
	const remove = OLD_PROMPT_KEYS.filter((k) => k in doc);
	if (remove.length === 0) {
		res.report.push("nothing to migrate");
		return res;
	}
	const edits = new Map<string, Edit>();
	const block = buildPromptBlock(doc, identity, [], res);
	const append = promptEdits(original.split("\n"), doc, remove, block, edits);
	const out = rewrite(original, edits, append, path);
	if (!opts.dryRun) res.backup = writeWithBackup(path, out);
	res.changed = true;
	return res;
}

function printResult(r: MigrateResult, dryRun: boolean): void {
	process.stdout.write(`${r.home}${dryRun ? " (dry run)" : ""}\n`);
	for (const l of r.report) process.stdout.write(`  ${l}\n`);
	for (const w of r.warnings) process.stdout.write(`  warning: ${w}\n`);
	if (r.backup) process.stdout.write(`  backup: ${r.backup}\n`);
}

function main(argv: string[]): number {
	const dryRun = argv.includes("--dry-run") || argv.includes("-n");
	const args = argv.filter((a) => a !== "--dry-run" && a !== "-n");
	if (args.some((a) => a === "-h" || a === "--help")) {
		process.stdout.write("usage: npx tsx scripts/port-old-agents.ts [--dry-run] [agent-home…]   (default: <kl root>/config.yml and every agent in $KL_AGENTS_DIR)\n");
		return 0;
	}
	let failed = 0;
	if (args.length === 0) {
		try {
			const g = migrateGlobalConfig(resolveKlRoot(), { dryRun });
			if (g) printResult(g, dryRun);
		} catch (e) {
			failed++;
			process.stderr.write(`port-old-agents: config.yml: ${(e as Error).message}\n`);
		}
	}
	const homes = args.length ? args : listAgents().map((a) => join(agentsDir(), a.name));
	if (homes.length === 0) {
		process.stderr.write(`port-old-agents: no agents in ${agentsDir()}\n`);
		return 1;
	}
	for (const h of homes) {
		try {
			printResult(migrateHome(h, { dryRun }), dryRun);
		} catch (e) {
			failed++;
			process.stderr.write(`port-old-agents: ${h}: ${(e as Error).message}\n`);
		}
	}
	return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
	process.exitCode = main(process.argv.slice(2));
}

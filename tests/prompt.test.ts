import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	applyPrompt,
	buildCustomPrompt,
	renderToolList,
	fillPlaceholders,
	loadBaseline,
	loadIdentity,
	defaultIdentity,
	loadAgentBaseline,
	renderSections,
	renderSessionSection,
	renderToolRules,
	stripComments,
	type PromptOptionsLike,
	type PromptParts,
} from "../extensions/kiln-lite/prompt.ts";
import { defaultConfig } from "../extensions/kiln-lite/config.ts";
import type { SectionEntry } from "../extensions/kiln-lite/types.ts";

// Pi's renderer is not in the package exports; import it by file path.
// Dynamic import: tsx runs this file as CJS, and pi-ai is ESM-only.
const PI_SYSTEM_PROMPT = "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
async function piRenderer(): Promise<{
	buildSystemPrompt: (o: unknown) => string;
	normalizeBuildSystemPromptOptions: (o: unknown) => Record<string, unknown>;
}> {
	return import(PI_SYSTEM_PROMPT);
}

const SESSION = { agentName: "scout", sessionId: "scout-quiet-fox", model: "openai-codex/gpt-5.6-luna", home: "/agents/scout" };

function options(over: Partial<PromptOptionsLike> = {}): PromptOptionsLike {
	return {
		selectedTools: ["read", "bash"],
		toolGuidelines: {},
		promptGuidelines: [],
		sections: {},
		contextFiles: [],
		...over,
	};
}

function parts(over: Partial<PromptParts> = {}): PromptParts {
	return { identity: "I am scout.", baseline: "kl baseline.", sections: [], projectContext: true, ...over };
}

// --- renderToolRules ---

test("renderToolRules: selected tools in order, then promptGuidelines, trimmed + deduped", () => {
	const out = renderToolRules(
		["bash", "read", "edit"],
		{
			read: ["Use read for files", "Shared rule"],
			bash: ["  Prefer rg  ", "Shared rule"],
			write: ["not selected"],
		},
		["Shared rule", "Global rule", ""],
	);
	assert.equal(out, ["- Prefer rg", "- Shared rule", "- Use read for files", "- Global rule"].join("\n"));
});

test("renderToolRules: omits Pi's hard-coded rules", () => {
	const out = renderToolRules(["bash"], {}, []);
	assert.equal(out, "");
});

test("buildCustomPrompt: identity, then <harness> holding baseline → <tools> → <rules>; skips empty parts", () => {
	assert.equal(buildCustomPrompt("ID", "BASE", "- r"), "ID\n\n<harness>\nBASE\n\n<rules>\n- r\n</rules>\n</harness>");
	assert.equal(buildCustomPrompt("ID", "BASE", "- r", "- read: R"), "ID\n\n<harness>\nBASE\n\n<tools>\n- read: R\n</tools>\n\n<rules>\n- r\n</rules>\n</harness>");
	assert.equal(buildCustomPrompt(null, "BASE", ""), "<harness>\nBASE\n</harness>");
	assert.equal(buildCustomPrompt("ID", null, ""), "ID");
	assert.equal(buildCustomPrompt(null, null, ""), "");
});

test("renderToolList: active tools with a snippet, in order, Pi's format", () => {
	assert.equal(renderToolList(["read", "bash", "plan"], { plan: "Track work", read: " Read files " }), "- read: Read files\n- plan: Track work");
	assert.equal(renderToolList(["read"], undefined), "");
});

test("fillPlaceholders: known names filled; unknown or unresolved warn once and stay", () => {
	const warnings: string[] = [];
	const out = fillPlaceholders("a {{kl_docs}}/cli.md {{ pi_docs }} {{nope}} {{nope}} {{pi_readme}}", { kl_docs: "/kl/docs", pi_docs: "/pi/docs", pi_readme: null }, (m) => warnings.push(m));
	assert.equal(out, "a /kl/docs/cli.md /pi/docs {{nope}} {{nope}} {{pi_readme}}");
	assert.equal(warnings.length, 2);
	assert.match(warnings.join("\n"), /\{\{nope\}\} is unknown/);
	assert.match(warnings.join("\n"), /\{\{pi_readme\}\} could not be resolved/);
});

test("renderSessionSection: agent, session, model, home — no uuid, no cwd", () => {
	const s = renderSessionSection(SESSION);
	assert.equal(s, "agent: scout\nsession: scout-quiet-fox\nmodel: openai-codex/gpt-5.6-luna\nhome: /agents/scout");
	assert.equal(renderSessionSection({ ...SESSION, model: undefined }).includes("model: (none)"), true);
});

test("stripComments drops HTML comments and outer whitespace", () => {
	assert.equal(stripComments("<!-- note -->\n\nHello\n<!--x\ny-->world\n\n"), "Hello\nworld");
});

// --- applyPrompt ---

test("applyPrompt: customPrompt = identity → baseline → tool rules from the passed active tools", () => {
	const opts = options({
		selectedTools: ["read"],
		toolGuidelines: { read: ["R"], bash: ["B"] },
		promptGuidelines: ["G"],
	});
	applyPrompt(opts, parts(), SESSION, ["bash"]);
	assert.equal(opts.customPrompt, "I am scout.\n\n<harness>\nkl baseline.\n\n<rules>\n- B\n- G\n</rules>\n</harness>");
});

test("applyPrompt: session section first, then agent sections in order, after pre-existing sections", () => {
	const opts = options({ sections: { other_ext: "keep me", notes: "stale" } });
	applyPrompt(opts, parts({ sections: [{ name: "notes", content: "N" }, { name: "today", content: "T" }] }), SESSION);
	assert.deepEqual(Object.keys(opts.sections), ["other_ext", "session", "notes", "today"]);
	assert.equal(opts.sections.other_ext, "keep me");
	assert.equal(opts.sections.notes, "N");
});

test("applyPrompt: idempotent across turns", () => {
	const opts = options();
	const p = parts({ sections: [{ name: "notes", content: "N" }] });
	applyPrompt(opts, p, SESSION);
	const first = JSON.stringify(opts);
	applyPrompt(opts, p, SESSION);
	assert.equal(JSON.stringify(opts), first);
});

test("applyPrompt: project_context false empties contextFiles; true leaves them", () => {
	const files = [{ path: "/p/AGENTS.md", content: "x" }];
	const off = options({ contextFiles: [...files] });
	applyPrompt(off, parts({ projectContext: false }), SESSION);
	assert.deepEqual(off.contextFiles, []);
	const on = options({ contextFiles: [...files] });
	applyPrompt(on, parts(), SESSION);
	assert.deepEqual(on.contextFiles, files);
});

test("applyPrompt: never sets forceSystemPrompt", () => {
	const opts = options() as PromptOptionsLike & { forceSystemPrompt?: string };
	applyPrompt(opts, parts(), SESSION);
	assert.equal("forceSystemPrompt" in opts, false);
});

// --- identity / baseline ---

test("loadIdentity reads system_prompt relative to its base; missing file warns", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-prompt-test-"));
	writeFileSync(join(dir, "SYSTEM.md"), "<!-- human note -->\nI am scout.\n");
	const config = { ...defaultConfig(dir), system_prompt: "SYSTEM.md", system_prompt_base: dir };
	const warnings: string[] = [];
	assert.equal(loadIdentity(config, (m) => warnings.push(m)), "I am scout.");
	const dflt = defaultIdentity(config.name);
	assert.equal(loadIdentity({ ...config, system_prompt: "nope.md" }, (m) => warnings.push(m)), dflt, "missing file → warn, default");
	assert.equal(warnings.length, 1);
	assert.equal(loadIdentity(defaultConfig(dir), (m) => warnings.push(m)), dflt, "no system_prompt → default, no warning");
	assert.equal(warnings.length, 1);
});

test("loadAgentBaseline: harness_prompt replaces kl's (relative to its base); false drops it", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-prompt-test-"));
	writeFileSync(join(dir, "mine.md"), "<!-- x -->\nMy harness. Docs: {{kl_docs}}\n");
	const config = defaultConfig(dir);
	const warnings: string[] = [];
	const own = loadAgentBaseline({ ...config, harness_prompt: "mine.md", harness_prompt_base: dir }, (m) => warnings.push(m))!;
	assert.match(own, /^My harness\. Docs: \/.*docs$/);
	assert.equal(loadAgentBaseline({ ...config, harness_prompt: false }, (m) => warnings.push(m)), null);
	assert.ok(loadAgentBaseline(config, (m) => warnings.push(m))!.includes("kiln_lite"), "unset → kl's baseline");
	assert.deepEqual(warnings, []);
});

test("loadBaseline loads the shipped baseline: placeholders filled, comments stripped, no warnings", () => {
	const warnings: string[] = [];
	const text = loadBaseline((m) => warnings.push(m));
	assert.ok(text && text.length > 0);
	assert.ok(!text!.includes("{{"), "every placeholder filled");
	assert.ok(!text!.includes("<!--"), "comments stripped");
	assert.deepEqual(warnings, []);
});

// --- renderSections ---

function section(dir: string, e: Omit<SectionEntry, "baseDir">): SectionEntry {
	return { ...e, baseDir: dir };
}

test("renderSections: path ok, missing path warns, command ok with env + cwd", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-sections-test-"));
	writeFileSync(join(dir, "notes.md"), "my notes\n\n");
	const warnings: string[] = [];
	const out = renderSections(
		[
			section(dir, { name: "notes", path: "notes.md" }),
			section(dir, { name: "gone", path: "missing.md" }),
			section(dir, { name: "who", command: 'printf "%s in %s" "$AGENT_ID" "$(basename "$PWD")"' }),
		],
		{ AGENT_ID: "scout-quiet-fox" },
		(m) => warnings.push(m),
	);
	assert.deepEqual(out, [
		{ name: "notes", content: "my notes" },
		{ name: "who", content: `scout-quiet-fox in ${dir.split("/").pop()}` },
	]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /section 'gone': file not found/);
});

test("renderSections: failing command warns (exit 1)", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-sections-test-"));
	const warnings: string[] = [];
	const out = renderSections([section(dir, { name: "bad", command: "echo oops >&2; exit 1" })], {}, (m) =>
		warnings.push(m),
	);
	assert.deepEqual(out, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /section 'bad': command failed/);
	assert.match(warnings[0], /oops/);
});

test("renderSections: slow command times out (~1s) and warns", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-sections-test-"));
	const warnings: string[] = [];
	const t0 = Date.now();
	const out = renderSections([section(dir, { name: "slow", command: "sleep 2" })], {}, (m) => warnings.push(m));
	const elapsed = Date.now() - t0;
	assert.deepEqual(out, []);
	assert.ok(elapsed < 1900, `took ${elapsed}ms`);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /timed out after 1000ms/);
});

test("renderSections: oversized output (>64KiB) warns", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-sections-test-"));
	const warnings: string[] = [];
	const out = renderSections(
		[section(dir, { name: "big", command: "head -c 70000 /dev/zero | tr '\\0' x" })],
		{},
		(m) => warnings.push(m),
	);
	assert.deepEqual(out, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /exceeded 65536 bytes/);
});

// --- integration: Pi's own renderer ---

test("Pi renders kl's edits in order: preamble < addendum < project_context < skills < cwd < session < agent sections", async () => {
	const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await piRenderer();
	const opts = normalizeBuildSystemPromptOptions({
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read files", bash: "Run commands" },
		toolGuidelines: { read: ["Use read to inspect files"] },
		promptGuidelines: ["Extension guideline"],
		appendSystemPrompt: "ADDENDUM TEXT",
		cwd: "/work/dir",
		contextFiles: [{ path: "/work/dir/AGENTS.md", content: "PROJECT RULES" }],
		skills: [
			{
				name: "demo",
				description: "A demo skill",
				filePath: "/skills/demo/SKILL.md",
				baseDir: "/skills/demo",
				source: "test",
				disableModelInvocation: false,
			},
		],
	});
	applyPrompt(
		opts as unknown as PromptOptionsLike,
		parts({ sections: [{ name: "notes", content: "NOTES" }, { name: "today", content: "TODAY" }] }),
		SESSION,
	);
	const text: string = buildSystemPrompt(opts);

	assert.ok(text.startsWith("I am scout.\n\n<harness>\nkl baseline.\n\n<tools>\n- read: Read files\n- bash: Run commands\n</tools>\n\n<rules>\n- Use read to inspect files\n- Extension guideline\n</rules>"), text.slice(0, 400));
	// Pi's top block is gone.
	assert.ok(!text.includes("expert coding assistant"));
	assert.ok(!text.includes("Be concise in your responses"));
	assert.ok(!text.includes("Pi documentation"));
	assert.equal(text.split("<tools>").length, 2, "exactly one <tools>, kl's");

	const at = (needle: string) => {
		const i = text.indexOf(needle);
		assert.notEqual(i, -1, `missing ${needle}`);
		return i;
	};
	const order = [
		at("<rules>"),
		at("<addendum>"),
		at("<project_context>"),
		at("<skills>"),
		at("<cwd>"),
		at("<session>"),
		at("<notes>"),
		at("<today>"),
	];
	assert.deepEqual([...order].sort((a, b) => a - b), order, `order wrong:\n${text}`);
	assert.ok(text.includes("<session>\nagent: scout\nsession: scout-quiet-fox\nmodel: openai-codex/gpt-5.6-luna\nhome: /agents/scout\n</session>"));
});

test("Pi integration: project_context false drops the <project_context> section", async () => {
	const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = await piRenderer();
	const opts = normalizeBuildSystemPromptOptions({
		cwd: "/w",
		contextFiles: [{ path: "/w/AGENTS.md", content: "PROJECT RULES" }],
	});
	applyPrompt(opts as unknown as PromptOptionsLike, parts({ projectContext: false }), SESSION);
	const text: string = buildSystemPrompt(opts);
	assert.ok(!text.includes("<project_context>"));
	assert.ok(!text.includes("PROJECT RULES"));
});

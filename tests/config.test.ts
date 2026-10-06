import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadConfig,
	parseSections,
	parseTimestamps,
	DEFAULT_TIMESTAMPS,
	resolveUserName,
} from "../extensions/kiln-lite/config.ts";

function scratch(): { klRoot: string; agentHome: string } {
	const root = mkdtempSync(join(tmpdir(), "kl-config-test-"));
	const klRoot = join(root, "kl");
	const agentHome = join(root, "agents", "scout");
	mkdirSync(klRoot, { recursive: true });
	mkdirSync(agentHome, { recursive: true });
	return { klRoot, agentHome };
}

function load(klRoot: string, agentHome: string) {
	const warnings: string[] = [];
	const config = loadConfig({ agentHome, klRoot, warn: (m) => warnings.push(m) });
	return { config, warnings };
}

test("defaults: no files → name from dir, project_context on, default timestamps, no sections", () => {
	const { klRoot, agentHome } = scratch();
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.name, "scout");
	assert.equal(config.project_context, true);
	assert.deepEqual(config.timestamps, DEFAULT_TIMESTAMPS);
	assert.deepEqual(config.sections, []);
	assert.equal(config.system_prompt, undefined);
	assert.equal(config.model, undefined);
	assert.deepEqual(warnings, []);
});

test("global config.yml applies; agent.yml overrides key by key", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(
		join(klRoot, "config.yml"),
		"model: openai-codex/gpt-5.6-luna\nthinking: low\nproject_context: false\ntimestamps: false\n",
	);
	writeFileSync(join(agentHome, "agent.yml"), "thinking: high\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.model, "openai-codex/gpt-5.6-luna", "global model kept");
	assert.equal(config.thinking, "high", "agent overrides thinking");
	assert.equal(config.project_context, false, "global project_context kept");
	assert.equal(config.timestamps, false);
	assert.deepEqual(warnings, []);
});

test("sections: agent list replaces the global list wholesale (no deep merge)", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "sections:\n  - {name: house, path: house.md}\n");
	writeFileSync(join(agentHome, "agent.yml"), "sections:\n  - {name: notes, path: notes.md}\n");
	const { config } = load(klRoot, agentHome);
	assert.deepEqual(config.sections.map((s) => s.name), ["notes"]);
});

test("relative paths resolve against the dir of the declaring file", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(
		join(klRoot, "config.yml"),
		"system_prompt: prompts/house.md\nsections:\n  - {name: house, path: house.md}\n",
	);
	let { config } = load(klRoot, agentHome);
	assert.equal(config.system_prompt, "prompts/house.md");
	assert.equal(config.system_prompt_base, klRoot);
	assert.equal(config.sections[0].baseDir, klRoot);

	writeFileSync(join(agentHome, "agent.yml"), "system_prompt: me.md\nsections:\n  - {name: today, command: date}\n");
	({ config } = load(klRoot, agentHome));
	assert.equal(config.system_prompt, "me.md");
	assert.equal(config.system_prompt_base, agentHome);
	assert.equal(config.sections[0].baseDir, agentHome);
	assert.equal(config.sections[0].command, "date");
});

test("SYSTEM.md in the agent dir is the default system_prompt", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "SYSTEM.md"), "I am scout.\n");
	const { config } = load(klRoot, agentHome);
	assert.equal(config.system_prompt, "SYSTEM.md");
	assert.equal(config.system_prompt_base, agentHome);
});

test("explicit system_prompt wins over SYSTEM.md (global or agent)", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "SYSTEM.md"), "I am scout.\n");
	writeFileSync(join(klRoot, "config.yml"), "system_prompt: house.md\n");
	const { config } = load(klRoot, agentHome);
	assert.equal(config.system_prompt, "house.md");
	assert.equal(config.system_prompt_base, klRoot);
});

test("name/description are agent-only: ignored with a warning in the global file", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "name: everyone\ndescription: global\n");
	writeFileSync(join(agentHome, "agent.yml"), "description: the calendar agent\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.name, "scout");
	assert.equal(config.description, "the calendar agent");
	assert.equal(warnings.filter((w) => w.includes("per-agent only")).length, 2);
});

test("unknown keys warn and are ignored (e.g. retired context_injection)", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "agent.yml"), "context_injection: []\ntools_dir: tools\n");
	const { warnings } = load(klRoot, agentHome);
	assert.ok(warnings.some((w) => w.includes("unknown field 'context_injection'")));
	assert.ok(warnings.some((w) => w.includes("unknown field 'tools_dir'")));
});

test("invalid values warn and keep the lower layer", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "thinking: low\n");
	writeFileSync(join(agentHome, "agent.yml"), "thinking: turbo\nproject_context: nope\nname: Bad-Name\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.thinking, "low");
	assert.equal(config.project_context, true);
	assert.equal(config.name, "scout");
	assert.equal(warnings.length, 3);
});

test("malformed YAML warns and is ignored", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "agent.yml"), "model: [unclosed\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.model, undefined);
	assert.ok(warnings.some((w) => w.includes("failed to parse agent.yml")));
});

test("KL_ROOT env is the default kl root when klRoot isn't passed", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "model: env/root\n");
	const prev = process.env.KL_ROOT;
	process.env.KL_ROOT = klRoot;
	try {
		const config = loadConfig({ agentHome, warn: () => {} });
		assert.equal(config.model, "env/root");
	} finally {
		if (prev === undefined) delete process.env.KL_ROOT;
		else process.env.KL_ROOT = prev;
	}
});

// --- parseSections ---

test("parseSections: invalid names, reserved names, dupes, path+command all warn and skip", () => {
	const warnings: string[] = [];
	const out = parseSections(
		[
			{ name: "notes", path: "n.md" },
			{ name: "Notes", path: "n.md" },
			{ name: "1st", path: "n.md" },
			{ name: "session", path: "n.md" },
			{ name: "cwd", command: "pwd" },
			{ name: "skills", path: "n.md" },
			{ name: "notes", path: "other.md" },
			{ name: "both", path: "a", command: "b" },
			{ name: "neither" },
			"not-a-mapping",
			{ name: "today", command: "date" },
		],
		"/base",
		"agent.yml",
		(m) => warnings.push(m),
	);
	assert.deepEqual(
		out?.map((s) => s.name),
		["notes", "today"],
	);
	assert.equal(warnings.length, 9);
	assert.ok(warnings.some((w) => w.includes("'session' is a reserved")));
	assert.ok(warnings.some((w) => w.includes("duplicate section name 'notes'")));
	assert.ok(warnings.some((w) => w.includes("exactly one of 'path' or 'command'")));
});

test("parseSections: non-list warns and returns undefined", () => {
	const warnings: string[] = [];
	assert.equal(parseSections({ name: "x" }, "/b", "agent.yml", (m) => warnings.push(m)), undefined);
	assert.equal(warnings.length, 1);
});

// --- parseTimestamps ---

test("parseTimestamps: true / false / partial mapping / bad values", () => {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(m);
	assert.deepEqual(parseTimestamps(true, "t", warn), DEFAULT_TIMESTAMPS);
	assert.equal(parseTimestamps(false, "t", warn), false);
	assert.deepEqual(parseTimestamps({ per_turn: false, every_calls: 0 }, "t", warn), {
		...DEFAULT_TIMESTAMPS,
		per_turn: false,
		every_calls: 0,
	});
	assert.deepEqual(warnings, []);
	assert.deepEqual(parseTimestamps({ every_minutes: -1, bogus: 1 }, "t", warn), DEFAULT_TIMESTAMPS);
	assert.equal(warnings.length, 2);
	assert.equal(parseTimestamps("yes", "t", warn), undefined);
	assert.equal(warnings.length, 3);
});

test("user name: KL_USER, else config.yml user_name, else \"user\"; invalid values warn and fall through", () => {
	const { klRoot, agentHome } = scratch();
	const saved = process.env.KL_USER;
	try {
		delete process.env.KL_USER;
		assert.equal(resolveUserName(() => {}, klRoot), "user");
		writeFileSync(join(klRoot, "config.yml"), "user_name: sam\n");
		assert.equal(resolveUserName(() => {}, klRoot), "sam");
		process.env.KL_USER = "kas";
		assert.equal(resolveUserName(() => {}, klRoot), "kas");
		const warnings: string[] = [];
		process.env.KL_USER = "two words";
		assert.equal(resolveUserName((m) => warnings.push(m), klRoot), "sam");
		assert.equal(warnings.length, 1);
		// user_name is global-only: in agent.yml it warns
		const agentWarnings: string[] = [];
		writeFileSync(join(agentHome, "agent.yml"), "user_name: x\n");
		loadConfig({ agentHome, klRoot, warn: (m) => agentWarnings.push(m) });
		assert.ok(agentWarnings.some((m) => m.includes("user_name") && m.includes("config.yml")));
	} finally {
		if (saved === undefined) delete process.env.KL_USER;
		else process.env.KL_USER = saved;
	}
});

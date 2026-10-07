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

test("defaults: no files → name from dir, every prompt part on, default timestamps, no extra sections", () => {
	const { klRoot, agentHome } = scratch();
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.name, "scout");
	assert.equal(config.prompt.include_kl_prompt, true);
	assert.deepEqual(config.external, { extensions: true, skills: true, appended_prompt: true, project_context: true });
	assert.deepEqual(config.timestamps, DEFAULT_TIMESTAMPS);
	assert.deepEqual(config.prompt.extra_sections, []);
	assert.equal(config.prompt.identity, undefined);
	assert.equal(config.model, undefined);
	assert.deepEqual(warnings, []);
});

test("global config.yml applies; agent.yml overrides key by key", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "model: openai-codex/gpt-5.6-luna\nthinking: low\ntimestamps: false\n");
	writeFileSync(join(agentHome, "agent.yml"), "thinking: high\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.model, "openai-codex/gpt-5.6-luna", "global model kept");
	assert.equal(config.thinking, "high", "agent overrides thinking");
	assert.equal(config.timestamps, false);
	assert.deepEqual(warnings, []);
});

test("prompt: merges key by key across config.yml and agent.yml", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(
		join(klRoot, "config.yml"),
		"prompt:\n  identity: house.md\n  include_kl_prompt: false\n  extra_sections:\n    - {name: house, path: house.md}\n",
	);
	writeFileSync(join(agentHome, "agent.yml"), "prompt:\n  include_kl_prompt: true\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.deepEqual(warnings, []);
	assert.equal(config.prompt.identity, "house.md", "global identity kept");
	assert.equal(config.prompt.include_kl_prompt, true, "agent overrides a switch");
	assert.deepEqual(config.prompt.extra_sections.map((s) => s.name), ["house"], "global sections kept when the agent sets none");
});

test("prompt.extra_sections: agent list replaces the global list wholesale", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "prompt:\n  extra_sections:\n    - {name: house, path: house.md}\n");
	writeFileSync(join(agentHome, "agent.yml"), "prompt:\n  extra_sections:\n    - {name: notes, path: notes.md}\n");
	const { config } = load(klRoot, agentHome);
	assert.deepEqual(config.prompt.extra_sections.map((s) => s.name), ["notes"]);
});

test("relative paths resolve against the dir of the declaring file", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(
		join(klRoot, "config.yml"),
		"prompt:\n  identity: prompts/house.md\n  extra_sections:\n    - {name: house, path: house.md}\n",
	);
	let { config } = load(klRoot, agentHome);
	assert.equal(join(config.prompt.identity_base, config.prompt.identity!), join(klRoot, "prompts/house.md"));
	assert.equal(config.prompt.extra_sections[0].baseDir, klRoot);

	writeFileSync(join(agentHome, "agent.yml"), "prompt:\n  identity: me.md\n  extra_sections:\n    - {name: today, command: date}\n");
	({ config } = load(klRoot, agentHome));
	assert.equal(join(config.prompt.identity_base, config.prompt.identity!), join(agentHome, "me.md"));
	assert.equal(config.prompt.extra_sections[0].baseDir, agentHome);
	assert.equal(config.prompt.extra_sections[0].command, "date");
});

test("IDENTITY.md in the agent dir is the default identity", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "IDENTITY.md"), "I am scout.\n");
	const { config } = load(klRoot, agentHome);
	assert.equal(join(config.prompt.identity_base, config.prompt.identity!), join(agentHome, "IDENTITY.md"));
});

test("an explicit prompt.identity (global or agent) wins over IDENTITY.md", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "IDENTITY.md"), "I am scout.\n");
	writeFileSync(join(klRoot, "config.yml"), "prompt:\n  identity: house.md\n");
	const { config } = load(klRoot, agentHome);
	assert.equal(join(config.prompt.identity_base, config.prompt.identity!), join(klRoot, "house.md"));
});

test("the old top-level prompt keys get the plain unknown-key warning and do nothing", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(agentHome, "SYSTEM.md"), "I am scout.\n");
	writeFileSync(
		join(agentHome, "agent.yml"),
		"system_prompt: SYSTEM.md\nharness_prompt: false\nproject_context: false\nsections:\n  - {name: notes, path: notes.md}\n",
	);
	const { config, warnings } = load(klRoot, agentHome);
	for (const key of ["system_prompt", "harness_prompt", "project_context", "sections"]) {
		assert.ok(warnings.some((w) => w.includes(`unknown field '${key}'`)), key);
	}
	assert.equal(warnings.length, 4);
	assert.equal(config.prompt.identity, undefined, "SYSTEM.md is not picked up");
	assert.equal(config.prompt.include_kl_prompt, true);
	assert.equal(config.external.project_context, true);
	assert.deepEqual(config.prompt.extra_sections, []);
});

test("external: merges key by key across config.yml and agent.yml; old key names are unknown", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "external:\n  extensions: false\n  project_context: false\n  appended_prompt: false\n");
	writeFileSync(
		join(agentHome, "agent.yml"),
		"external:\n  appended_prompt: true\n  skills: false\n  bogus: 1\npi_extensions: true\nprompt:\n  include_project_context: true\n  include_appended_prompt: true\n",
	);
	const { config, warnings } = load(klRoot, agentHome);
	assert.deepEqual(config.external, { extensions: false, skills: false, appended_prompt: true, project_context: false });
	for (const key of ["external.bogus", "pi_extensions", "prompt.include_project_context", "prompt.include_appended_prompt"]) {
		assert.ok(warnings.some((w) => w.includes(`unknown field '${key}'`)), key);
	}
	assert.equal(warnings.length, 4);
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
	writeFileSync(join(agentHome, "agent.yml"), "thinking: turbo\nprompt:\n  include_kl_prompt: nope\n  identity: 3\n  nope: 1\nname: Bad-Name\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.thinking, "low");
	assert.equal(config.prompt.include_kl_prompt, true);
	assert.equal(config.prompt.identity, undefined);
	assert.equal(config.name, "scout");
	assert.equal(warnings.length, 5);
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

test("prompt: that isn't a mapping warns and keeps the lower layer", () => {
	const { klRoot, agentHome } = scratch();
	writeFileSync(join(klRoot, "config.yml"), "prompt:\n  include_kl_prompt: false\n");
	writeFileSync(join(agentHome, "agent.yml"), "prompt: off\n");
	const { config, warnings } = load(klRoot, agentHome);
	assert.equal(config.prompt.include_kl_prompt, false);
	assert.equal(warnings.length, 1);
});

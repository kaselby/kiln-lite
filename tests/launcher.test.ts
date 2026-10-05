import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
	agentExtensions,
	buildPiArgs,
	ensureKlPiDir,
	needsPersistence,
	plan,
	userSetsThinking,
	CORE_ENTRY,
	PERSISTENCE_ENTRY,
	CORE_SKILLS,
	REPO_ROOT,
} from "../src/launcher.ts";
import { defaultConfig } from "../extensions/kiln-lite/config.ts";

function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// --- ensureKlPiDir ---

test("ensureKlPiDir: symlinks existing shared files, writes settings, never copies", () => {
	const klRoot = tmp("kl-root-");
	const base = tmp("pi-base-");
	writeFileSync(join(base, "auth.json"), "{}");
	writeFileSync(join(base, "models.json"), "{}");
	// keybindings.json absent in base → no link

	const r = ensureKlPiDir(klRoot, base);
	assert.equal(r.dir, join(klRoot, "pi"));
	assert.ok(lstatSync(join(r.dir, "auth.json")).isSymbolicLink());
	assert.equal(readlinkSync(join(r.dir, "auth.json")), join(base, "auth.json"));
	assert.ok(lstatSync(join(r.dir, "models.json")).isSymbolicLink());
	assert.equal(existsSync(join(r.dir, "keybindings.json")), false);
	assert.deepEqual(JSON.parse(readFileSync(join(r.dir, "settings.json"), "utf8")), { defaultTools: ["+tool_search"] });
	assert.equal(r.created.length, 4);
});

test("ensureKlPiDir: idempotent; never overwrites an edited settings.json or existing files", () => {
	const klRoot = tmp("kl-root-");
	const base = tmp("pi-base-");
	writeFileSync(join(base, "auth.json"), "{}");
	ensureKlPiDir(klRoot, base);
	writeFileSync(join(klRoot, "pi", "settings.json"), '{"theme":"mine"}\n');
	const again = ensureKlPiDir(klRoot, base);
	assert.deepEqual(again.created, []);
	assert.equal(readFileSync(join(klRoot, "pi", "settings.json"), "utf8"), '{"theme":"mine"}\n');
});

// --- agentExtensions ---

test("agentExtensions: *.ts/*.js files and <sub>/index.*, sorted; skips others", () => {
	const home = tmp("kl-agent-");
	assert.deepEqual(agentExtensions(home), [], "no extensions dir");
	const ext = join(home, "extensions");
	mkdirSync(join(ext, "b-dir"), { recursive: true });
	mkdirSync(join(ext, "no-index"), { recursive: true });
	writeFileSync(join(ext, "b-dir", "index.ts"), "");
	writeFileSync(join(ext, "c.js"), "");
	writeFileSync(join(ext, "a.ts"), "");
	writeFileSync(join(ext, "types.d.ts"), "");
	writeFileSync(join(ext, "README.md"), "");
	writeFileSync(join(ext, ".hidden.ts"), "");
	assert.deepEqual(agentExtensions(home), [join(ext, "a.ts"), join(ext, "b-dir", "index.ts"), join(ext, "c.js")]);
});

// --- needsPersistence ---

test("needsPersistence: only with a non-empty cleanup", () => {
	const c = defaultConfig("/x");
	assert.equal(needsPersistence(c), false);
	assert.equal(needsPersistence({ ...c, cleanup: "   " }), false);
	assert.equal(needsPersistence({ ...c, cleanup: "wrap up" }), true);
	assert.equal(needsPersistence({ ...c, cleanup: { path: "prompts/cleanup.md" } }), true);
});

// --- userSetsThinking ---

test("userSetsThinking: --thinking, --model id:level, --model=id:level", () => {
	assert.equal(userSetsThinking([]), false);
	assert.equal(userSetsThinking(["--thinking", "high"]), true);
	assert.equal(userSetsThinking(["--thinking=high"]), true);
	assert.equal(userSetsThinking(["--model", "a/b:low"]), true);
	assert.equal(userSetsThinking(["--model=a/b:xhigh"]), true);
	assert.equal(userSetsThinking(["--model", "a/b"]), false);
	assert.equal(userSetsThinking(["--model", "ollama/llama3:8b"]), false, "non-level suffix");
});

// --- buildPiArgs ---

test("buildPiArgs: compact agent → core only, model/thinking defaults, -a, user args last", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "openai-codex/gpt-5.6-luna", thinking: "low" };
	assert.deepEqual(buildPiArgs({ agentHome: home, config, userArgs: ["-p", "hi"] }), [
		"-e",
		CORE_ENTRY,
		"--skill",
		CORE_SKILLS,
		"--model",
		"openai-codex/gpt-5.6-luna",
		"--thinking",
		"low",
		"-a",
		"-p",
		"hi",
	]);
});

test("buildPiArgs: full agent → core, persistence, agent extensions, --skill", () => {
	const home = tmp("kl-agent-");
	mkdirSync(join(home, "extensions"));
	mkdirSync(join(home, "skills"));
	writeFileSync(join(home, "extensions", "mine.ts"), "");
	const config = { ...defaultConfig(home), cleanup: "wrap up" };
	assert.deepEqual(buildPiArgs({ agentHome: home, config, userArgs: [] }), [
		"-e",
		CORE_ENTRY,
		"-e",
		PERSISTENCE_ENTRY,
		"-e",
		join(home, "extensions", "mine.ts"),
		"--skill",
		CORE_SKILLS,
		"--skill",
		join(home, "skills"),
		"-a",
	]);
});

test("buildPiArgs: user --model wins; thinking still defaulted unless the user's model has a level", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "x/default", thinking: "low" };
	let args = buildPiArgs({ agentHome: home, config, userArgs: ["--model", "y/mine"] });
	assert.ok(!args.includes("x/default"));
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "low"]);

	args = buildPiArgs({ agentHome: home, config, userArgs: ["--model=y/mine:high"] });
	assert.ok(!args.includes("--thinking"));

	args = buildPiArgs({ agentHome: home, config, userArgs: ["--thinking", "max"] });
	assert.equal(args.filter((a) => a === "--thinking").length, 1);
});

test("buildPiArgs: config model with a :level suffix suppresses config thinking", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "x/m:high", thinking: "low" };
	const args = buildPiArgs({ agentHome: home, config, userArgs: [] });
	assert.ok(args.includes("x/m:high"));
	assert.ok(!args.includes("--thinking"));
});

test("buildPiArgs: resume skips model/thinking defaults but keeps extensions", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "x/m", thinking: "low", cleanup: "c" };
	assert.deepEqual(buildPiArgs({ agentHome: home, config, userArgs: ["--session", "/s.jsonl"], resume: true }), [
		"-e",
		CORE_ENTRY,
		"-e",
		PERSISTENCE_ENTRY,
		"--skill",
		CORE_SKILLS,
		"-a",
		"--session",
		"/s.jsonl",
	]);
});

// --- plan / CLI ---

test("plan: reads merged config (global model) and validates the agent name", () => {
	const klRoot = tmp("kl-root-");
	const base = tmp("pi-base-");
	const home = join(tmp("kl-agents-"), "scout");
	mkdirSync(home);
	writeFileSync(join(klRoot, "config.yml"), "model: g/model\n");
	const p = plan({ agentHome: home, userArgs: [], klRoot, basePiDir: base });
	assert.equal(p.agentName, "scout");
	assert.equal(p.piDir, join(klRoot, "pi"));
	assert.ok(p.args.includes("g/model"));

	const bad = join(tmp("kl-agents-"), "Bad-Name");
	mkdirSync(bad);
	assert.throws(() => plan({ agentHome: bad, userArgs: [], klRoot, basePiDir: base }), /must match/);
});

test("CLI: plan prints NUL-separated piDir, name, argv", () => {
	const klRoot = tmp("kl-root-");
	const home = join(tmp("kl-agents-"), "scout");
	mkdirSync(home);
	writeFileSync(join(home, "agent.yml"), "name: scout\nmodel: a/b\n");
	const out = execFileSync(
		join(REPO_ROOT, "node_modules", ".bin", "tsx"),
		[join(REPO_ROOT, "src", "launcher.ts"), "plan", "--home", home, "--", "-p", "two words"],
		{ env: { ...process.env, KL_ROOT: klRoot, HOME: tmp("kl-fakehome-") }, encoding: "utf8" },
	);
	const recs = out.split("\0");
	assert.equal(recs.pop(), "");
	assert.deepEqual(recs, [join(klRoot, "pi"), "scout", "-e", CORE_ENTRY, "--skill", CORE_SKILLS, "--model", "a/b", "-a", "-p", "two words"]);
});

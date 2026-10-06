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
	plan,
	userSetsThinking,
	CORE_ENTRY,
	CORE_SKILLS,
	REPO_ROOT,
} from "../src/launcher.ts";
import { defaultConfig } from "../extensions/kiln-lite/config.ts";

function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A base pi dir with no extensions/, so buildPiArgs never reads the real ~/.pi/agent. */
const NO_PI = tmp("kl-nopi-");

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
	assert.equal(existsSync(join(r.dir, "settings.json")), false, "Pi's own defaults: kl writes no settings");
	assert.equal(r.created.length, 3);
});

test("ensureKlPiDir: idempotent; never overwrites settings.json or existing files", () => {
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
	assert.deepEqual(buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: ["-p", "hi"] }), [
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

test("buildPiArgs: full agent (cleanup set) → core only, then agent extensions, --skill (no persistence entry)", () => {
	const home = tmp("kl-agent-");
	mkdirSync(join(home, "extensions"));
	mkdirSync(join(home, "skills"));
	writeFileSync(join(home, "extensions", "mine.ts"), "");
	const config = { ...defaultConfig(home), cleanup: "wrap up" };
	assert.deepEqual(buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: [] }), [
		"-e",
		CORE_ENTRY,
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
	let args = buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: ["--model", "y/mine"] });
	assert.ok(!args.includes("x/default"));
	assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), ["--thinking", "low"]);

	args = buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: ["--model=y/mine:high"] });
	assert.ok(!args.includes("--thinking"));

	args = buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: ["--thinking", "max"] });
	assert.equal(args.filter((a) => a === "--thinking").length, 1);
});

test("buildPiArgs: config model with a :level suffix suppresses config thinking", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "x/m:high", thinking: "low" };
	const args = buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: [] });
	assert.ok(args.includes("x/m:high"));
	assert.ok(!args.includes("--thinking"));
});

test("buildPiArgs: resume skips model/thinking defaults but keeps extensions", () => {
	const home = tmp("kl-agent-");
	const config = { ...defaultConfig(home), model: "x/m", thinking: "low", cleanup: "c" };
	assert.deepEqual(buildPiArgs({ agentHome: home, basePiDir: NO_PI, config, userArgs: ["--session", "/s.jsonl"], resume: true }), [
		"-e",
		CORE_ENTRY,
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

test("base pi's global extensions load by default (Pi's discovery shapes), and not with pi_extensions: false", () => {
	const home = tmp("kl-agent-");
	const base = tmp("kl-basepi-");
	const ext = join(base, "extensions");
	mkdirSync(join(ext, "pkg"), { recursive: true });
	mkdirSync(join(ext, "plain"), { recursive: true });
	writeFileSync(join(ext, "a.ts"), "");
	writeFileSync(join(ext, "types.d.ts"), "");
	writeFileSync(join(ext, "pkg", "package.json"), JSON.stringify({ pi: { extensions: ["./src/main.ts"] } }));
	mkdirSync(join(ext, "pkg", "src"));
	writeFileSync(join(ext, "pkg", "src", "main.ts"), "");
	writeFileSync(join(ext, "plain", "index.ts"), "");
	const config = defaultConfig(home);
	const on = buildPiArgs({ agentHome: home, basePiDir: base, config, userArgs: [] });
	assert.deepEqual(on.slice(0, 8), ["-e", CORE_ENTRY, "-e", join(ext, "a.ts"), "-e", join(ext, "pkg", "src", "main.ts"), "-e", join(ext, "plain", "index.ts")]);
	const off = buildPiArgs({ agentHome: home, basePiDir: base, config: { ...config, pi_extensions: false }, userArgs: [] });
	assert.ok(!off.some((a) => a.startsWith(ext)));
});

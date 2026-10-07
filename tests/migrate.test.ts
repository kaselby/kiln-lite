import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../extensions/kiln-lite/config.ts";
import { loadIdentity } from "../extensions/kiln-lite/prompt.ts";
import { migrateGlobalConfig, migrateHome, slugify } from "../src/migrate.ts";

function emptyRoot(): string {
	return mkdtempSync(join(tmpdir(), "kl-root-"));
}

function loadClean(home: string, klRoot = emptyRoot()) {
	const warnings: string[] = [];
	const config = loadConfig({ agentHome: home, klRoot, warn: (m) => warnings.push(m) });
	return { config, warnings };
}

const OLD = `# top comment
name: rev

# Replaces Pi's prompt.
system_prompt: GONE.md

# Files prepended to the system prompt.
context_injection:
  - path: memory/core.md
    label: Core Memory
  - path: memory/volatile.md
    label: Working State
    dynamic: true
  # - path: x.md

startup:
  - "git pull"

# Supports template vars: {today} {summary_path}
cleanup: |
  Write a summary to {summary_path} for {today}.

tools_dir: tools
# keep me
model: x/y
`;

test("migrate: context_injection → prompt.extra_sections, drops dead keys, rewrites cleanup, keeps the rest; .bak; loads clean", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-"));
	writeFileSync(join(home, "agent.yml"), OLD);
	mkdirSync(join(home, "harness"));
	writeFileSync(join(home, "harness", "pre-launch"), "#!/bin/sh\n");
	const r = migrateHome(home, { klRoot: emptyRoot() });
	assert.equal(r.changed, true);
	assert.equal(readFileSync(join(home, "agent.yml.bak"), "utf8"), OLD);
	const out = readFileSync(join(home, "agent.yml"), "utf8");
	for (const gone of ["context_injection", "startup", "tools_dir", "system_prompt", "{summary_path}", "template vars", "Files prepended", "Replaces Pi"]) {
		assert.ok(!out.includes(gone), `${gone} should be gone:\n${out}`);
	}
	assert.match(out, /# top comment\nname: rev/);
	assert.match(out, /# keep me\nmodel: x\/y/);
	assert.match(out, /memory\/sessions\/<date>-<session name>\.md/);
	assert.ok(r.warnings.some((w) => w.includes("no pre-launch hook")));
	assert.ok(r.warnings.some((w) => w.includes("dynamic dropped")));
	assert.ok(r.warnings.some((w) => w.includes("{today}")));
	assert.ok(r.warnings.some((w) => w.includes("GONE.md")));
	const { config: c, warnings } = loadClean(home);
	assert.deepEqual(warnings, []);
	assert.deepEqual(c.prompt.extra_sections.map((s) => [s.name, s.path]), [["core-memory", "memory/core.md"], ["working-state", "memory/volatile.md"]]);
	assert.equal(migrateHome(home, { klRoot: emptyRoot() }).changed, false, "second run is a no-op");
});

test("slugify", () => {
	assert.equal(slugify("Core Memory"), "core-memory");
	assert.equal(slugify("  2nd: Notes! "), "s-2nd-notes");
});

test("migrate rewords comments from the old template, leaves the user's own comments", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-comments-"));
	const old = [
		"# my own note: replaces nothing",
		"name: rev",
		"",
		"# Optional: path (relative to $AGENT_HOME) of a file that replaces Pi's",
		"# built-in system prompt. Omit to use Pi's default.",
		"# system_prompt: prompts/base.md",
		"",
		"# Cleanup turn dispatched when the session wraps via /exit or /wrapup.",
		"# Supports template vars: {today} {agent_id} {session_uuid} {summary_path}",
		"# cleanup: |",
		"#   Write a session summary to {summary_path}",
		"",
	].join("\n");
	writeFileSync(join(home, "agent.yml"), old);
	const r = migrateHome(home, { klRoot: emptyRoot() });
	assert.ok(r.changed);
	assert.ok(r.report.includes("comments from the old template → reworded"));
	const out = readFileSync(join(home, "agent.yml"), "utf8");
	assert.doesNotMatch(out, /replaces Pi's|built-in system prompt|wrapup|template vars/);
	assert.match(out, /^# Identity prompt \(prompt\.identity\): opens the system prompt\.$/m);
	assert.match(out, /^# Cleanup turn on \/exit and the exit_session tool/m);
	assert.match(out, /^#   Write a session summary to memory\/sessions\/<date>-<session name>\.md/m);
	assert.match(out, /^# my own note: replaces nothing$/m);
	assert.equal(readFileSync(`${join(home, "agent.yml")}.bak`, "utf8"), old);
	// Second run: nothing left to do.
	assert.equal(migrateHome(home, { klRoot: emptyRoot() }).changed, false);
});

// What `kl init scout --full` wrote before the prompt: block existed.
const OLD_INIT_YML = `name: scout
description: ""

# Everything below is optional; ~/.kl/config.yml supplies defaults.
# model: openai-codex/gpt-5.6-luna
# thinking: medium
# project_context: true     # false drops AGENTS.md/CLAUDE.md from the prompt
# timestamps: true          # false, or {per_turn, every_calls, every_minutes}
# sections:                 # rendered once at session start, after <session>
#   - {name: notes, path: notes.md}
#   - {name: today, command: "date +%A"}

# Cleanup turn on /exit and exit_session; memory injected every session.
cleanup: { path: prompts/cleanup.md }
sections:
  - {name: memory, path: memory/MEMORY.md}
project_context: false
harness_prompt: false
`;
const OLD_SYSTEM_MD = `<!--
  Identity prompt for scout: who this agent is and how it works.
  It opens the system prompt, before the kl baseline. HTML comments like
  this one are stripped; an empty file means no identity prompt.
-->
I am scout.
`;

function oldInitHome(): string {
	const home = join(mkdtempSync(join(tmpdir(), "kl-migrate-init-")), "scout");
	mkdirSync(join(home, "memory"), { recursive: true });
	mkdirSync(join(home, "prompts"));
	writeFileSync(join(home, "agent.yml"), OLD_INIT_YML);
	writeFileSync(join(home, "SYSTEM.md"), OLD_SYSTEM_MD);
	writeFileSync(join(home, "prompts", "cleanup.md"), "Wrap up.\n");
	writeFileSync(join(home, "memory", "MEMORY.md"), "");
	return home;
}

test("migrate: an old kl init --full agent moves its prompt keys into prompt: and SYSTEM.md becomes IDENTITY.md", () => {
	const home = oldInitHome();
	const r = migrateHome(home, { klRoot: emptyRoot() });
	assert.equal(r.changed, true);
	assert.ok(!existsSync(join(home, "SYSTEM.md")));
	assert.ok(existsSync(join(home, "IDENTITY.md")));
	assert.doesNotMatch(readFileSync(join(home, "IDENTITY.md"), "utf8"), /empty file means no identity/);

	const { config, warnings } = loadClean(home);
	assert.deepEqual(warnings, [], "no unknown-key warnings left");
	assert.equal(loadIdentity(config, () => {}), "I am scout.", "same identity in use");
	assert.equal(config.prompt.include_kl_prompt, false, "harness_prompt: false carried over");
	assert.equal(config.prompt.include_project_context, false);
	assert.equal(config.prompt.include_appended_prompt, true);
	assert.deepEqual(config.prompt.extra_sections.map((s) => [s.name, s.path]), [["memory", "memory/MEMORY.md"]]);

	const out = readFileSync(join(home, "agent.yml"), "utf8");
	assert.doesNotMatch(out, /^#? ?(sections|project_context|harness_prompt|system_prompt):/m, out);
	assert.match(out, /^cleanup: \{ path: prompts\/cleanup\.md \}$/m, "untouched keys keep their form");

	const again = migrateHome(home, { klRoot: emptyRoot() });
	assert.equal(again.changed, false, "second run is a no-op");
});

test("migrate --dry-run changes nothing on disk", () => {
	const home = oldInitHome();
	const r = migrateHome(home, { klRoot: emptyRoot(), dryRun: true });
	assert.equal(r.changed, true);
	assert.equal(readFileSync(join(home, "agent.yml"), "utf8"), OLD_INIT_YML);
	assert.ok(existsSync(join(home, "SYSTEM.md")));
	assert.ok(!existsSync(join(home, "IDENTITY.md")));
});

test("migrate: system_prompt naming another file becomes prompt.identity; SYSTEM.md (not in use) is left alone", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-id-"));
	writeFileSync(join(home, "agent.yml"), "name: scout\nsystem_prompt: IDENTITY.md\n");
	writeFileSync(join(home, "IDENTITY.md"), "I am scout.\n");
	writeFileSync(join(home, "SYSTEM.md"), "unused\n");
	migrateHome(home, { klRoot: emptyRoot() });
	assert.ok(existsSync(join(home, "SYSTEM.md")));
	assert.ok(!existsSync(join(home, "IDENTITY.md")));
	const { config, warnings } = loadClean(home);
	assert.deepEqual(warnings, []);
	assert.equal(loadIdentity(config, () => {}), "I am scout.");
});

test("migrate: SYSTEM.md stays when config.yml sets the identity (it wasn't in use)", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-id-"));
	const klRoot = emptyRoot();
	writeFileSync(join(klRoot, "config.yml"), "system_prompt: house.md\n");
	writeFileSync(join(home, "agent.yml"), "name: scout\n");
	writeFileSync(join(home, "SYSTEM.md"), "unused\n");
	migrateHome(home, { klRoot });
	assert.ok(existsSync(join(home, "SYSTEM.md")));
	assert.ok(!existsSync(join(home, "IDENTITY.md")));
});

test("migrate: SYSTEM.md in use but IDENTITY.md already exists → both kept, prompt.identity points at SYSTEM.md", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-id-"));
	writeFileSync(join(home, "agent.yml"), "name: scout\n");
	writeFileSync(join(home, "SYSTEM.md"), "I am scout.\n");
	writeFileSync(join(home, "IDENTITY.md"), "someone else\n");
	const r = migrateHome(home, { klRoot: emptyRoot() });
	assert.ok(r.warnings.some((w) => w.includes("IDENTITY.md")));
	const { config, warnings } = loadClean(home);
	assert.deepEqual(warnings, []);
	assert.equal(loadIdentity(config, () => {}), "I am scout.", "the file that was in use is still in use");
});

test("migrate: harness_prompt naming a file is dropped with a warning", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-hp-"));
	writeFileSync(join(home, "agent.yml"), "name: scout\n# my harness\nharness_prompt: mine.md\nmodel: x/y\n");
	const r = migrateHome(home, { klRoot: emptyRoot() });
	assert.ok(r.warnings.some((w) => w.includes("harness_prompt dropped")));
	const { config, warnings } = loadClean(home);
	assert.deepEqual(warnings, []);
	assert.equal(config.prompt.include_kl_prompt, true);
	assert.equal(config.model, "x/y");
});

test("migrate: <kl root>/config.yml moves its prompt keys into prompt:", () => {
	const klRoot = emptyRoot();
	writeFileSync(
		join(klRoot, "config.yml"),
		"model: x/y\nsystem_prompt: house.md\nproject_context: false\nsections:\n  - {name: house, path: house.md}\n",
	);
	writeFileSync(join(klRoot, "house.md"), "House identity.\n");
	const r = migrateGlobalConfig(klRoot)!;
	assert.equal(r.changed, true);
	assert.ok(existsSync(join(klRoot, "config.yml.bak")));
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-g-"));
	const { config, warnings } = loadClean(home, klRoot);
	assert.deepEqual(warnings, []);
	assert.equal(config.model, "x/y");
	assert.equal(loadIdentity(config, () => {}), "House identity.");
	assert.equal(config.prompt.include_project_context, false);
	assert.deepEqual(config.prompt.extra_sections.map((s) => [s.name, s.baseDir]), [["house", klRoot]]);
	assert.equal(migrateGlobalConfig(klRoot)!.changed, false, "second run is a no-op");
});

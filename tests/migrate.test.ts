import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../extensions/kiln-lite/config.ts";
import { migrateHome, slugify } from "../src/migrate.ts";

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

test("migrate: context_injection → sections, drops dead keys, rewrites cleanup, keeps the rest; .bak; loads clean", () => {
	const home = mkdtempSync(join(tmpdir(), "kl-migrate-"));
	writeFileSync(join(home, "agent.yml"), OLD);
	mkdirSync(join(home, "harness"));
	writeFileSync(join(home, "harness", "pre-launch"), "#!/bin/sh\n");
	const r = migrateHome(home);
	assert.equal(r.changed, true);
	assert.equal(readFileSync(join(home, "agent.yml.bak"), "utf8"), OLD);
	const out = readFileSync(join(home, "agent.yml"), "utf8");
	for (const gone of ["context_injection", "startup", "tools_dir", "system_prompt", "{summary_path}", "template vars", "Files prepended", "Replaces Pi"]) {
		assert.ok(!out.includes(gone), `${gone} should be gone:\n${out}`);
	}
	assert.match(out, /# top comment\nname: rev/);
	assert.match(out, /# keep me\nmodel: x\/y/);
	assert.match(out, /memory\/sessions\/<date>-<session name>\.md/);
	assert.ok(existsSync(join(home, "hooks", "pre-launch")));
	assert.ok(r.warnings.some((w) => w.includes("dynamic dropped")));
	assert.ok(r.warnings.some((w) => w.includes("{today}")));
	assert.ok(r.warnings.some((w) => w.includes("GONE.md")));
	const warnings: string[] = [];
	const c = loadConfig({ agentHome: home, klRoot: mkdtempSync(join(tmpdir(), "kl-root-")), warn: (m) => warnings.push(m) });
	assert.deepEqual(warnings, []);
	assert.deepEqual(c.sections.map((s) => [s.name, s.path]), [["core-memory", "memory/core.md"], ["working-state", "memory/volatile.md"]]);
	assert.equal(migrateHome(home).changed, false, "second run is a no-op");
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
	const r = migrateHome(home);
	assert.ok(r.changed);
	assert.ok(r.report.includes("comments from the old template → reworded"));
	const out = readFileSync(join(home, "agent.yml"), "utf8");
	assert.doesNotMatch(out, /replaces Pi's|built-in system prompt|wrapup|template vars/);
	assert.match(out, /^# Identity prompt: opens the system prompt, before the kl baseline\.$/m);
	assert.match(out, /^# Cleanup turn on \/exit and the exit_session tool/m);
	assert.match(out, /^#   Write a session summary to memory\/sessions\/<date>-<session name>\.md/m);
	assert.match(out, /^# my own note: replaces nothing$/m);
	assert.equal(readFileSync(`${join(home, "agent.yml")}.bak`, "utf8"), old);
	// Second run: nothing left to do.
	assert.equal(migrateHome(home).changed, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import { resolveHandoff } from "../extensions/kiln-lite/exit-session.ts";

function makeTmpDir(): string {
	const dir = join(tmpdir(), `exit-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- resolveHandoff ---

test("resolveHandoff returns raw text for plain strings", () => {
	assert.equal(resolveHandoff("continue working on the feature"), "continue working on the feature");
});

test("resolveHandoff returns raw text for strings that look like paths but don't exist", () => {
	assert.equal(
		resolveHandoff("/nonexistent/path/that/does/not/exist.md"),
		"/nonexistent/path/that/does/not/exist.md",
	);
});

test("resolveHandoff reads file contents for existing absolute paths", () => {
	const dir = makeTmpDir();
	const file = join(dir, "handoff.md");
	writeFileSync(file, "# Handoff\n\nPick up where I left off.");

	const result = resolveHandoff(file);
	assert.equal(result, "# Handoff\n\nPick up where I left off.");

	rmSync(dir, { recursive: true });
});

test("resolveHandoff expands ~/ to home directory", () => {
	// Create a temp file in a known location under home
	const subdir = join(homedir(), `.kl-test-${Date.now()}`);
	mkdirSync(subdir, { recursive: true });
	const file = join(subdir, "handoff.md");
	writeFileSync(file, "home-relative content");

	const tildeRef = `~/.kl-test-${Date.now().toString().slice(-13)}`; // won't match
	// Use the actual subdir name for a reliable test
	const basename = subdir.split("/").pop()!;
	const result = resolveHandoff(`~/${basename}/handoff.md`);
	assert.equal(result, "home-relative content");

	rmSync(subdir, { recursive: true });
});

test("resolveHandoff trims whitespace before path detection", () => {
	const dir = makeTmpDir();
	const file = join(dir, "handoff.md");
	writeFileSync(file, "trimmed content");

	// Leading/trailing whitespace around a valid path
	const result = resolveHandoff(`  ${file}  `);
	assert.equal(result, "trimmed content");

	rmSync(dir, { recursive: true });
});

test("resolveHandoff preserves original text (not trimmed) for non-path strings", () => {
	// Raw text with leading whitespace should be returned as-is (original, not trimmed)
	assert.equal(resolveHandoff("  some text  "), "  some text  ");
});

test("resolveHandoff handles multiline handoff text", () => {
	const text = "Line 1\nLine 2\n\n## Section\n\nMore content.";
	assert.equal(resolveHandoff(text), text);
});

test("resolveHandoff handles file with special characters in content", () => {
	const dir = makeTmpDir();
	const file = join(dir, "special.md");
	const content = "Backticks: `code`\nQuotes: \"hello\" 'world'\nDollars: $VAR\nNewlines:\n\n\nDone.";
	writeFileSync(file, content);

	assert.equal(resolveHandoff(file), content);

	rmSync(dir, { recursive: true });
});

test("resolveHandoff returns raw text for relative-looking paths", () => {
	// ./relative paths are not supported — only absolute and ~/
	assert.equal(resolveHandoff("./some/file.md"), "./some/file.md");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../extensions/kiln-lite/config.ts";
import {
	parsePromptSource,
	resolvePromptSource,
} from "../extensions/kiln-lite/prompt-source.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-prompt-source-test-"));
}

function cleanup(home: string): void {
	rmSync(home, { recursive: true, force: true });
}

test("parsePromptSource preserves inline prompt text verbatim", () => {
	const warnings: string[] = [];
	const source = parsePromptSource("  raw prompt\n", "cleanup", (m) => warnings.push(m));
	assert.equal(source, "  raw prompt\n");
	assert.deepEqual(warnings, []);
});

test("parsePromptSource accepts and trims a path mapping", () => {
	const source = parsePromptSource({ path: "  prompts/cleanup.md  " }, "cleanup", () => {});
	assert.deepEqual(source, { path: "prompts/cleanup.md" });
});

test("parsePromptSource rejects invalid mappings with a warning", () => {
	const warnings: string[] = [];
	const source = parsePromptSource({ path: "" }, "agent.yml cleanup", (m) => warnings.push(m));
	assert.equal(source, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /inline text.*non-empty 'path'/);
});

test("resolvePromptSource reads relative files at resolution time", () => {
	const home = makeHome();
	try {
		const path = join(home, "cleanup.md");
		writeFileSync(path, "first");
		const source = { path: "cleanup.md" };
		assert.equal(resolvePromptSource(source, home, "cleanup prompt", () => {}), "first");
		writeFileSync(path, "second");
		assert.equal(resolvePromptSource(source, home, "cleanup prompt", () => {}), "second");
	} finally {
		cleanup(home);
	}
});

test("resolvePromptSource supports absolute paths", () => {
	const home = makeHome();
	try {
		const path = join(home, "absolute.md");
		writeFileSync(path, "absolute prompt");
		assert.equal(resolvePromptSource({ path }, "/unused", "cleanup prompt", () => {}), "absolute prompt");
	} finally {
		cleanup(home);
	}
});

test("resolvePromptSource returns null and warns for a missing file", () => {
	const warnings: string[] = [];
	const result = resolvePromptSource(
		{ path: "missing.md" },
		"/agent/home",
		"cleanup prompt",
		(m) => warnings.push(m),
	);
	assert.equal(result, null);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /cleanup prompt file not found.*missing\.md/);
});

test("loadConfig accepts cleanup as a file or inline text", () => {
	const fileHome = makeHome();
	const inlineHome = makeHome();
	try {
		writeFileSync(join(fileHome, "agent.yml"), "name: file-agent\ncleanup:\n  path: prompts/cleanup.md\n");
		writeFileSync(join(inlineHome, "agent.yml"), "name: inline-agent\ncleanup: raw cleanup\n");

		assert.deepEqual(loadConfig({ agentHome: fileHome, klRoot: fileHome, warn: () => {} }).cleanup, {
			path: "prompts/cleanup.md",
		});
		assert.equal(loadConfig({ agentHome: inlineHome, klRoot: inlineHome, warn: () => {} }).cleanup, "raw cleanup");
	} finally {
		cleanup(fileHome);
		cleanup(inlineHome);
	}
});

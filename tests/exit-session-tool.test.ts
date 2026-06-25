import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import { resolveHandoff } from "../extensions/kiln-lite/exit-session.ts";
import { handoffTmuxClient } from "../extensions/kiln-lite/exit-session.ts";
import {
	buildContinuationArgs,
	CONTINUATION_STARTUP_PING,
} from "../extensions/kiln-lite/exit-session.ts";

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

// --- handoffTmuxClient ---

/** Records every tmux invocation; returns a scripted stdout for list-clients. */
function fakeTmux(clientList: string) {
	const calls: string[][] = [];
	const run = (args: string[]): string => {
		calls.push(args);
		return args[0] === "list-clients" ? clientList : "";
	};
	return { run, calls };
}

test("handoffTmuxClient is a no-op when not inside tmux", () => {
	const { run, calls } = fakeTmux("/dev/ttys001");
	const moved = handoffTmuxClient("old-a-b", "new-c-d", { tmux: run, inTmux: false });
	assert.equal(moved, 0);
	assert.equal(calls.length, 0); // never even queried tmux
});

test("handoffTmuxClient is a no-op when no client is attached (autonomous run)", () => {
	const { run, calls } = fakeTmux(""); // list-clients returns nothing
	const moved = handoffTmuxClient("old-a-b", "new-c-d", { tmux: run, inTmux: true });
	assert.equal(moved, 0);
	assert.equal(calls.length, 1); // queried once, no switch-client
	assert.equal(calls[0][0], "list-clients");
});

test("handoffTmuxClient switches the attached client to the continuation", () => {
	const { run, calls } = fakeTmux("/dev/ttys019");
	const moved = handoffTmuxClient("old-a-b", "new-c-d", { tmux: run, inTmux: true });
	assert.equal(moved, 1);
	assert.deepEqual(calls[1], ["switch-client", "-c", "/dev/ttys019", "-t", "new-c-d"]);
});

test("handoffTmuxClient switches every attached client", () => {
	const { run, calls } = fakeTmux("/dev/ttys019\n/dev/ttys020");
	const moved = handoffTmuxClient("old-a-b", "new-c-d", { tmux: run, inTmux: true });
	assert.equal(moved, 2);
	assert.deepEqual(calls[1], ["switch-client", "-c", "/dev/ttys019", "-t", "new-c-d"]);
	assert.deepEqual(calls[2], ["switch-client", "-c", "/dev/ttys020", "-t", "new-c-d"]);
});

test("handoffTmuxClient is a no-op when the prior session id is unknown", () => {
	const { run, calls } = fakeTmux("/dev/ttys019");
	const moved = handoffTmuxClient(undefined, "new-c-d", { tmux: run, inTmux: true });
	assert.equal(moved, 0);
	assert.equal(calls.length, 0);
});

test("handoffTmuxClient swallows tmux failures and warns (never breaks exit)", () => {
	const warnings: string[] = [];
	const run = (): string => {
		throw new Error("no server running");
	};
	const moved = handoffTmuxClient("old-a-b", "new-c-d", {
		tmux: run,
		inTmux: true,
		warn: (m) => warnings.push(m),
	});
	assert.equal(moved, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /handoff failed/);
});

// --- buildContinuationArgs ---

test("buildContinuationArgs passes the handoff via --append-system-prompt, not a turn-1 prompt", () => {
	const args = buildContinuationArgs({ handoff: "orienting context here" });
	assert.deepEqual(args, ["--detach", "--append-system-prompt", "orienting context here"]);
	// Never --prompt-file (the old turn-1 mechanism) and no trailing positional.
	assert.ok(!args.includes("--prompt-file"));
});

test("buildContinuationArgs omits the handoff flag when handoff is empty", () => {
	assert.deepEqual(buildContinuationArgs({ handoff: "" }), ["--detach"]);
});

test("buildContinuationArgs default (autonomous unset) sends no startup ping", () => {
	const args = buildContinuationArgs({ handoff: "ctx" });
	assert.ok(!args.includes(CONTINUATION_STARTUP_PING));
	assert.equal(args.at(-1), "ctx"); // ends at the handoff value, no extra positional
});

test("buildContinuationArgs autonomous:false sends no startup ping", () => {
	const args = buildContinuationArgs({ handoff: "ctx", autonomous: false });
	assert.ok(!args.includes(CONTINUATION_STARTUP_PING));
});

test("buildContinuationArgs autonomous:true appends the startup ping as the final positional", () => {
	const args = buildContinuationArgs({ handoff: "ctx", autonomous: true });
	assert.deepEqual(args, [
		"--detach",
		"--append-system-prompt",
		"ctx",
		CONTINUATION_STARTUP_PING,
	]);
	// The ping is the trailing arg → pi treats it as the turn-1 message.
	assert.equal(args.at(-1), CONTINUATION_STARTUP_PING);
});

test("buildContinuationArgs threads --template through before the handoff", () => {
	const args = buildContinuationArgs({ handoff: "ctx", template: "worker", autonomous: true });
	assert.deepEqual(args, [
		"--detach",
		"--template",
		"worker",
		"--append-system-prompt",
		"ctx",
		CONTINUATION_STARTUP_PING,
	]);
});

test("buildContinuationArgs autonomous-only (no handoff) still sends the ping", () => {
	assert.deepEqual(buildContinuationArgs({ handoff: "", autonomous: true }), [
		"--detach",
		CONTINUATION_STARTUP_PING,
	]);
});

test("CONTINUATION_STARTUP_PING is a neutral kick-off, not a fresh directive", () => {
	// Guards the design intent: the ping points at the system prompt and tells
	// the continuation to resume, rather than handing it a new task.
	assert.match(CONTINUATION_STARTUP_PING, /system prompt/);
	assert.match(CONTINUATION_STARTUP_PING, /continue the work/);
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	loadCommandGates,
	applyCommandGates,
	DEFAULT_CONFIRM_TIMEOUT_MS,
	type CompiledGate,
	type GateNotifyInfo,
} from "../extensions/kiln-lite/gates.ts";

// --- helpers ---------------------------------------------------------------

let dir: string;
const noWarn = () => {};

function writeGuardrails(body: string): string {
	writeFileSync(join(dir, "guardrails.yml"), body, "utf8");
	return dir;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kl-gates-"));
	delete process.env.KL_GATE_TIMEOUT_MS;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.KL_GATE_TIMEOUT_MS;
});

// --- loader: timeout precedence -------------------------------------------

describe("loadCommandGates — timeout precedence", () => {
	it("falls back to the built-in default when nothing is configured", () => {
		const root = writeGuardrails(`command_gates:\n  - match: 'x'\n    action: confirm\n`);
		const gates = loadCommandGates(root, noWarn);
		assert.equal(gates[0].timeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
	});

	it("uses the global confirm_timeout_ms when set", () => {
		const root = writeGuardrails(
			`confirm_timeout_ms: 5000\ncommand_gates:\n  - match: 'x'\n    action: confirm\n`,
		);
		assert.equal(loadCommandGates(root, noWarn)[0].timeoutMs, 5000);
	});

	it("per-gate timeout overrides the global default", () => {
		const root = writeGuardrails(
			`confirm_timeout_ms: 5000\ncommand_gates:\n  - match: 'x'\n    action: confirm\n    timeout: 999\n`,
		);
		assert.equal(loadCommandGates(root, noWarn)[0].timeoutMs, 999);
	});

	it("KL_GATE_TIMEOUT_MS env overrides both per-gate and global", () => {
		process.env.KL_GATE_TIMEOUT_MS = "777";
		const root = writeGuardrails(
			`confirm_timeout_ms: 5000\ncommand_gates:\n  - match: 'x'\n    action: confirm\n    timeout: 999\n`,
		);
		assert.equal(loadCommandGates(root, noWarn)[0].timeoutMs, 777);
	});

	it("treats timeout: 0 as a valid 'wait forever' value", () => {
		const root = writeGuardrails(`command_gates:\n  - match: 'x'\n    action: confirm\n    timeout: 0\n`);
		assert.equal(loadCommandGates(root, noWarn)[0].timeoutMs, 0);
	});

	it("ignores a negative/garbage per-gate timeout and falls back", () => {
		const root = writeGuardrails(
			`confirm_timeout_ms: 5000\ncommand_gates:\n  - match: 'x'\n    action: confirm\n    timeout: -1\n`,
		);
		assert.equal(loadCommandGates(root, noWarn)[0].timeoutMs, 5000);
	});
});

// --- handler ---------------------------------------------------------------

function gate(overrides: Partial<CompiledGate> = {}): CompiledGate {
	return {
		regex: /git\s+push/i,
		action: "confirm",
		on: "bash",
		field: "command",
		message: "git push requires approval",
		timeoutMs: 1000,
		...overrides,
	};
}

const interactive = (confirm: () => Promise<boolean>) => ({ hasUI: true, ui: { confirm } });
const headless = { hasUI: false, ui: { confirm: async () => true } };

describe("applyCommandGates — handler", () => {
	it("hard-blocks a 'block' gate without confirming or notifying", async () => {
		let notified = false;
		const res = await applyCommandGates(
			[gate({ action: "block" })],
			"bash",
			{ command: "git push origin main" },
			interactive(async () => true),
			{ notify: () => { notified = true; } },
		);
		assert.deepEqual(res, { block: true, reason: "git push requires approval" });
		assert.equal(notified, false);
	});

	it("lets the call through when the user approves", async () => {
		const res = await applyCommandGates(
			[gate()],
			"bash",
			{ command: "git push" },
			interactive(async () => true),
			{ notify: () => {} },
		);
		assert.equal(res, undefined);
	});

	it("blocks with a generic reason when confirm resolves false (denied or timed out)", async () => {
		const res = await applyCommandGates(
			[gate()],
			"bash",
			{ command: "git push" },
			interactive(async () => false),
			{ notify: () => {} },
		);
		assert.deepEqual(res, { block: true, reason: "Approval not granted (denied or timed out)" });
	});

	it("passes the resolved timeout to confirm", async () => {
		let seen: { timeout?: number } | undefined;
		await applyCommandGates(
			[gate({ timeoutMs: 4242 })],
			"bash",
			{ command: "git push" },
			{ hasUI: true, ui: { confirm: async (_t, _m, opts) => { seen = opts; return true; } } },
			{ notify: () => {} },
		);
		assert.equal(seen?.timeout, 4242);
	});

	it("omits the timeout option when timeoutMs <= 0 (wait forever)", async () => {
		let seen: { timeout?: number } | undefined = { timeout: -1 };
		await applyCommandGates(
			[gate({ timeoutMs: 0 })],
			"bash",
			{ command: "git push" },
			{ hasUI: true, ui: { confirm: async (_t, _m, opts) => { seen = opts; return true; } } },
			{ notify: () => {} },
		);
		assert.equal(seen, undefined);
	});

	it("hard-blocks confirm gates in non-interactive sessions, still notifying", async () => {
		let info: GateNotifyInfo | undefined;
		const res = await applyCommandGates(
			[gate()],
			"bash",
			{ command: "git push" },
			headless,
			{ notify: (i) => { info = i; } },
		);
		assert.equal(res?.block, true);
		assert.match(res!.reason, /non-interactive/);
		assert.equal(info?.command, "git push");
		assert.equal(info?.gateMessage, "git push requires approval");
	});

	it("notifies with the agent id before prompting in interactive sessions", async () => {
		let info: GateNotifyInfo | undefined;
		await applyCommandGates(
			[gate()],
			"bash",
			{ command: "git push" },
			interactive(async () => true),
			{ agentId: "cal-test-1", notify: (i) => { info = i; } },
		);
		assert.equal(info?.agentId, "cal-test-1");
	});

	it("ignores gates whose tool name does not match", async () => {
		const res = await applyCommandGates(
			[gate({ on: "write" })],
			"bash",
			{ command: "git push" },
			interactive(async () => false),
			{ notify: () => {} },
		);
		assert.equal(res, undefined);
	});
});

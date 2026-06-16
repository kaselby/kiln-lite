/**
 * Command gates — configurable tool-call interception.
 *
 * Reads ~/.kl/guardrails.yml (the kiln-lite root) and provides
 * a tool_call handler that blocks or prompts for confirmation on matching
 * commands.
 *
 * guardrails.yml schema:
 *
 *   confirm_timeout_ms: 300000          # global default for confirm prompts
 *   command_gates:
 *     - match: '\bgit\s+push\b'        # regex pattern (case-insensitive)
 *       action: block                   # block | confirm
 *     - match: '\bsudo\b'
 *       action: confirm
 *       on: bash                        # tool name (default: bash)
 *       field: command                  # input field to check (default: per-tool)
 *       message: "sudo requires approval"  # optional custom message
 *       timeout: 60000                   # per-gate confirm timeout (ms)
 *
 * Confirm-gate timeout precedence (highest first):
 *   KL_GATE_TIMEOUT_MS env  >  per-gate `timeout`  >  `confirm_timeout_ms`
 *   >  built-in 300000ms. A resolved value <= 0 means "wait forever" (no
 *   auto-reject) — an explicit escape hatch for gates that must be answered.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import yaml from "js-yaml";

/** Built-in confirm timeout when nothing else is configured (5 minutes). */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Compiled gate with pre-built regex. */
export interface CompiledGate {
	regex: RegExp;
	action: "block" | "confirm";
	on: string;
	field: string;
	message: string;
	/** Effective confirm timeout (ms). <= 0 means wait forever. */
	timeoutMs: number;
}

/** Minimal context subset — satisfied by pi's ExtensionContext. */
interface GateContext {
	hasUI: boolean;
	ui: {
		confirm(
			title: string,
			message: string,
			opts?: { timeout?: number },
		): Promise<boolean>;
	};
}

/** Details surfaced to the OS notifier when a confirm gate fires. */
export interface GateNotifyInfo {
	agentId: string;
	gateMessage: string;
	command: string;
}

/** Side-effecting notifier — injectable so tests don't fire real alerts. */
export type GateNotifier = (info: GateNotifyInfo) => void;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default input field to inspect per tool name. */
const DEFAULT_FIELDS: Record<string, string> = {
	bash: "command",
	write: "path",
	edit: "path",
	read: "path",
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and compile command gates from guardrails.yml.
 *
 * @param klRoot  Path to the kiln-lite root (~/.kl/). See resolveKlRoot().
 * @param warn    Called with a human-readable message for any non-fatal issue.
 */
export function loadCommandGates(
	klRoot: string,
	warn: (msg: string) => void,
): CompiledGate[] {
	const filePath = join(klRoot, "guardrails.yml");
	if (!existsSync(filePath)) return [];

	let raw: unknown;
	try {
		raw = yaml.load(readFileSync(filePath, "utf8"));
	} catch (err) {
		warn(`kiln-lite: failed to parse guardrails.yml: ${(err as Error).message}`);
		return [];
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warn("kiln-lite: guardrails.yml must be a YAML mapping");
		return [];
	}

	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.command_gates)) return [];

	// Resolve the confirm-timeout default chain (env > global > built-in).
	// A per-gate `timeout` slots between env and global.
	const envTimeout = parseTimeout(process.env.KL_GATE_TIMEOUT_MS);
	const globalTimeout = parseTimeout(obj.confirm_timeout_ms);
	if (obj.confirm_timeout_ms !== undefined && globalTimeout === undefined) {
		warn("kiln-lite: guardrails.yml confirm_timeout_ms must be a non-negative number — ignoring");
	}

	const compiled: CompiledGate[] = [];
	for (const [i, entry] of (obj.command_gates as unknown[]).entries()) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			warn(`kiln-lite: guardrails.yml command_gates[${i}] is not a mapping — skipping`);
			continue;
		}
		const e = entry as Record<string, unknown>;

		if (typeof e.match !== "string" || !e.match.trim()) {
			warn(`kiln-lite: guardrails.yml command_gates[${i}] missing 'match' — skipping`);
			continue;
		}
		if (e.action !== "block" && e.action !== "confirm") {
			warn(`kiln-lite: guardrails.yml command_gates[${i}] action must be 'block' or 'confirm' — skipping`);
			continue;
		}

		let regex: RegExp;
		try {
			regex = new RegExp(e.match, "i");
		} catch (err) {
			warn(
				`kiln-lite: guardrails.yml command_gates[${i}] invalid regex '${e.match}': ${(err as Error).message} — skipping`,
			);
			continue;
		}

		const on = typeof e.on === "string" ? e.on : "bash";
		const field = typeof e.field === "string" ? e.field : (DEFAULT_FIELDS[on] ?? "command");
		const message =
			typeof e.message === "string" ? e.message : `Matches command gate: ${e.match}`;

		const perGateTimeout = parseTimeout(e.timeout);
		if (e.timeout !== undefined && perGateTimeout === undefined) {
			warn(`kiln-lite: guardrails.yml command_gates[${i}] timeout must be a non-negative number — ignoring`);
		}
		// Precedence: env override > per-gate > global default > built-in.
		const timeoutMs =
			envTimeout ?? perGateTimeout ?? globalTimeout ?? DEFAULT_CONFIRM_TIMEOUT_MS;

		compiled.push({ regex, action: e.action, on, field, message, timeoutMs });
	}

	return compiled;
}

/**
 * Parse a timeout value (ms) from config or env. Accepts a number or a
 * numeric string; returns undefined for anything invalid or negative.
 * Zero is valid and means "wait forever" downstream.
 */
function parseTimeout(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Default OS notifier — fires a macOS Notification Center alert via
 * `osascript`. No-op on non-darwin platforms. Fire-and-forget: failures are
 * swallowed (a missing notification must never block or crash a tool call).
 *
 * Reuses the same mechanism as the `notify` tool but is self-contained so the
 * gate path carries no dependency on any per-agent tool.
 */
export function defaultGateNotifier(info: GateNotifyInfo): void {
	if (process.platform !== "darwin") return;

	const title = `⚠️ ${info.agentId}: approval needed`;
	const body = `${info.gateMessage}\n${info.command}`.slice(0, 240);
	// AppleScript string literals: escape backslashes then double-quotes.
	const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`;

	try {
		execFile("osascript", ["-e", script], () => {
			/* fire-and-forget; ignore errors */
		});
	} catch {
		/* osascript missing or spawn failed — ignore */
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Check a tool call against compiled gates.
 *
 * Returns `{ block: true, reason }` if a gate fires (either hard-block or
 * user-denied/timed-out confirmation), or `undefined` to let the call through.
 *
 * Confirm gates fire an OS notification (both interactive and headless) so an
 * unattended session surfaces the pending approval. In interactive sessions
 * the confirm dialog carries a timeout (live countdown) and auto-rejects when
 * it lapses; in non-interactive sessions (`ctx.hasUI === false`) there is no
 * dialog, so the call is hard-blocked immediately after notifying.
 */
export async function applyCommandGates(
	gates: CompiledGate[],
	toolName: string,
	input: Record<string, unknown>,
	ctx: GateContext,
	opts?: { agentId?: string; notify?: GateNotifier },
): Promise<{ block: true; reason: string } | undefined> {
	const notify = opts?.notify ?? defaultGateNotifier;
	const agentId = opts?.agentId ?? "agent";

	for (const gate of gates) {
		if (gate.on !== toolName) continue;

		const value = input[gate.field];
		if (typeof value !== "string") continue;
		if (!gate.regex.test(value)) continue;

		if (gate.action === "block") {
			return { block: true, reason: gate.message };
		}

		// action === "confirm" — notify first so an unattended session pings.
		notify({ agentId, gateMessage: gate.message, command: value });

		if (!ctx.hasUI) {
			return { block: true, reason: `${gate.message} (non-interactive — auto-blocked)` };
		}

		// timeoutMs <= 0 means wait forever (omit the option entirely).
		const confirmOpts = gate.timeoutMs > 0 ? { timeout: gate.timeoutMs } : undefined;
		const approved = await ctx.ui.confirm(
			"⚠️ Command gate triggered",
			`${gate.message}\n\n  ${value}`,
			confirmOpts,
		);
		if (!approved) {
			// Native timeout and an explicit "No" both resolve false; we don't
			// distinguish them in the reason (keeps the countdown UI).
			return { block: true, reason: "Approval not granted (denied or timed out)" };
		}

		// Approved — stop checking further gates for this call.
		return undefined;
	}

	return undefined;
}

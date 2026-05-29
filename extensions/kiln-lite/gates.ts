/**
 * Command gates — configurable tool-call interception.
 *
 * Reads ~/.kl/guardrails.yml (one level above $AGENT_HOME) and provides
 * a tool_call handler that blocks or prompts for confirmation on matching
 * commands.
 *
 * guardrails.yml schema:
 *
 *   command_gates:
 *     - match: '\bgit\s+push\b'        # regex pattern (case-insensitive)
 *       action: block                   # block | confirm
 *     - match: '\bsudo\b'
 *       action: confirm
 *       on: bash                        # tool name (default: bash)
 *       field: command                  # input field to check (default: per-tool)
 *       message: "sudo requires approval"  # optional custom message
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

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
}

/** Minimal context subset — satisfied by pi's ExtensionContext. */
interface GateContext {
	hasUI: boolean;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
	};
}

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
 * @param klRoot  Path to the kiln-lite root (~/.kl/), one level above agent home.
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

		compiled.push({ regex, action: e.action, on, field, message });
	}

	return compiled;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Check a tool call against compiled gates.
 *
 * Returns `{ block: true, reason }` if a gate fires (either hard-block or
 * user-denied confirmation), or `undefined` to let the call through.
 *
 * For `confirm` gates in non-interactive sessions (`ctx.hasUI === false`),
 * the call is hard-blocked — no silent pass-through.
 */
export async function applyCommandGates(
	gates: CompiledGate[],
	toolName: string,
	input: Record<string, unknown>,
	ctx: GateContext,
): Promise<{ block: true; reason: string } | undefined> {
	for (const gate of gates) {
		if (gate.on !== toolName) continue;

		const value = input[gate.field];
		if (typeof value !== "string") continue;
		if (!gate.regex.test(value)) continue;

		if (gate.action === "block") {
			return { block: true, reason: gate.message };
		}

		// action === "confirm"
		if (!ctx.hasUI) {
			return { block: true, reason: `${gate.message} (non-interactive — auto-blocked)` };
		}

		const approved = await ctx.ui.confirm(
			"⚠️ Command gate triggered",
			`${gate.message}\n\n  ${value}`,
		);
		if (!approved) {
			return { block: true, reason: "Blocked by user" };
		}

		// Approved — stop checking further gates for this call.
		return undefined;
	}

	return undefined;
}

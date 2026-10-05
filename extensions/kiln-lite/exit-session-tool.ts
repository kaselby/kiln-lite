/**
 * Builtin `exit_session` tool: exit, or reset and continue in place.
 *
 *   - **skip_cleanup** (default false): skip the cleanup turn. Agents with no
 *     `cleanup:` prompt have no cleanup turn anyway.
 *   - **continue** (default false): instead of exiting, reset the context
 *    . After the cleanup turn (if any), kl appends a compaction entry
 *     whose summary is the handoff and which keeps no earlier entries. Same
 *     session id, transcript, inbox and children; the model sees only the
 *     system prompt, the handoff summary, and what comes after.
 *   - **handoff**: the summary the reset leaves behind. Raw text, or a path
 *     (absolute or ~/...) whose contents are read. Used only with continue.
 *   - **autonomous** (default false): after the reset, start a new turn on the
 *     handoff right away. When false the session goes idle after the reset
 *     and waits for the next message. Used only with continue.
 *
 * The tool-call equivalent of `/exit`, plus the reset.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
// Type-only: defineTool is an identity function, and a value import would make
// this module unloadable in the CJS test runner (pi-coding-agent is ESM-only).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CleanupDispatcher } from "./cleanup.ts";

export interface ResetRequest {
	/** Handoff text; becomes the compaction summary. */
	handoff: string;
	/** Start a new turn after the reset (BoundaryResult.continue). */
	autonomous: boolean;
}

const ExitSessionParams = Type.Object({
	skip_cleanup: Type.Optional(
		Type.Boolean({
			description: "Skip the cleanup turn (if the agent has one) and exit or reset immediately. Default false.",
		}),
	),
	continue: Type.Optional(
		Type.Boolean({
			description:
				"Don't exit: reset the context and keep going in this same session. Everything before the " +
				"reset leaves your context; only the handoff remains. Default false.",
		}),
	),
	handoff: Type.Optional(
		Type.String({
			description:
				"What your post-reset self needs to know: what you were doing, where you left off, what's next. " +
				"Raw text, or a file path (absolute, or ~/…) whose contents are read. Only used when continue is true.",
		}),
	),
	autonomous: Type.Optional(
		Type.Boolean({
			description:
				"When true, start working on the handoff right after the reset. When false (default), go idle " +
				"after the reset and wait for the next message. Only used when continue is true.",
		}),
	),
});

const EXIT_SESSION_DESCRIPTION =
	"Exit the current session, or reset your context and continue. By default runs the agent's cleanup " +
	"turn (if it has one) first. Set skip_cleanup to skip it. Set continue (with a handoff) to reset " +
	"instead of exiting: same session, fresh context holding only the handoff. " +
	"Only use when working autonomously and done or out of context room, or when the user explicitly asks. " +
	"Do NOT call this during normal interactive conversation.";

const EXIT_SESSION_PROMPT_SNIPPET =
	"- **exit_session** — Exit the session, or with continue + handoff reset your context in place. " +
	"Only use when working autonomously, or when the user explicitly requests it.";

export interface ExitSessionToolDeps {
	getDispatcher: () => CleanupDispatcher | null;
	/** Arm a reset; the exit path (cleanup turn or not) then resets instead of shutting down. */
	requestReset: (req: ResetRequest) => void;
}

export function buildExitSessionTool(deps: ExitSessionToolDeps): ToolDefinition<typeof ExitSessionParams> {
	return {
		name: "exit_session",
		label: "Exit Session",
		description: EXIT_SESSION_DESCRIPTION,
		promptSnippet: EXIT_SESSION_PROMPT_SNIPPET,
		parameters: ExitSessionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const dispatcher = deps.getDispatcher();
			if (!dispatcher) {
				throw new Error("Cleanup dispatcher not initialized — session not fully started.");
			}
			if (dispatcher.inProgress()) {
				throw new Error("Exit already in progress.");
			}

			const willContinue = params.continue ?? false;
			if (willContinue) {
				deps.requestReset({
					handoff: params.handoff ? resolveHandoff(params.handoff) : "",
					autonomous: params.autonomous ?? false,
				});
			}

			if (params.skip_cleanup) {
				console.log(`kiln-lite: exit_session (skip_cleanup, continue=${willContinue})`);
				dispatcher.skip(ctx);
				return {
					content: [
						{
							type: "text",
							text: willContinue
								? "Context reset armed (cleanup skipped). End your response now; the reset happens when this turn settles."
								: "Session exiting immediately (cleanup skipped). STOP — do not take any further action.",
						},
					],
					details: {},
				};
			}

			console.log(`kiln-lite: exit_session (cleanup, continue=${willContinue})`);
			dispatcher.dispatch(ctx);
			const what = willContinue ? "Context reset" : "Session exit";
			return {
				content: [
					{
						type: "text",
						text:
							`${what} initiated. STOP — do not take any further action in this turn. End your response now. ` +
							"If this agent has a cleanup prompt it will arrive as the next message.",
					},
				],
				details: {},
			};
		},
	};
}

/**
 * Resolve a handoff value to text. If it looks like a file path (absolute or
 * ~/...) and the file exists, read its contents. Otherwise return as-is.
 */
export function resolveHandoff(raw: string): string {
	let path = raw.trim();
	if (path.startsWith("~/")) {
		path = join(homedir(), path.slice(2));
	}
	if (path.startsWith("/") && existsSync(path)) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Read failed — fall through to raw text
		}
	}
	return raw;
}

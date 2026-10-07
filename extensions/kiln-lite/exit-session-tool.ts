/**
 * Builtin `exit_session` tool: the agent's way to exit. Runs the cleanup turn
 * first (if the agent has a `cleanup:` prompt) unless `skip_cleanup` is set.
 */

import { Type } from "@sinclair/typebox";
// Type-only: defineTool is an identity function, and a value import would make
// this module unloadable in the CJS test runner (pi-coding-agent is ESM-only).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CleanupDispatcher } from "./cleanup.ts";

const ExitSessionParams = Type.Object({
	skip_cleanup: Type.Optional(
		Type.Boolean({
			description: "Skip the cleanup turn (if the agent has one) and exit immediately. Default false.",
		}),
	),
});

const EXIT_SESSION_DESCRIPTION =
	"Exit the current session. By default runs the agent's cleanup turn (if it has one) first; set " +
	"skip_cleanup to skip it. Only use when working autonomously and done, or when the user explicitly asks. " +
	"Do NOT call this during normal interactive conversation.";

const EXIT_SESSION_PROMPT_SNIPPET =
	"Exit the session. Only use when working autonomously, or when the user explicitly requests it.";

export interface ExitSessionToolDeps {
	getDispatcher: () => CleanupDispatcher | null;
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

			const runsCleanup = !params.skip_cleanup && dispatcher.hasPrompt();
			const note = `kiln-lite: exit_session (${runsCleanup ? "cleanup turn" : "no cleanup turn"})`;
			// console output garbles the TUI; notify when there is one.
			if (ctx.hasUI) ctx.ui.notify(note, "info");
			else console.log(note);

			if (runsCleanup) dispatcher.dispatch(ctx);
			else dispatcher.exitNow(ctx);
			return { content: [{ type: "text", text: exitSessionResultText(runsCleanup) }], details: {} };
		},
	};
}

/** What the model is told after exit_session. */
function exitSessionResultText(runsCleanup: boolean): string {
	return runsCleanup
		? "Session exit initiated. Your cleanup prompt arrives as the next message: do what it asks, " +
				"then end your response. Take no other action in this turn."
		: "Session exiting now (no cleanup turn). STOP: do not take any further action.";
}

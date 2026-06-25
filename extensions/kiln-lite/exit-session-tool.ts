/**
 * Builtin `exit_session` tool — unified session exit with optional cleanup
 * and self-continuation.
 *
 * Replaces the old `wrapup` tool with a richer interface:
 *
 *   - **skip_cleanup** (default false): when true, skip the cleanup flow
 *     (session summary, memory updates) and exit immediately.
 *   - **continue** (default false): spawn a new session after this one shuts
 *     down. The continuation inherits the agent home and template.
 *   - **handoff**: context for the continuation — raw text, or a file path
 *     whose contents are read. Injected into the continuation's system prompt
 *     as orienting context (not a turn-1 user message). Ignored unless
 *     continue is true.
 *   - **autonomous** (default false): when true, the continuation is started
 *     unattended with a fixed turn-1 ping so its loop kicks off on its own.
 *     When false, it spawns idle with the handoff as context and waits for the
 *     human handed the terminal. Ignored unless continue is true.
 *
 * The tool-call equivalent of the `/exit` slash command, plus continuation
 * support that slash commands don't expose.
 *
 * **Usage policy:** Only call when the agent is working autonomously (detached
 * session, no user present) and has finished its work, or when the user
 * explicitly asks the agent to exit. Do NOT call mid-conversation during
 * normal interactive use.
 */

import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CleanupDispatcher } from "./cleanup.ts";
import { resolveHandoff, type ContinuationConfig } from "./exit-session.ts";

export type { ContinuationConfig } from "./exit-session.ts";

const ExitSessionParams = Type.Object({
	skip_cleanup: Type.Optional(
		Type.Boolean({
			description: "Skip the cleanup flow (session summary, memory updates) and exit immediately. Default false.",
		}),
	),
	continue: Type.Optional(
		Type.Boolean({
			description:
				"Spawn a continuation session after this one exits. " +
				"The new session inherits the agent home and template. Default false.",
		}),
	),
	handoff: Type.Optional(
		Type.String({
			description:
				"Context to pass to the continuation session, injected into its system prompt as " +
				"orienting context (not a turn-1 user message). " +
				"Can be raw text or a file path (absolute, or ~/…) whose contents will be read. " +
				"Only used when continue is true.",
		}),
	),
	autonomous: Type.Optional(
		Type.Boolean({
			description:
				"When true, start the continuation unattended: a fixed turn-1 ping is sent so its " +
				"agent loop begins on its own. When false (default), the continuation spawns idle " +
				"with the handoff as context and waits for the human handed the terminal. " +
				"Only used when continue is true.",
		}),
	),
});

const EXIT_SESSION_DESCRIPTION =
	"Exit the current session. By default runs the cleanup flow (session summary, memory updates) " +
	"before exiting. Set skip_cleanup to skip cleanup and exit immediately. " +
	"Set continue to spawn a continuation session that inherits the agent home and template, " +
	"with an optional handoff message as its initial prompt. " +
	"Only use when working autonomously and done, or when the user explicitly requests it. " +
	"Do NOT call this during normal interactive conversation.";

const EXIT_SESSION_PROMPT_SNIPPET =
	"- **exit_session** — Exit the session. Options: skip_cleanup (skip summary/memory), " +
	"continue (spawn a continuation with handoff text or file). " +
	"Only use when working autonomously and done, or when the user explicitly requests it.";

export interface ExitSessionToolDeps {
	getDispatcher: () => CleanupDispatcher | null;
	setContinuation: (config: ContinuationConfig) => void;
	getTemplate: () => string | undefined;
}

export function buildExitSessionTool(deps: ExitSessionToolDeps) {
	return defineTool({
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

			// Store continuation config for session_shutdown to pick up.
			if (params.continue) {
				const handoffText = params.handoff ? resolveHandoff(params.handoff) : "";
				deps.setContinuation({
					handoff: handoffText,
					template: deps.getTemplate(),
					autonomous: params.autonomous ?? false,
				});
			}

			const willContinue = params.continue ?? false;
			const suffix = willContinue ? " A continuation session will be spawned." : "";

			if (params.skip_cleanup) {
				console.log(`kiln-lite: exit_session (skip_cleanup, continue=${willContinue})`);
				dispatcher.forceExit(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Session exiting immediately (cleanup skipped).${suffix} STOP — do not take any further action.`,
						},
					],
					details: {},
				};
			}

			console.log(`kiln-lite: exit_session (cleanup, continue=${willContinue})`);
			dispatcher.dispatch(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Cleanup initiated.${suffix} STOP — do not take any further action in this turn. ` +
							"End your response now. The cleanup prompt will arrive as the next message.",
					},
				],
				details: {},
			};
		},
	});
}

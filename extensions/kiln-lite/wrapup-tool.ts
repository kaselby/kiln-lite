/**
 * Builtin `wrapup` tool — lets the agent autonomously trigger the cleanup
 * flow (session summary, memory updates) and exit.
 *
 * This is the tool-call equivalent of the `/wrapup` slash command. The agent
 * calls it; the tool dispatches the cleanup prompt as a followUp message;
 * the agent processes the cleanup turn; the sentinel in agent_end triggers
 * ctx.shutdown().
 *
 * **Usage policy:** This tool should only be called when the agent is working
 * autonomously (detached session, no user present) and has finished its work,
 * or when the user explicitly asks the agent to wrap up and exit.  It must
 * NOT be called mid-conversation during normal interactive use.
 */

import { Type } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CleanupDispatcher } from "./cleanup.ts";

const WrapupParams = Type.Object({
	reason: Type.Optional(
		Type.String({
			description:
				"Brief note on why the session is ending (e.g. 'finished task', 'hit blocker'). Logged but not required.",
		}),
	),
});

const WRAPUP_DESCRIPTION =
	"Trigger the session cleanup flow (write session summary, update memory files) then exit. " +
	"Only use this tool when working autonomously in a detached session and your work is complete, " +
	"or when the user explicitly asks you to wrap up and exit. " +
	"Do NOT call this during normal interactive conversation.";

const WRAPUP_PROMPT_SNIPPET =
	"- **wrapup** — Trigger cleanup (summary + memory) then exit. " +
	"Only use when working autonomously and done, or when the user explicitly requests it.";

export interface WrapupToolDeps {
	getDispatcher: () => CleanupDispatcher | null;
}

export function buildWrapupTool(deps: WrapupToolDeps) {
	return defineTool({
		name: "wrapup",
		label: "Wrapup",
		description: WRAPUP_DESCRIPTION,
		promptSnippet: WRAPUP_PROMPT_SNIPPET,
		parameters: WrapupParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
			const dispatcher = deps.getDispatcher();
			if (!dispatcher) {
				throw new Error("Cleanup dispatcher not initialized — session not fully started.");
			}

			if (dispatcher.inProgress()) {
				throw new Error("Cleanup already in progress.");
			}

			const reason = params.reason ?? "agent-initiated";
			console.log(`kiln-lite: wrapup tool called (reason: ${reason})`);

			dispatcher.dispatch(ctx);

			return {
				content: [
					{
						type: "text",
						text:
							"Cleanup initiated. STOP — do not take any further action in this turn. " +
							"End your response now. The cleanup prompt will arrive as the next message.",
					},
				],
				details: { reason },
			};
		},
	});
}

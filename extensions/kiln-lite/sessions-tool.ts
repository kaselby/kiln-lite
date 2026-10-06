/**
 * Builtin `sessions` tool: who else is running and what each is doing, or
 * one session in full. The same functions and text as `kl sessions`
 * (src/sessions/view.ts); nothing shells out.
 */

import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import { ResolveError } from "../../src/sessions/resolve.ts";
import { formatSessionDetail, formatSessionList, listSessions, sessionDetail } from "../../src/sessions/view.ts";

const SessionsParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: "A session name (or name@<id-prefix>, or an agent name) to show in full: state, parent and children, cwd, transcript, inbox, plan and status. Omit to list sessions." }),
	),
	all: Type.Optional(Type.Boolean({ description: "List every session, including old ones and ones that never started a conversation." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "How many session trees to list (newest first). Default 20." })),
});

const DESCRIPTION =
	"See other kl sessions. With no `name`: recent sessions as parent/child trees, " +
	"* = running, with each one's state (busy/idle) and a one-line DOING (its plan goal and progress). " +
	"With `name`: that session in full (state, parent, children, cwd, transcript path, inbox counts, " +
	"its plan with every task, and any status note).";

export function buildSessionsTool(deps: { getSelf: () => string | null }) {
	return defineTool({
		name: "sessions",
		label: "Sessions",
		description: DESCRIPTION,
		promptSnippet: "- **sessions** — list kl sessions (who is running, what each is doing), or show one in full.",
		parameters: SessionsParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (params.name) {
				try {
					const d = sessionDetail(params.name);
					return text(`${d.note ? `${d.note}\n` : ""}${formatSessionDetail(d)}`);
				} catch (e) {
					if (e instanceof ResolveError) throw new Error(e.message);
					throw e;
				}
			}
			const list = listSessions({
				limit: params.all ? Infinity : (params.limit ?? 20),
				all: params.all ?? false,
				self: deps.getSelf() ?? undefined,
			});
			return text(formatSessionList(list));
		},
	});
}

function text(t: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: t }], details: undefined };
}

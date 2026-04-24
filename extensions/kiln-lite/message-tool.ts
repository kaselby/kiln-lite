/**
 * Builtin `message` tool — single-entrypoint messaging surface for the agent.
 *
 * Mirrors Kiln's Message tool shape (kiln/src/kiln/tools.py:1270-1310):
 *   - One tool with an `action` discriminator.
 *   - Actions: send | subscribe | unsubscribe.
 *   - `send` is unified: `to=<session>` for DM, `channel=<name>` for broadcast.
 *
 * Execution is a thin dispatch onto the DaemonClient the extension already
 * holds. No new wire protocol, no new daemon state. Shell-side scripting
 * still lives in `kl-msg` (src/client/cli.ts); the builtin is the
 * agent-facing surface.
 *
 * Quoting hazards are gone — `body` is just a structured string param,
 * newlines/quotes/backticks all pass through untouched.
 */

import { Type, type Static } from "@sinclair/typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { DaemonClient } from "../../src/client/index.ts";

// --- Parameter schema ---------------------------------------------------------
//
// Flat schema with optional fields. Per-action validation happens at the top of
// execute(). TypeBox supports unions, but a flat schema is friendlier to the
// LLM — it sees one parameter object, with field descriptions scoped to the
// action that uses them.

const MessageParams = Type.Object({
	action: Type.Union(
		[Type.Literal("send"), Type.Literal("subscribe"), Type.Literal("unsubscribe")],
		{ description: "The action: send, subscribe, or unsubscribe." },
	),
	to: Type.Optional(
		Type.String({ description: "Recipient agent ID (for action=send, point-to-point)." }),
	),
	channel: Type.Optional(
		Type.String({
			description:
				"Channel name (for subscribe/unsubscribe, or for action=send to broadcast).",
		}),
	),
	summary: Type.Optional(
		Type.String({ description: "Brief summary shown in notifications (for action=send)." }),
	),
	body: Type.Optional(
		Type.String({ description: "Full message body (for action=send)." }),
	),
	priority: Type.Optional(
		Type.Union([Type.Literal("normal"), Type.Literal("high")], {
			description: "Message priority (for action=send). Default normal.",
		}),
	),
});

type MessageParamsType = Static<typeof MessageParams>;

const MESSAGE_DESCRIPTION =
	"Send messages to agents and manage channel subscriptions.\n\n" +
	"Actions:\n" +
	"- **send**: Send a message to an agent (via `to`) or broadcast to a channel " +
	"(via `channel`). Requires `summary` and `body`.\n" +
	"- **subscribe**: Subscribe to a channel to receive all messages sent to it.\n" +
	"- **unsubscribe**: Unsubscribe from a channel.";

const MESSAGE_PROMPT_SNIPPET =
	"- **message** — send DMs (`to=`) or broadcasts (`channel=`), subscribe/" +
	"unsubscribe to channels. Messaging between sessions.";

/** Dependencies the tool needs at call time. The extension supplies this via
 *  a getter so the tool can be registered at session_start even though the
 *  DaemonClient is built in the same pass. */
export interface MessageToolDeps {
	/** The live daemon client, or null if the daemon failed to come up. */
	getDaemon: () => DaemonClient | null;
}

export function buildMessageTool(deps: MessageToolDeps) {
	return defineTool({
		name: "message",
		label: "Message",
		description: MESSAGE_DESCRIPTION,
		promptSnippet: MESSAGE_PROMPT_SNIPPET,
		parameters: MessageParams,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const daemon = deps.getDaemon();
			if (!daemon) {
				return err("kiln-lite daemon client not available — session not fully initialized.");
			}

			switch (params.action) {
				case "send":
					return dispatchSend(daemon, params);
				case "subscribe":
					return dispatchSubscribe(daemon, params);
				case "unsubscribe":
					return dispatchUnsubscribe(daemon, params);
			}
		},
	});
}

async function dispatchSend(
	daemon: DaemonClient,
	params: MessageParamsType,
): Promise<AgentToolResult<unknown>> {
	const { to, channel, summary, body } = params;
	const priority = params.priority ?? "normal";

	if (!summary || !body) {
		return err("send requires both 'summary' and 'body'.");
	}
	if (!to && !channel) {
		return err("send requires either 'to' (agent ID) or 'channel' (for broadcast).");
	}
	if (to && channel) {
		return err("send takes either 'to' OR 'channel', not both.");
	}

	try {
		if (to) {
			await daemon.sendDirect(to, summary, body, priority);
			return ok(`Message sent to ${to}.`);
		}
		// channel branch
		const count = await daemon.publish(channel!, summary, body, priority);
		return ok(`Message broadcast to channel '${channel}' (${count} recipient(s)).`);
	} catch (e) {
		return err(`send failed: ${(e as Error).message}`);
	}
}

async function dispatchSubscribe(
	daemon: DaemonClient,
	params: MessageParamsType,
): Promise<AgentToolResult<unknown>> {
	const { channel, to, summary, body } = params;
	if (!channel) return err("subscribe requires 'channel'.");
	if (to || summary || body) {
		return err("subscribe takes only 'channel' — drop 'to'/'summary'/'body'.");
	}
	try {
		const count = await daemon.subscribe(channel);
		return ok(`Subscribed to '${channel}' (${count} subscriber(s)).`);
	} catch (e) {
		return err(`subscribe failed: ${(e as Error).message}`);
	}
}

async function dispatchUnsubscribe(
	daemon: DaemonClient,
	params: MessageParamsType,
): Promise<AgentToolResult<unknown>> {
	const { channel, to, summary, body } = params;
	if (!channel) return err("unsubscribe requires 'channel'.");
	if (to || summary || body) {
		return err("unsubscribe takes only 'channel' — drop 'to'/'summary'/'body'.");
	}
	try {
		await daemon.unsubscribe(channel);
		return ok(`Unsubscribed from '${channel}'.`);
	} catch (e) {
		return err(`unsubscribe failed: ${(e as Error).message}`);
	}
}

function ok(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function err(text: string): AgentToolResult<unknown> {
	// AgentToolResult has no isError field — the pi-coding-agent layer maps
	// thrown errors to isError. We return a text result and mark it via
	// throwing so the LLM sees it framed as an error. Throwing here is the
	// documented way (see AgentTool.execute contract).
	throw new Error(text);
}

/**
 * Builtin `message` tool — single-entrypoint messaging surface for the agent.
 *
 * Mirrors Kiln's Message tool shape (kiln/src/kiln/tools.py:1270-1310):
 *   - One tool with an `action` discriminator.
 *   - Actions: send | subscribe | unsubscribe | channels | history.
 *   - `send` is unified: `to=<session>` for DM, `channel=<name>` for broadcast.
 *
 * A thin skin, like `kl message` (src/client/cli.ts): sending goes through
 * the DaemonClient the extension holds, reading through src/client/messages.ts.
 * Neither calls the other.
 *
 * Quoting hazards are gone — `body` is just a structured string param,
 * newlines/quotes/backticks all pass through untouched.
 */

import { Type, type Static } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import type { DaemonClient } from "../../src/client/index.ts";
import { send, sendChannel } from "../../src/client/send.ts";
import {
	channelName,
	formatChannels,
	formatHistory,
	listChannels,
	readHistory,
	resolveHistoryTarget,
	ResolveError,
} from "../../src/client/messages.ts";

// --- Parameter schema ---------------------------------------------------------
//
// Flat schema with optional fields. Per-action validation happens at the top of
// execute(). TypeBox supports unions, but a flat schema is friendlier to the
// LLM — it sees one parameter object, with field descriptions scoped to the
// action that uses them.

const MessageParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("send"),
			Type.Literal("subscribe"),
			Type.Literal("unsubscribe"),
			Type.Literal("channels"),
			Type.Literal("history"),
		],
		{ description: "The action: send, subscribe, unsubscribe, channels, or history." },
	),
	to: Type.Optional(
		Type.String({ description: "Session name, e.g. reviewer-calm-fox, or name@<id-prefix>. For action=send: the recipient (a session that is not running gets the message parked until it is resumed). For action=history: whose inbox to read." }),
	),
	channel: Type.Optional(
		Type.String({
			description:
				"Channel name, with or without '#': letters, digits, '.', '_' and '-' (for subscribe/unsubscribe, for action=send to broadcast, or for action=history to read the channel).",
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
	wake: Type.Optional(
		Type.Boolean({
			description:
				"For action=send with `to`: if the session isn't running, start it (detached) so it reads the message now. Not for channels.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, description: "For action=history: how many of the newest messages to show. Default 20." }),
	),
});

type MessageParamsType = Static<typeof MessageParams>;

const MESSAGE_DESCRIPTION =
	"Send messages to agents and manage channel subscriptions.\n\n" +
	"Actions:\n" +
	"- **send**: Send a message to an agent (via `to`) or broadcast to a channel " +
	"(via `channel`). Requires `summary` and `body`. A direct message to a session " +
	"that isn't running is parked in its inbox until it is resumed, or with `wake: true` " +
	"the session is started now; an unknown name fails. Subscribers that aren't running " +
	"get channel messages parked in their inbox too.\n" +
	"- **subscribe**: Subscribe to a channel to receive all messages sent to it. " +
	"A subscription lasts until you unsubscribe, across exits and resumes.\n" +
	"- **unsubscribe**: Unsubscribe from a channel.\n" +
	"- **channels**: List every channel with its subscribers and message count.\n" +
	"- **history**: Read a channel's history (`channel`) or the mail in a session's " +
	"inbox (`to`), newest `limit` messages (default 20), oldest first.";

const MESSAGE_PROMPT_SNIPPET =
	"Send DMs (`to=`) or broadcasts (`channel=`), subscribe/" +
	"unsubscribe to channels, list channels, read channel or inbox history.";

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
				case "channels":
					return ok(formatChannels(listChannels({ self: daemon.requester.session })));
				case "history":
					return dispatchHistory(params);
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
		return err("send requires either 'to' (session name) or 'channel' (for broadcast).");
	}
	if (to && channel) {
		return err("send takes either 'to' OR 'channel', not both.");
	}

	if (channel && params.wake) {
		return err("wake works only for a message to a session (`to`), not a channel.");
	}
	let r;
	try {
		r = to
			? await send(daemon, to, summary, body, { priority, wake: params.wake })
			: await sendChannel(daemon, channel!, summary, body, { priority });
	} catch (e) {
		return err(`send failed: ${(e as Error).message}`);
	}
	// A failed wake is not a failed send: the message is parked. ok() so the model doesn't resend.
	return ok(r.text);
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
		const name = channelName(channel);
		const count = await daemon.subscribe(name);
		return ok(`Subscribed to #${name} (${count} subscriber(s)).`);
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
		const name = channelName(channel);
		await daemon.unsubscribe(name);
		return ok(`Unsubscribed from #${name}.`);
	} catch (e) {
		return err(`unsubscribe failed: ${(e as Error).message}`);
	}
}

function dispatchHistory(params: MessageParamsType): AgentToolResult<unknown> {
	const { to, channel } = params;
	if (!to && !channel) return err("history requires either 'to' (session name) or 'channel'.");
	if (to && channel) return err("history takes either 'to' OR 'channel', not both.");
	let target;
	try {
		target = resolveHistoryTarget(to ?? `#${channelName(channel!)}`);
	} catch (e) {
		if (e instanceof ResolveError) return err(e.message);
		throw e;
	}
	const text = formatHistory(target, readHistory(target, { limit: params.limit ?? 20 }));
	return ok(target.kind === "session" && target.note ? `${target.note}\n${text}` : text);
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

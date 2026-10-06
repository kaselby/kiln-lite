/**
 * Sending, with the one rule `kl message send` and the `message` tool share:
 * `wake`. A DM with wake to a session that isn't running is parked as usual,
 * then the session is started detached with wake() (the same as `kl resume
 * --detach`). wake() takes the session's wake lock and does nothing if the
 * session is running, so repeated waking sends start it at most once.
 * Channel sends can't wake.
 */

import { channelName, validChannel } from "../daemon/protocol.ts";
import { wake as wakeSession } from "../sessions/launch.ts";
import type { DaemonClient } from "./index.ts";

export interface SendOptions {
	priority?: "normal" | "high";
	/** DMs only: start the recipient if it isn't running. */
	wake?: boolean;
	/** kl root (tests). */
	root?: string;
	/** Lease wait for the woken session (tests). */
	wakeTimeoutMs?: number;
}

export interface SendResult {
	/** What to show the sender. */
	text: string;
	/** False when the message went out but the wake failed. */
	ok: boolean;
}

/** `#name` → channel send; anything else → DM by session name. */
export async function send(client: DaemonClient, to: string, summary: string, body: string, opts: SendOptions = {}): Promise<SendResult> {
	const priority = opts.priority ?? "normal";
	if (to.startsWith("#")) return sendChannel(client, to, summary, body, opts);
	const r = await client.sendDirect(to, summary, body, priority);
	if (r.live || !opts.wake) return { text: r.message, ok: true };
	const note = r.note ? `\n${r.note}` : "";
	try {
		const w = await wakeSession(r.session, { root: opts.root, timeoutMs: opts.wakeTimeoutMs });
		const text = w.started ? `woke ${w.name}; the message is in its inbox` : `sent to ${w.name} (it was already running)`;
		return { text: text + note, ok: true };
	} catch (e) {
		return { text: `parked for ${r.name}, but could not wake it: ${(e as Error).message}${note}`, ok: false };
	}
}

/** A channel broadcast. `channel` may carry a leading '#'. */
export async function sendChannel(client: DaemonClient, channel: string, summary: string, body: string, opts: SendOptions = {}): Promise<SendResult> {
	const name = channelName(channel);
	if (opts.wake) throw new Error("wake works only for a message to a session, not a channel");
	if (!validChannel(name)) throw new Error(`bad channel name '${channel}': use letters, digits, '.', '_' and '-'`);
	const n = await client.publish(name, summary, body, opts.priority ?? "normal");
	return { text: `sent to #${name} (${n} recipient${n === 1 ? "" : "s"})`, ok: true };
}

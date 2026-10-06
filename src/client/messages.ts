/**
 * Reading messages: channels, channel history, a session's inbox. Shared by
 * `kl message` (cli.ts) and the `message` tool, so neither has logic the
 * other can't reach. Sending stays on DaemonClient (index.ts).
 *
 * Everything here reads files; nothing needs the daemon to be up:
 *   <kl root>/daemon/subscriptions/<uuid>.json      a session's channels (the daemon mirrors every change here)
 *   <kl root>/daemon/channels/<name>/history.jsonl  every message ever posted to a channel
 *   <kl root>/run/inbox/<uuid>/<id>.md              a session's mail (DMs and channel copies); <id>.read = delivered
 *
 * Output uses names, never UUIDs (`from`, `to`, subscribers). from_session
 * is the sender's UUID, kept for callers that need identity.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

import { liveLeases } from "../sessions/lease.ts";
import { daemonDir, inboxDir, klRoot } from "../sessions/paths.ts";
import { listEntries } from "../sessions/registry.ts";
import { resolveTarget, ResolveError } from "../sessions/resolve.ts";

export { ResolveError };

export interface MessageRecord {
	/** Inbox: the file's basename without .md. Channel: `<channel>:<line number>`. */
	id: string;
	/** ISO, UTC. */
	ts: string;
	from: string;
	from_session?: string;
	/** Recipient name (inbox mail only). */
	to?: string;
	channel?: string;
	summary: string;
	body: string;
	priority: "normal" | "high";
	/** Inbox mail only: delivered to the session (a .read marker exists). */
	read?: boolean;
	/** Inbox mail only: the message file. */
	path?: string;
}

export interface ChannelInfo {
	name: string;
	/** Subscriber session names, sorted. */
	subscribers: string[];
	subscriber_count: number;
	/** Messages in the channel's history. */
	messages: number;
	/** Timestamp of the newest message, if any. */
	last?: string;
	/** Present when the caller passed `self`: whether that session subscribes. */
	subscribed?: boolean;
}

export type HistoryTarget =
	| { kind: "channel"; channel: string }
	| { kind: "session"; uuid: string; name: string; running: boolean; note?: string };

/** A channel name that is safe as a directory name under channels/. */
export function validChannel(name: string): boolean {
	return !!name && !name.includes("/") && !name.startsWith(".") && name !== "..";
}

/** "#name" or "name" → "name". */
export function channelName(s: string): string {
	return s.startsWith("#") ? s.slice(1) : s;
}

/** uuid → current name: live lease first, then registry. */
function nameLookup(root: string): (uuid: string) => string {
	const live = liveLeases(root);
	const reg = new Map(listEntries(root).map((e) => [e.uuid, e.name]));
	return (uuid) => live.get(uuid)?.name ?? reg.get(uuid) ?? uuid;
}

/** Every channel that exists: has a subscriber or any history. */
export function listChannels(opts: { root?: string; self?: string } = {}): ChannelInfo[] {
	const root = opts.root ?? klRoot();
	const dir = daemonDir(root);
	const subs = new Map<string, Set<string>>();
	const subDir = join(dir, "subscriptions");
	let files: string[] = [];
	try {
		files = readdirSync(subDir);
	} catch {
		// no subscriptions yet
	}
	for (const f of files) {
		if (!f.endsWith(".json") || f.startsWith(".")) continue;
		const uuid = f.slice(0, -5);
		try {
			const data = JSON.parse(readFileSync(join(subDir, f), "utf8")) as { channels?: unknown };
			if (!Array.isArray(data.channels)) continue;
			for (const c of data.channels) {
				if (typeof c !== "string") continue;
				if (!subs.has(c)) subs.set(c, new Set());
				subs.get(c)!.add(uuid);
			}
		} catch {
			// unreadable subscription file: skip
		}
	}
	const names = new Set(subs.keys());
	try {
		for (const c of readdirSync(join(dir, "channels"))) if (validChannel(c)) names.add(c);
	} catch {
		// no history yet
	}
	const nameOf = nameLookup(root);
	return [...names].sort().map((name) => {
		const members = subs.get(name) ?? new Set<string>();
		const hist = readChannelLines(root, name);
		const info: ChannelInfo = {
			name,
			subscribers: [...members].map(nameOf).sort(),
			subscriber_count: members.size,
			messages: hist.length,
		};
		const last = hist.length ? parseHistoryLine(hist[hist.length - 1], name, hist.length)?.ts : undefined;
		if (last) info.last = last;
		if (opts.self) info.subscribed = members.has(opts.self);
		return info;
	});
}

/**
 * "#name" → a channel; anything else → a session, resolved like any
 * <session> (resolve.ts). Throws ResolveError for an unknown session or a
 * bad channel name.
 */
export function resolveHistoryTarget(target: string, opts: { root?: string } = {}): HistoryTarget {
	const t = target.trim();
	if (t.startsWith("#")) {
		const channel = t.slice(1);
		if (!validChannel(channel)) throw new ResolveError(`bad channel name '${t}'`);
		return { kind: "channel", channel };
	}
	const r = resolveTarget(t, { root: opts.root });
	return { kind: "session", uuid: r.uuid, name: r.name, running: !!r.lease, note: r.note };
}

function channelHistoryPath(root: string, channel: string): string {
	return join(daemonDir(root), "channels", channel, "history.jsonl");
}

function readChannelLines(root: string, channel: string): string[] {
	try {
		return readFileSync(channelHistoryPath(root, channel), "utf8").split("\n").filter((l) => l.trim());
	} catch {
		return [];
	}
}

function parseHistoryLine(line: string, channel: string, lineNo: number): MessageRecord | null {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	return {
		id: `${channel}:${lineNo}`,
		ts: str(raw.ts),
		from: str(raw.from),
		...(typeof raw.from_session === "string" ? { from_session: raw.from_session } : {}),
		channel,
		summary: str(raw.summary),
		body: str(raw.body),
		priority: raw.priority === "high" ? "high" : "normal",
	};
}

/** Flat `key: value` frontmatter (the shape src/daemon/inbox.ts writes). */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return { fields, body: text.trim() };
	const lines = text.split("\n");
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
		const at = lines[i].indexOf(":");
		if (at === -1) continue;
		let v = lines[i].slice(at + 1).trim();
		if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		fields[lines[i].slice(0, at).trim()] = v;
	}
	if (end === -1) return { fields: {}, body: text.trim() };
	return { fields, body: lines.slice(end + 1).join("\n").trim() };
}

/** One inbox message file → a record. */
export function readInboxMessage(dir: string, file: string): MessageRecord | null {
	const path = join(dir, file);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const { fields, body } = parseFrontmatter(text);
	const id = file.slice(0, -3);
	return {
		id,
		ts: fields.timestamp ?? "",
		from: fields.from ?? "",
		...(fields.from_session ? { from_session: fields.from_session } : {}),
		...(fields.to ? { to: fields.to } : {}),
		...(fields.channel ? { channel: fields.channel } : {}),
		summary: fields.summary ?? "",
		body,
		priority: fields.priority === "high" ? "high" : "normal",
		read: existsSync(join(dir, `${id}.read`)),
		path,
	};
}

/** Message files in an inbox dir, oldest first (names start with a UTC timestamp). */
export function inboxFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md") && !f.startsWith("."))
			.sort();
	} catch {
		return [];
	}
}

/** The last `limit` messages (default all), oldest first. */
export function readHistory(target: HistoryTarget, opts: { root?: string; limit?: number } = {}): MessageRecord[] {
	const root = opts.root ?? klRoot();
	const limit = opts.limit ?? Infinity;
	if (target.kind === "channel") {
		const lines = readChannelLines(root, target.channel);
		const start = Math.max(0, lines.length - limit);
		const out: MessageRecord[] = [];
		for (let i = start; i < lines.length; i++) {
			const m = parseHistoryLine(lines[i], target.channel, i + 1);
			if (m) out.push(m);
		}
		return out;
	}
	const dir = inboxDir(target.uuid, root);
	const files = inboxFiles(dir);
	return files
		.slice(Math.max(0, files.length - limit))
		.map((f) => readInboxMessage(dir, f))
		.filter((m): m is MessageRecord => m !== null);
}

/**
 * Stream messages that arrive after this call, by polling (cheap: one stat
 * or readdir per tick). Returns a stop function.
 */
export function followHistory(
	target: HistoryTarget,
	onMessage: (m: MessageRecord) => void,
	opts: { root?: string; intervalMs?: number } = {},
): () => void {
	const root = opts.root ?? klRoot();
	const interval = opts.intervalMs ?? 500;
	let tick: () => void;
	if (target.kind === "channel") {
		const path = channelHistoryPath(root, target.channel);
		const size = (): number => {
			try {
				return statSync(path).size;
			} catch {
				return 0;
			}
		};
		let offset = size();
		let lineNo = readChannelLines(root, target.channel).length;
		let partial = "";
		tick = () => {
			const now = size();
			if (now < offset) offset = 0; // truncated or replaced: start over
			if (now === offset) return;
			const buf = Buffer.alloc(now - offset);
			const fd = openSync(path, "r");
			try {
				readSync(fd, buf, 0, buf.length, offset);
			} finally {
				closeSync(fd);
			}
			offset = now;
			const text = partial + buf.toString("utf8");
			const lines = text.split("\n");
			partial = lines.pop() ?? "";
			for (const l of lines) {
				if (!l.trim()) continue;
				lineNo++;
				const m = parseHistoryLine(l, target.channel, lineNo);
				if (m) onMessage(m);
			}
		};
	} else {
		const dir = inboxDir(target.uuid, root);
		const seen = new Set(inboxFiles(dir));
		tick = () => {
			for (const f of inboxFiles(dir)) {
				if (seen.has(f)) continue;
				seen.add(f);
				const m = readInboxMessage(dir, f);
				if (m) onMessage(m);
			}
		};
	}
	const timer = setInterval(tick, interval);
	return () => clearInterval(timer);
}

// --- text formatting (the CLI and the message tool show the same thing) ---

function clock(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts || "?";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Header line plus the body indented by four spaces. */
export function formatMessage(m: MessageRecord, opts: { showRead?: boolean } = {}): string {
	const where = m.to ? `${m.from} -> ${m.to}` : m.from;
	const tags = [m.channel && m.to ? `#${m.channel}` : "", m.priority === "high" ? "high" : "", opts.showRead && m.read === false ? "new" : ""]
		.filter(Boolean)
		.join(", ");
	const head = `${clock(m.ts)}  ${where}${tags ? ` [${tags}]` : ""}: ${m.summary}`;
	const body = m.body ? `\n${m.body.split("\n").map((l) => `    ${l}`.trimEnd()).join("\n")}` : "";
	return head + body;
}

export function formatHistory(target: HistoryTarget, msgs: MessageRecord[]): string {
	const title = target.kind === "channel" ? `#${target.channel}` : `${target.name} inbox (${target.running ? "running" : "not running"})`;
	if (msgs.length === 0) return `${title}: (no messages)`;
	return [`${title}:`, ...msgs.map((m) => formatMessage(m, { showRead: target.kind === "session" }))].join("\n\n");
}

export function formatChannels(list: ChannelInfo[]): string {
	if (list.length === 0) return "(no channels)";
	const width = Math.max(8, ...list.map((c) => c.name.length + 1));
	const lines = list.map((c) => {
		const mark = c.subscribed ? "*" : " ";
		const subs = `${c.subscriber_count} subscriber${c.subscriber_count === 1 ? "" : "s"}`;
		const msgs = `${c.messages} message${c.messages === 1 ? "" : "s"}${c.last ? `, last ${clock(c.last)}` : ""}`;
		const who = c.subscribers.length ? `  (${c.subscribers.join(", ")})` : "";
		return `${mark} ${`#${c.name}`.padEnd(width)}  ${subs.padEnd(14)}  ${msgs}${who}`;
	});
	if (list.some((c) => c.subscribed)) lines.push("* = you subscribe");
	return lines.join("\n");
}

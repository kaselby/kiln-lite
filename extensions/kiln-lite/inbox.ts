/**
 * Inbox watcher + delivery.
 *
 * Watches $INBOX for new .md files. Two delivery modes:
 *
 *   Idle delivery — agent has no turn in flight:
 *     pi.sendUserMessage(body) fires immediately — the message IS the
 *     user turn. No notification wrapper; the frontmatter + body go in
 *     as-is. The delivered file is moved to $INBOX/.read/.
 *
 *   Mid-turn ping — a turn is in flight:
 *     We append a per-message [Notification | …] block to the next
 *     tool_result (matching kiln's format — sender, source, timestamp,
 *     and the message file path). The agent Reads the file to get the
 *     body. Injection dedup is session-lifetime so the same message
 *     isn't re-pinged across subsequent tool_results in the same turn.
 *
 * Dedup: session-resident via pi.appendEntry("inbox-cursor", {ids}),
 * with .read/ move as belt-and-suspenders for cross-session dedup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, watch, type FSWatcher } from "node:fs";
import { join, basename } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface InboxWatcher {
	/** Stop the watcher — called from session_shutdown. */
	stop(): void;
	/** Snapshot of current unread count — for mid-turn pings. */
	unreadCount(): number;
	/**
	 * Called from a tool_result handler to enrich mid-turn results with an
	 * unread indicator. Returns the suffix string (may be empty).
	 */
	midTurnSuffix(): string;
	/** Mark all currently-known messages as seen (e.g. after agent reads them). */
	markAllSeen(): void;
}

export interface InboxWatcherOptions {
	inboxDir: string;
	pi: ExtensionAPI;
	/**
	 * Called to check if the agent is idle. Pi's ExtensionAPI doesn't expose
	 * isIdle on the `pi` object directly — only on ctx — so we take a predicate.
	 */
	isIdle: () => boolean;
	warn: (msg: string) => void;
}

export function startInboxWatcher(opts: InboxWatcherOptions): InboxWatcher {
	const { inboxDir, pi, isIdle, warn } = opts;
	const readDir = join(inboxDir, ".read");

	// Ensure dirs exist.
	try {
		mkdirSync(inboxDir, { recursive: true });
		mkdirSync(readDir, { recursive: true });
	} catch (err) {
		warn(`kiln-lite: failed to create inbox dirs: ${(err as Error).message}`);
	}

	// Track seen IDs in-memory. Initial scan populates with existing .read/ contents
	// so resumed sessions don't redeliver.
	const seen = new Set<string>();
	try {
		for (const name of readdirSync(readDir)) {
			seen.add(name);
		}
	} catch {
		// readDir missing — ok.
	}

	// On startup, also drain anything sitting in $INBOX. If agent is idle, deliver
	// each one; if not (shouldn't happen at session_start, but guard anyway), just
	// flag them as pending.
	let pendingIds: string[] = [];

	// Session-lifetime set of filenames we've already surfaced as a mid-turn
	// [Notification | …] block. Matches kiln's behaviour (hooks.py `_injected`):
	// once the agent's been told about a message, we don't re-notify on every
	// subsequent tool_result in the same turn. Cleared alongside pendingIds on
	// agent_end via markAllSeen().
	const injected = new Set<string>();

	const deliverOrQueue = (filename: string): void => {
		if (seen.has(filename)) return;
		const full = join(inboxDir, filename);
		if (!existsSync(full)) return;

		let body: string;
		try {
			body = readFileSync(full, "utf8");
		} catch (err) {
			warn(`kiln-lite: failed to read inbox message ${filename}: ${(err as Error).message}`);
			return;
		}

		if (isIdle()) {
			// Deliver immediately as a real user turn. No notification wrapper
			// — this is semantically different from the mid-turn path. Idle
			// delivery IS the user turn; a [Notification | …] frame would
			// misrepresent it as a system ping. The message body goes in as-is
			// (frontmatter + body); the agent reads sender/summary/channel
			// from the frontmatter naturally.
			try {
				pi.sendUserMessage(body);
			} catch (err) {
				warn(`kiln-lite: sendUserMessage failed for ${filename}: ${(err as Error).message}`);
				return;
			}
			// Move to .read/ and remember.
			moveToRead(full, join(readDir, filename), warn);
			seen.add(filename);
		} else {
			// Queue for mid-turn surface — body stays in $INBOX until agent reads it.
			if (!pendingIds.includes(filename)) pendingIds.push(filename);
		}
	};

	// Initial drain of existing files.
	try {
		for (const name of readdirSync(inboxDir)) {
			if (name === ".read" || !name.endsWith(".md")) continue;
			deliverOrQueue(name);
		}
	} catch {
		// Inbox missing — ok, we just created it above.
	}

	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(inboxDir, { persistent: false }, (_evt, filename) => {
			if (!filename) return;
			if (filename === ".read" || filename.startsWith(".")) return;
			if (!filename.endsWith(".md")) return;
			// fs.watch fires on rename *and* delete; re-check existence.
			if (!existsSync(join(inboxDir, filename))) {
				// File left the inbox (typically moved to .read/ by the `message
				// read` shell tool, which bypasses the extension). Prune from
				// pendingIds so the mid-turn [INBOX: N] counter reflects reality
				// within a turn — otherwise it's monotonic-increasing until
				// agent_end calls markAllSeen().
				const idx = pendingIds.indexOf(filename);
				if (idx !== -1) pendingIds.splice(idx, 1);
				// Also remember we've handled it, so a (pathological) re-appearance
				// of the same filename doesn't trigger redelivery.
				seen.add(filename);
				return;
			}
			deliverOrQueue(filename);
		});
		watcher.on("error", (err) => {
			warn(`kiln-lite: inbox watcher error: ${err.message}`);
		});
	} catch (err) {
		warn(`kiln-lite: failed to start inbox watcher: ${(err as Error).message}`);
	}

	// Persist cursor — session-resident dedup (see design spec §7).
	// The .read/ move handles cross-session dedup as belt-and-suspenders.
	const persistCursor = (): void => {
		try {
			pi.appendEntry("inbox-cursor", { ids: Array.from(seen) });
		} catch {
			// appendEntry may not be available in all modes — non-fatal.
		}
	};

	return {
		stop(): void {
			if (watcher) {
				try {
					watcher.close();
				} catch {
					// ignore
				}
				watcher = null;
			}
			persistCursor();
		},
		unreadCount(): number {
			return pendingIds.length;
		},
		midTurnSuffix(): string {
			// Build per-message [Notification | …] blocks for any pending file
			// we haven't already surfaced this turn. Matches kiln's hooks.py
			// output — structured header + full message path on the next line,
			// so the agent can Read directly.
			const blocks: string[] = [];
			for (const name of pendingIds) {
				if (injected.has(name)) continue;
				const full = join(inboxDir, name);
				const parsed = parseMessage(full);
				const header = parsed ? formatMessageSource(parsed) : `AGENT MESSAGE | source: kiln-lite`;
				blocks.push(`[Notification | ${header}]\n${full}`);
				injected.add(name);
			}
			if (blocks.length === 0) return "";
			return `\n\n${blocks.join("\n\n")}`;
		},
		markAllSeen(): void {
			// Move all pending to .read/ and mark seen.
			for (const name of pendingIds) {
				const src = join(inboxDir, name);
				const dst = join(readDir, name);
				if (existsSync(src)) moveToRead(src, dst, warn);
				seen.add(name);
				injected.delete(name);
			}
			pendingIds = [];
			persistCursor();
		},
	};
}



/** Parsed message metadata mirroring kiln's parse_message() shape. */
interface ParsedMessage {
	from: string;
	summary: string;
	priority: string;
	channel: string;
	timestamp: string;
	source: string;
	body: string;
	path: string;
}

function parseMessage(path: string): ParsedMessage | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	return parseMessageText(text, path);
}

/**
 * Tiny YAML-frontmatter parser — handles the flat scalar shape that kl-msg
 * writes (see src/daemon/inbox.ts). Anything more exotic falls through to
 * the body-only path.
 */
function parseMessageText(text: string, path: string): ParsedMessage | null {
	const result: ParsedMessage = {
		from: "",
		summary: "",
		priority: "normal",
		channel: "",
		timestamp: "",
		source: "",
		body: "",
		path,
	};

	if (!text.startsWith("---")) {
		result.body = text.trim();
		const firstLine = result.body.split("\n")[0] ?? "";
		result.summary = firstLine.slice(0, 200);
		return result;
	}

	const lines = text.split("\n");
	let fmEnd = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			fmEnd = i;
			break;
		}
	}
	if (fmEnd === -1) {
		result.body = text.trim();
		return result;
	}

	for (let i = 1; i < fmEnd; i++) {
		const line = lines[i];
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		// Strip matching surrounding quotes.
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		switch (key) {
			case "from":
				result.from = val;
				break;
			case "summary":
				result.summary = val;
				break;
			case "priority":
				result.priority = val;
				break;
			case "channel":
				result.channel = val;
				break;
			case "timestamp":
				result.timestamp = val;
				break;
			case "source":
				result.source = val;
				break;
		}
	}

	result.body = lines.slice(fmEnd + 1).join("\n").trim();
	return result;
}

/**
 * Build the inner header for a [Notification | …] block. Mirrors kiln's
 * format_message_source() but always emits `source: kiln-lite/...` — kiln-lite
 * currently only carries agent messages (no gateway bridge yet). If/when we
 * add a gateway, extend this the same way kiln does.
 */
function formatMessageSource(msg: ParsedMessage): string {
	const sender = msg.from || "unknown";
	const parts: string[] = [`AGENT MESSAGE from ${sender}`];

	if (msg.channel) {
		const ch = msg.channel.startsWith("#") ? msg.channel : `#${msg.channel}`;
		parts.push(`source: kiln-lite/${ch}`);
	} else {
		parts.push("source: kiln-lite/dm");
	}

	if (msg.priority && msg.priority !== "normal") {
		parts.push(`priority: ${msg.priority}`);
	}

	if (msg.timestamp) {
		const timePart = msg.timestamp.includes("T") ? msg.timestamp.split("T")[1] : msg.timestamp;
		const shortTime = (timePart || "").replace(/Z$/, "").slice(0, 8);
		if (shortTime) parts.push(`sent ${shortTime}`);
	}

	return parts.join(" | ");
}

function moveToRead(src: string, dst: string, warn: (msg: string) => void): void {
	try {
		renameSync(src, dst);
	} catch (err) {
		// rename across devices can fail; try copy+unlink as fallback
		warn(`kiln-lite: could not move ${basename(src)} to .read/: ${(err as Error).message}`);
	}
}

/**
 * Inbox watcher + delivery.
 *
 * Watches $INBOX for new .md files. Two delivery modes:
 *
 *   Idle delivery — agent has no turn in flight:
 *     pi.sendUserMessage(body) fires immediately — the message IS the
 *     user turn. No notification wrapper; the frontmatter + body go in
 *     as-is. A sibling `.read` marker is written to dedup.
 *
 *   Mid-turn ping — a turn is in flight:
 *     We append a per-message [Notification | …] block to the next
 *     tool_result (matching kiln's format — sender, source, timestamp,
 *     and the message file path). The agent Reads the file to get the
 *     body. The `.read` marker is written at ping time so the watcher
 *     doesn't re-deliver as a user turn between turns.
 *
 * Read tracking:
 *   When the agent Reads an inbox .md via Pi's Read tool, the tool_result
 *   hook calls `handleReadOfPath(path)` on the watcher, which touches the
 *   `.read` marker. Idempotent — messages already pinged/delivered already
 *   have a marker; this is belt-and-suspenders for the case where the
 *   agent reads the file before any notification fires (e.g. via `ls`).
 *
 * Marker convention matches kiln's hooks.py: `<name>.md` is the message,
 * `<name>.read` (empty sibling) signals "handled". Directory-move to a
 * `.read/` subdirectory (the pre-2026-04-24 scheme) is obsolete.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface InboxWatcher {
	/** Stop the watcher — called from session_shutdown. */
	stop(): void;
	/** Snapshot of current unread count — for mid-turn pings. */
	unreadCount(): number;
	/**
	 * Called from a tool_result handler to enrich mid-turn results with an
	 * unread indicator. Returns the suffix string (may be empty). Touches
	 * the `.read` marker for any messages surfaced in this pass.
	 */
	midTurnSuffix(): string;
	/**
	 * Invoked from the tool_result hook when the agent runs Pi's Read tool
	 * on a file. No-op unless the path is an inbox .md file we own.
	 */
	handleReadOfPath(filePath: string): void;
	/** Mark all currently-pending messages as seen — called at agent_end. */
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
	const resolvedInboxDir = resolve(inboxDir);

	try {
		mkdirSync(inboxDir, { recursive: true });
	} catch (err) {
		warn(`kiln-lite: failed to create inbox dir: ${(err as Error).message}`);
	}

	// seen = "this .md has been handled". Source of truth is the sibling
	// `.read` marker on disk; `seen` is just an in-memory cache populated at
	// startup + kept in sync as we process messages.
	const seen = new Set<string>();
	try {
		for (const name of readdirSync(inboxDir)) {
			if (!name.endsWith(".md")) continue;
			if (hasMarker(inboxDir, name)) seen.add(name);
		}
	} catch {
		// Inbox missing — ok, we just created it above.
	}

	// pendingIds: .md files the watcher saw arrive mid-turn but hasn't yet
	// surfaced as a [Notification | …] ping. Drains on every midTurnSuffix()
	// call. In the pathological case where agent_end fires without a single
	// tool_result in between, markAllSeen() sweeps it.
	let pendingIds: string[] = [];

	const deliverOrQueue = (filename: string): void => {
		if (seen.has(filename)) return;
		// Marker may exist from a prior session that was killed mid-deliver —
		// respect it.
		if (hasMarker(inboxDir, filename)) {
			seen.add(filename);
			return;
		}
		const full = join(inboxDir, filename);
		if (!existsSync(full)) return;

		if (isIdle()) {
			// Deliver immediately as a real user turn. No notification wrapper
			// — this is semantically different from the mid-turn path. Idle
			// delivery IS the user turn; a [Notification | …] frame would
			// misrepresent it as a system ping. The message body goes in as-is
			// (frontmatter + body); the agent reads sender/summary/channel
			// from the frontmatter naturally.
			let body: string;
			try {
				body = readFileSync(full, "utf8");
			} catch (err) {
				warn(`kiln-lite: failed to read inbox message ${filename}: ${(err as Error).message}`);
				return;
			}
			try {
				pi.sendUserMessage(body);
			} catch (err) {
				warn(`kiln-lite: sendUserMessage failed for ${filename}: ${(err as Error).message}`);
				return;
			}
			touchMarker(inboxDir, filename, warn);
			seen.add(filename);
		} else {
			// Queue for mid-turn surface — body stays in $INBOX until the agent
			// reads it; marker is written when the ping is built.
			if (!pendingIds.includes(filename)) pendingIds.push(filename);
		}
	};

	// Initial drain of existing files.
	try {
		for (const name of readdirSync(inboxDir)) {
			if (!name.endsWith(".md")) continue;
			deliverOrQueue(name);
		}
	} catch {
		// Inbox missing — ok.
	}

	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(inboxDir, { persistent: false }, (_evt, filename) => {
			if (!filename) return;
			if (!filename.endsWith(".md")) return;
			// fs.watch fires on rename + delete; re-check existence.
			if (!existsSync(join(inboxDir, filename))) {
				// File left the inbox — unusual under marker-based tracking
				// (messages don't move anymore) but keep the safety net:
				// prune pending + remember we've handled it.
				const idx = pendingIds.indexOf(filename);
				if (idx !== -1) pendingIds.splice(idx, 1);
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
			// Build per-message [Notification | …] blocks for every pending
			// file. Touch markers as we go — kiln's pattern, prevents the
			// watcher from re-delivering the same message as an idle user
			// turn in a later window. Also prevents redundant re-pings on
			// subsequent tool_results this turn (pendingIds is cleared).
			if (pendingIds.length === 0) return "";
			const blocks: string[] = [];
			for (const name of pendingIds) {
				const full = join(inboxDir, name);
				const parsed = parseMessage(full);
				const header = parsed ? formatMessageSource(parsed) : `AGENT MESSAGE | source: kiln-lite`;
				blocks.push(`[Notification | ${header}]\n${full}`);
				touchMarker(inboxDir, name, warn);
				seen.add(name);
			}
			pendingIds = [];
			return `\n\n${blocks.join("\n\n")}`;
		},
		handleReadOfPath(filePath: string): void {
			// Only react if the path lives inside our inbox dir and points
			// at a .md message file. Everything else (tools dir, code, etc.)
			// passes through untouched.
			if (!filePath) return;
			const abs = resolve(filePath);
			const rel = relativeUnder(resolvedInboxDir, abs);
			if (rel === null) return;
			if (!rel.endsWith(".md")) return;
			// Files nested under a subdir are not our messages (we don't use
			// subdirs; legacy `.read/` leftovers are explicitly not ours).
			if (rel.includes("/")) return;
			if (!existsSync(abs)) return;
			touchMarker(inboxDir, rel, warn);
			seen.add(rel);
			const idx = pendingIds.indexOf(rel);
			if (idx !== -1) pendingIds.splice(idx, 1);
		},
		markAllSeen(): void {
			for (const name of pendingIds) {
				touchMarker(inboxDir, name, warn);
				seen.add(name);
			}
			pendingIds = [];
			persistCursor();
		},
	};
}


/** Sibling `.read` marker path for a .md message filename. */
function markerPathFor(inboxDir: string, mdFilename: string): string {
	const base = mdFilename.replace(/\.md$/, "");
	return join(inboxDir, `${base}.read`);
}

function hasMarker(inboxDir: string, mdFilename: string): boolean {
	return existsSync(markerPathFor(inboxDir, mdFilename));
}

/** Write an empty `.read` sibling marker for a .md message. Idempotent. */
function touchMarker(inboxDir: string, mdFilename: string, warn: (msg: string) => void): void {
	const path = markerPathFor(inboxDir, mdFilename);
	try {
		// Writing empty is idempotent + preserves mtime semantics without
		// needing utimesSync. Overwriting an existing marker is harmless.
		writeFileSync(path, "");
	} catch (err) {
		warn(`kiln-lite: failed to touch marker ${path}: ${(err as Error).message}`);
	}
}

/**
 * Return `abs`'s path relative to `base` if `abs` lives inside `base`,
 * else `null`. Does NOT require `abs` to exist.
 */
function relativeUnder(base: string, abs: string): string | null {
	const b = base.endsWith("/") ? base : `${base}/`;
	if (abs === base) return "";
	if (!abs.startsWith(b)) return null;
	return abs.slice(b.length);
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

/**
 * Inbox watcher + delivery.
 *
 * Model: queue + dispatch. Arrivals always enqueue; dispatch is a separate
 * step invoked at each trigger point, consulting `isIdle()` at dispatch time
 * rather than baking an arrival-time decision into the queue entry.
 *
 *   Queue:
 *     `pendingIds` — .md filenames observed by the fs.watch callback (or the
 *     initial drain) that haven't been surfaced yet. Deduped on insert.
 *
 *   Two dispatch modes, mapped to two output sinks:
 *
 *     dispatchIdle()   — drains the queue via pi.sendUserMessage(body). Each
 *                        message becomes a real user turn; frontmatter + body
 *                        go in as-is. Marker written on success. Triggered
 *                        at startup (initial drain) and at agent_end.
 *
 *     midTurnSuffix()  — builds [Notification | …] blocks for pending
 *                        messages (matching kiln's format) and returns the
 *                        joined suffix string. Markers are touched inline.
 *                        Triggered from the tool_result handler, which
 *                        appends the suffix to the LLM-visible tool result.
 *
 *   Idle vs mid-turn choice lives at the trigger points, not inside the
 *   queue. fs.watch calls enqueue then — if `isIdle()` — dispatchIdle.
 *   tool_result calls midTurnSuffix (by definition we're mid-turn when a
 *   tool_result fires). agent_end calls dispatchIdle (agent transitioning
 *   to idle; the cleanup-sentinel agent_end is skipped — see index.ts).
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	/**
	 * Drain the queue as user-message turns. For each pending .md, read the
	 * body and call `pi.sendUserMessage(body)`; on success touch the marker
	 * and mark seen. On read/send failure, leave the name in the queue so a
	 * later trigger (next tool_result → midTurnSuffix, or a later
	 * dispatchIdle) can re-surface it.
	 *
	 * Called at startup (initial drain — session_start is idle) and at
	 * agent_end (agent is transitioning to idle). Safe to call when the
	 * queue is empty — no-op.
	 */
	dispatchIdle(): void;
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

	// pendingIds: the queue. .md filenames observed by fs.watch (or the
	// initial drain) that haven't been surfaced yet. Deduped on insert.
	// Drained by dispatchIdle (as user turns) or midTurnSuffix (as pings).
	let pendingIds: string[] = [];

	/**
	 * Queue a filename — no dispatch decision. Skips if already seen, already
	 * marked on disk (prior-session marker), or missing. Marker-present means
	 * we've processed it before; record in `seen` and drop.
	 */
	const enqueue = (filename: string): void => {
		if (seen.has(filename)) return;
		if (hasMarker(inboxDir, filename)) {
			seen.add(filename);
			return;
		}
		if (!existsSync(join(inboxDir, filename))) return;
		if (!pendingIds.includes(filename)) pendingIds.push(filename);
	};

	/**
	 * Drain `pendingIds` as user-message turns. For each, read the body and
	 * call pi.sendUserMessage; on success touch marker + mark seen. On
	 * read/send failure, the name stays in the queue — a later dispatch
	 * (tool_result → midTurnSuffix, or a later dispatchIdle) re-surfaces it.
	 *
	 * Does not consult `isIdle()` — callers are responsible for choosing the
	 * right dispatch mode. (See fs.watch callback + agent_end handler.)
	 */
	const dispatchIdle = (): void => {
		if (pendingIds.length === 0) return;
		const remaining: string[] = [];
		for (const filename of pendingIds) {
			const full = join(inboxDir, filename);
			let body: string;
			try {
				body = readFileSync(full, "utf8");
			} catch (err) {
				warn(`kiln-lite: failed to read inbox message ${filename}: ${(err as Error).message}`);
				remaining.push(filename);
				continue;
			}
			try {
				// deliverAs: "followUp" handles the case where the runtime
				// still considers itself "processing" at our dispatch point —
				// notably at agent_end, which fires as the turn transitions
				// out but before the streaming-done state is settled. In that
				// window a bare sendUserMessage throws "Agent is already
				// processing." followUp makes the call succeed regardless:
				// idle → immediate delivery, streaming → queued after the
				// current turn. Same pattern cleanup.ts uses.
				pi.sendUserMessage(body, { deliverAs: "followUp" });
			} catch (err) {
				warn(`kiln-lite: sendUserMessage failed for ${filename}: ${(err as Error).message}`);
				remaining.push(filename);
				continue;
			}
			touchMarker(inboxDir, filename, warn);
			seen.add(filename);
		}
		pendingIds = remaining;
	};

	// Initial drain of existing files. session_start is idle by definition
	// (no turn in flight yet), so queue everything then dispatch as user
	// turns — each becomes a real user message the agent sees at startup.
	try {
		for (const name of readdirSync(inboxDir)) {
			if (!name.endsWith(".md")) continue;
			enqueue(name);
		}
	} catch {
		// Inbox missing — ok.
	}
	dispatchIdle();

	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(inboxDir, { persistent: false }, (_evt, filename) => {
			if (!filename) return;
			// fs.watch fires on any file creation/rename/delete in the dir,
			// including `.read` marker writes. Filter to our message files.
			if (!filename.endsWith(".md")) return;
			// Re-check existence — rename + delete events hit the same branch.
			if (!existsSync(join(inboxDir, filename))) {
				// File left the inbox — unusual under marker-based tracking
				// (messages don't move anymore) but keep the safety net:
				// prune pending + remember we've handled it.
				const idx = pendingIds.indexOf(filename);
				if (idx !== -1) pendingIds.splice(idx, 1);
				seen.add(filename);
				return;
			}
			enqueue(filename);
			// Re-evaluate dispatch at arrival time. If the agent is idle,
			// drain straight to user turns; if mid-turn, leave in queue for
			// the next tool_result (midTurnSuffix) or agent_end
			// (dispatchIdle) to surface.
			if (isIdle()) dispatchIdle();
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
		dispatchIdle(): void {
			dispatchIdle();
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

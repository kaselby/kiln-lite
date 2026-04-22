/**
 * Inbox watcher + delivery.
 *
 * Watches $INBOX for new .md files. Two delivery modes:
 *
 *   Idle delivery — agent has no turn in flight:
 *     pi.sendUserMessage(formattedBody) fires immediately.
 *     The delivered file is moved to $INBOX/.read/.
 *
 *   Mid-turn ping — a turn is in flight:
 *     We append "[INBOX: N unread — check when convenient]" to the next
 *     tool_result. The agent reads the body on its own schedule.
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
			// Deliver immediately. Format it so the agent can see it's an inbox msg.
			const formatted = formatInbox(filename, body);
			try {
				pi.sendUserMessage(formatted);
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
			if (!existsSync(join(inboxDir, filename))) return;
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
			if (pendingIds.length === 0) return "";
			const n = pendingIds.length;
			const plural = n === 1 ? "" : "s";
			return `\n\n[INBOX: ${n} unread message${plural} — check when convenient]`;
		},
		markAllSeen(): void {
			// Move all pending to .read/ and mark seen.
			for (const name of pendingIds) {
				const src = join(inboxDir, name);
				const dst = join(readDir, name);
				if (existsSync(src)) moveToRead(src, dst, warn);
				seen.add(name);
			}
			pendingIds = [];
			persistCursor();
		},
	};
}

function formatInbox(filename: string, body: string): string {
	return `[INBOX MESSAGE — ${filename}]\n\n${body}`;
}

function moveToRead(src: string, dst: string, warn: (msg: string) => void): void {
	try {
		renameSync(src, dst);
	} catch (err) {
		// rename across devices can fail; try copy+unlink as fallback
		warn(`kiln-lite: could not move ${basename(src)} to .read/: ${(err as Error).message}`);
	}
}

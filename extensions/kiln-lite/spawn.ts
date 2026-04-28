/**
 * /spawn — fork the current session into a new tmux window.
 *
 * Shows the same user-message selector as Pi's /fork. When the user picks a
 * message, we build a new session file (entries from root up to — but not
 * including — the selected message), then launch it in a fresh kl tmux
 * session. The original session stays active.
 *
 * Usage:
 *   /spawn          Pick a user message → new tmux window starts from that point
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CURRENT_SESSION_VERSION, type SessionManager } from "@mariozechner/pi-coding-agent";

type ReadonlySessionManager = Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getEntry" | "getLabel" | "getBranch" | "getHeader" | "getEntries" | "getSessionName">;
import { UserMessageSelectorComponent } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

/** Extract plain text from a user message's content field. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
	}
	return "";
}

/** Build a list of {entryId, text} for every user message in the session. */
function getUserMessages(sm: Pick<ReadonlySessionManager, "getEntries">): { entryId: string; text: string }[] {
	const result: { entryId: string; text: string }[] = [];
	for (const entry of sm.getEntries()) {
		if (entry.type !== "message") continue;
		if ((entry as any).message?.role !== "user") continue;
		const text = extractText((entry as any).message.content);
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
}

/**
 * Build a new session JSONL file from the current session, truncated so
 * the leaf is the parent of `beforeEntryId`. Mirrors the logic in
 * SessionManager.createBranchedSession().
 */
function buildForkedSessionFile(
	sm: ReadonlySessionManager,
	cwd: string,
	beforeEntryId: string,
): string | null {
	const originalFile = sm.getSessionFile();
	const entry = sm.getEntry(beforeEntryId);
	if (!entry?.parentId) return null; // first entry — nothing before it

	// Entries from root → parent (the point just before the selected message).
	const path = sm.getBranch(entry.parentId);
	if (path.length === 0) return null;

	// Filter labels — we recreate resolved labels at the end of the chain.
	const pathEntries = path.filter((e: { type: string }) => e.type !== "label");
	const pathIds = new Set(pathEntries.map((e: { id: string }) => e.id));

	// Collect resolved labels that target entries on the path.
	const labelEntries: object[] = [];
	let labelParent: string | null = pathEntries[pathEntries.length - 1]?.id ?? null;
	for (const e of pathEntries) {
		const label = sm.getLabel(e.id);
		if (label) {
			let labelId: string;
			do {
				labelId = randomUUID().slice(0, 8);
			} while (pathIds.has(labelId));
			pathIds.add(labelId);
			labelEntries.push({
				type: "label",
				id: labelId,
				parentId: labelParent,
				timestamp: new Date().toISOString(),
				targetId: e.id,
				label,
			});
			labelParent = labelId;
		}
	}

	// Session header.
	const sessionId = randomUUID();
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
		parentSession: originalFile,
	};

	// Write JSONL.
	const lines = [
		JSON.stringify(header),
		...pathEntries.map((e: object) => JSON.stringify(e)),
		...labelEntries.map((e: object) => JSON.stringify(e)),
	];

	const sessionDir = sm.getSessionDir();
	mkdirSync(sessionDir, { recursive: true });
	const filePath = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	writeFileSync(filePath, lines.join("\n") + "\n");
	return filePath;
}

export function registerSpawnCommand(pi: ExtensionAPI): void {
	pi.registerCommand("spawn", {
		description: "Fork this session into a new tmux window",
		handler: async (_args, ctx) => {
			if (!ctx.sessionManager.getSessionFile()) {
				ctx.ui.notify("Cannot spawn: no session file (ephemeral session)", "warning");
				return;
			}

			const userMessages = getUserMessages(ctx.sessionManager);
			if (userMessages.length === 0) {
				ctx.ui.notify("No messages to spawn from", "warning");
				return;
			}

			// Show Pi's own user-message selector via ctx.ui.custom().
			// UserMessageSelectorComponent renders the full UI (header, borders,
			// message list) but only the inner UserMessageList handles keyboard
			// input. ctx.ui.custom() gives focus to the returned component, so
			// we return a thin duck-typed wrapper that renders the full selector
			// but delegates handleInput to the message list.
			const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;
			const selectedEntryId = await ctx.ui.custom<string | null>(
				(_tui, _theme, _keybindings, done) => {
					const selector = new UserMessageSelectorComponent(
						userMessages.map((m) => ({ id: m.entryId, text: m.text })),
						(entryId) => done(entryId),
						() => done(null),
						initialSelectedId,
					);
					const messageList = selector.getMessageList();
					return {
						invalidate() {
							selector.invalidate();
						},
						render(width: number) {
							return selector.render(width);
						},
						handleInput(data: string) {
							(messageList as any).handleInput(data);
						},
					};
				},
			);

			if (!selectedEntryId) return; // user cancelled

			// Build a truncated session file (entries up to, but not including,
			// the selected user message).
			const forkedFile = buildForkedSessionFile(ctx.sessionManager, ctx.cwd, selectedEntryId);
			if (!forkedFile) {
				ctx.ui.notify("Cannot spawn from the first message (nothing before it)", "warning");
				return;
			}

			// Launch in a new tmux window via kl.
			try {
				const { stdout } = await execFileAsync(
					"kl",
					["--detach", "--", "--session", forkedFile],
					{ cwd: ctx.cwd, env: process.env },
				);
				const agentId = stdout.trim();
				ctx.ui.notify(agentId ? `Spawned → ${agentId}` : "Spawned (could not read agent-id)", agentId ? "info" : "warning");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Spawn failed: ${msg}`, "error");
			}
		},
	});
}

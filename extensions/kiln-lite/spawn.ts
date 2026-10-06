/**
 * /spawn: fork the current session into a new kl session (own tmux session,
 * own name and registry entry). The original keeps running.
 *
 * Shows Pi's /fork user-message selector. The fork holds everything before
 * the picked message (same cut as /fork). Pi 1.0's
 * SessionManager.createBranchedSession writes it; we run it on a second
 * SessionManager opened on our transcript, because it switches the manager it
 * is called on over to the new file (session-manager.js:1276-1278) and the
 * live one must stay put. Then launchNew on this session's agent home (as
 * `kl run --detach -- --session F` does), in-process like the subagent tool.
 *
 * Not a child: no --parent, so it is not ended when this session ends. The
 * fork's header carries parentSession (our transcript) for provenance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager, UserMessageSelectorComponent } from "@earendil-works/pi-coding-agent";

import { launchNew } from "../../src/sessions/launch.ts";
import { writeForkedSession } from "./fork.ts";

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
function getUserMessages(sm: Pick<SessionManager, "getEntries">): { entryId: string; text: string }[] {
	const result: { entryId: string; text: string }[] = [];
	for (const entry of sm.getEntries()) {
		if (entry.type !== "message") continue;
		if ((entry as any).message?.role !== "user") continue;
		const text = extractText((entry as any).message.content);
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
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
			let forkedFile: string | null;
			try {
				forkedFile = writeForkedSession(SessionManager.open(ctx.sessionManager.getSessionFile()!), selectedEntryId);
			} catch (err) {
				ctx.ui.notify(`Spawn failed: ${(err as Error).message}`, "error");
				return;
			}
			if (!forkedFile) {
				ctx.ui.notify("Cannot spawn from the first message (nothing before it)", "warning");
				return;
			}

			// The home, not the agent name: the name need not match the folder,
			// and the home need not be under KL_AGENTS_DIR.
			const home = process.env.AGENT_HOME;
			if (!home) {
				ctx.ui.notify(`Spawn failed: AGENT_HOME not set; fork written to ${forkedFile}`, "error");
				return;
			}
			try {
				const name = launchNew({
					home,
					piArgs: ["--session", forkedFile],
					cwd: ctx.cwd,
					warn: (w) => ctx.ui.notify(w, "warning"),
				});
				ctx.ui.notify(`Spawned → ${name}`, "info");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Spawn failed: ${msg}`, "error");
			}
		},
	});
}

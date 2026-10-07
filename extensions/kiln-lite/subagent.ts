/**
 * `subagent` tool and its two companions:
 *
 *   - Parent side: `subagent` launches a child session of an installed agent
 *     in tmux (launchNew, in-process) with KL_PARENT = our session UUID, and
 *     returns its name at once. `wait: true` blocks until a message from the
 *     child lands in our inbox, the child goes idle, or it dies. Results only
 *     ever come back through the ordinary message tool / inbox.
 *   - Child side: a one-time nudge at agent_before_settle when a run that
 *     started from an input ends without a successful `message` to the parent.
 *   - Parent session_shutdown (not reload): SIGTERM every child whose lease is
 *     live. Their transcripts stay resumable.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import { defaultAgentName, listAgents, resolveAgent } from "../../src/sessions/agents.ts";
import { buildDescription, childPrompt, messageFrom } from "./subagent-text.ts";
import { launchNew } from "../../src/sessions/launch.ts";
import { leaseIsLive, liveLease, readLease, type Lease } from "../../src/sessions/lease.ts";
import { listEntries, readEntry } from "../../src/sessions/registry.ts";
import { resolvesTo } from "../../src/sessions/resolve.ts";

export const NUDGE_TYPE = "kl-subagent-nudge";
const POLL_MS = 500;

export interface SelfInfo {
	uuid: string;
	name: string;
	inboxDir: string;
	cwd: string;
}

export interface SubagentDeps {
	getSelf: () => SelfInfo | null;
	/** True while an exit is under way (cleanup turn or shutdown): no nudge then. */
	exiting: () => boolean;
}

export function installSubagent(pi: ExtensionAPI, deps: SubagentDeps): void {
	pi.registerTool(buildSubagentTool(deps));
	installNudge(pi, deps);

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "reload") return;
		const self = deps.getSelf();
		if (!self) return;
		stopChildren(self.uuid);
	});
}

/** SIGTERM every child of `parentUuid` whose lease is live. Returns the names signalled. */
export function stopChildren(parentUuid: string): string[] {
	const out: string[] = [];
	for (const e of listEntries()) {
		if (e.parent !== parentUuid) continue;
		const l = liveLease(e.uuid);
		if (!l) continue;
		try {
			process.kill(l.pid, "SIGTERM");
			out.push(l.name || e.name);
		} catch {
			// already gone
		}
	}
	return out;
}

/** The default agent's name for the tool description, or why there isn't one. */
function describeDefault(): string {
	try {
		return defaultAgentName();
	} catch (err) {
		return `(none: ${(err as Error).message})`;
	}
}

function buildSubagentTool(deps: SubagentDeps) {
	return defineTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(listAgents(), describeDefault()),
		promptSnippet: "Launch a child session of an installed agent; it reports back by message.",
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({ description: "Installed agent name (see the list in this tool's description). Omit for the default agent." }),
			),
			prompt: Type.String({ description: "The child's first message: what to do and what to send back." }),
			wait: Type.Optional(
				Type.Boolean({ description: "Block until the child messages you, goes idle, or exits. Default false." }),
			),
		}),
		async execute(_id, params, signal): Promise<AgentToolResult<unknown>> {
			const self = deps.getSelf();
			if (!self) throw new Error("subagent: session not initialised");
			let agent: string, home: string;
			try {
				({ name: agent, home } = resolveAgent(params.agent));
			} catch (err) {
				throw new Error(`subagent: ${(err as Error).message}`);
			}
			const warnings: string[] = [];
			const startedAt = Date.now();
			const seen = new Set(listMd(self.inboxDir));
			const name = launchNew({
				home,
				piArgs: [childPrompt(self.name, self.uuid, params.prompt)],
				parent: self.uuid,
				cwd: self.cwd,
				warn: (m) => warnings.push(m),
			});
			const warnText = warnings.length ? `\n${warnings.join("\n")}` : "";
			if (!params.wait) {
				return text(`Launched subagent ${name} (agent ${agent}). It will message you when done.${warnText}`);
			}
			const why = await waitForChild({ self, name, seen, startedAt, signal });
			return text(`Subagent ${name}: ${why}${warnText}`);
		},
	});
}

interface WaitInput {
	self: SelfInfo;
	name: string;
	seen: Set<string>;
	startedAt: number;
	signal?: AbortSignal;
}

/**
 * Poll until (a) a new inbox message from the child, (b) the child is idle
 * after having run: we saw its lease busy, or its transcript already holds an
 * assistant message (a fast run can start and finish between two polls, and
 * the lease is also idle before the first run), (c) its pid dies.
 */
async function waitForChild(w: WaitInput): Promise<string> {
	let uuid: string | null = null;
	let sawBusy = false;
	let sawLive = false;
	for (;;) {
		if (w.signal?.aborted) return "stopped waiting (interrupted); it keeps running";
		uuid ??= findChildUuid(w.self.uuid, w.name);
		for (const f of listMd(w.self.inboxDir)) {
			if (w.seen.has(f)) continue;
			w.seen.add(f);
			let from: string | null = null;
			try {
				from = messageFrom(readFileSync(join(w.self.inboxDir, f), "utf8"));
			} catch {
				continue;
			}
			if (from && (from === w.name || from === uuid)) return "its message arrived";
		}
		if (uuid) {
			const l: Lease | null = readLease(uuid);
			if (l) {
				if (!leaseIsLive(l)) {
					if (sawLive) return "it exited without messaging you";
				} else {
					sawLive = true;
					if (l.state === "busy") sawBusy = true;
					else if (sawBusy || hasRun(uuid)) return "it went idle without messaging you";
				}
			} else if (sawLive) return "it exited without messaging you";
		}
		await sleep(POLL_MS, w.signal);
	}
}

/** The child's transcript has an assistant message (Pi writes the file from the first one on). */
function hasRun(uuid: string): boolean {
	const e = readEntry(uuid);
	if (!e?.transcript) return false;
	try {
		return readFileSync(e.transcript, "utf8").includes('"role":"assistant"');
	} catch {
		return false;
	}
}

/** The child's UUID once its process has written the registry entry. */
function findChildUuid(parentUuid: string, name: string): string | null {
	let best: { uuid: string; created: string } | null = null;
	for (const e of listEntries()) {
		if (e.parent !== parentUuid || e.name !== name) continue;
		if (!best || e.created > best.created) best = { uuid: e.uuid, created: e.created };
	}
	return best?.uuid ?? null;
}

function listMd(dir: string): string[] {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((res) => {
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			res();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

function text(s: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: s }], details: undefined };
}

// --- child side: the nudge -------------------------------------------------

function installNudge(pi: ExtensionAPI, deps: SubagentDeps): void {
	let messagedParent = false;
	let nudged = false;

	pi.on("before_agent_start", async () => {
		messagedParent = false;
		nudged = false;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "message" || event.isError) return;
		if (event.input.action !== "send" || typeof event.input.to !== "string") return;
		const parent = parentOf(deps);
		if (parent && addressesParent(event.input.to, parent)) messagedParent = true;
	});

	pi.on("agent_before_settle", async (event) => {
		if (messagedParent || nudged || event.outcome !== "completed") return;
		if (deps.exiting()) return;
		const parent = parentOf(deps);
		if (!parent) return;
		nudged = true;
		return {
			// Pi passes the accumulated drafts in event.entries and takes a handler's
			// `entries` as the new full list: append, don't replace.
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: NUDGE_TYPE,
					content:
						`<system-reminder>You haven't messaged your parent ${parent.name} since your last input. ` +
						`If you have results or are blocked, send them with the message tool (to: "${parent.name}"). ` +
						`If there is nothing to report, stop.</system-reminder>`,
					display: true,
				},
			],
			continue: true,
		};
	});
}

/** Parent handles (uuid, registry name, live lease name), or null if we have no parent. */
/** Did a send to `to` reach the parent? Its known handles, else what the daemon's resolver picks (agent name, name@prefix). */
function addressesParent(to: string, parent: { uuid: string; handles: Set<string> }): boolean {
	return parent.handles.has(to) || resolvesTo(to, parent.uuid);
}

function parentOf(deps: SubagentDeps): { uuid: string; name: string; handles: Set<string> } | null {
	const self = deps.getSelf();
	if (!self) return null;
	const mine = readEntry(self.uuid);
	const parentUuid = mine?.parent;
	if (!parentUuid) return null;
	const handles = new Set<string>([parentUuid]);
	const entry = readEntry(parentUuid);
	if (entry) handles.add(entry.name);
	const lease = liveLease(parentUuid);
	if (lease?.name) handles.add(lease.name);
	return { uuid: parentUuid, name: lease?.name || entry?.name || parentUuid, handles };
}

/**
 * `schedule` tool: wake this session later, or when a process exits. The
 * records and the detached worker live in src/schedule.ts; the wake arrives
 * as an ordinary inbox message (deliver_self through the daemon).
 */

import { Type } from "@sinclair/typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import type { DaemonClient } from "../../src/client/index.ts";
import { cancelWake, createWake, describe, listWakes, parseDelay } from "../../src/schedule.ts";

export interface ScheduleDeps {
	getDaemon: () => DaemonClient | null;
	getUuid: () => string | null;
}

const DESCRIPTION =
	"Wake this session later. The wake arrives in your inbox as a message carrying your note.\n\n" +
	"Actions:\n" +
	"- **at**: fire after `delay` (30s, 10m, 2h, 1d) or at `time` (ISO 8601, with a timezone).\n" +
	"- **watch**: fire when process `pid` exits (checked every 2s).\n" +
	"- **list**: pending wakes, their worker status and any delivery error.\n" +
	"- **cancel**: remove wake `id`.\n" +
	"Wakes outlive this session (the note waits in its inbox) but not a machine restart.";

export function registerScheduleTool(pi: ExtensionAPI, deps: ScheduleDeps): void {
	pi.registerTool(
		defineTool({
			name: "schedule",
			label: "Schedule",
			description: DESCRIPTION,
			promptSnippet: "- **schedule**: wake this session after a delay, at a time, or when a pid exits.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("at"), Type.Literal("watch"), Type.Literal("list"), Type.Literal("cancel")]),
				delay: Type.Optional(Type.String({ description: "at: 30s, 10m, 2h, 1d." })),
				time: Type.Optional(Type.String({ description: "at: ISO 8601 time, e.g. 2026-10-05T17:00:00-04:00." })),
				pid: Type.Optional(Type.Integer({ description: "watch: the process to wait for." })),
				note: Type.Optional(Type.String({ description: "at/watch: what the wake should remind you of." })),
				id: Type.Optional(Type.String({ description: "cancel: the wake id from at/watch/list." })),
			}),
			async execute(_id, p): Promise<AgentToolResult<unknown>> {
				const uuid = deps.getUuid();
				const daemon = deps.getDaemon();
				if (!uuid || !daemon) throw new Error("schedule: session not initialised");
				switch (p.action) {
					case "list":
						return text(listWakes(uuid));
					case "cancel":
						if (!p.id) throw new Error("cancel requires 'id'");
						return text(cancelWake(uuid, p.id));
					case "at": {
						if (!p.delay === !p.time) throw new Error("at requires exactly one of 'delay' or 'time'");
						let target: number;
						if (p.delay) target = Date.now() + parseDelay(p.delay) * 1000;
						else {
							target = Date.parse(p.time!);
							if (!Number.isFinite(target)) throw new Error(`bad time '${p.time}': use ISO 8601 with a timezone`);
						}
						const r = createWake({ uuid, requester: daemon.requester, kind: "at", target, note: p.note });
						return text(`Wake ${r.id} scheduled: fires ${describe(r)}. Worker pid ${r.worker_pid}.`);
					}
					case "watch": {
						if (p.pid === undefined) throw new Error("watch requires 'pid'");
						const r = createWake({ uuid, requester: daemon.requester, kind: "watch", target: p.pid, note: p.note });
						return text(`Wake ${r.id} scheduled: fires ${describe(r)}. Worker pid ${r.worker_pid}.`);
					}
				}
			},
		}),
	);
}

function text(s: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: s }], details: undefined };
}

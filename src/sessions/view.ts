/**
 * What `kl sessions` and the `sessions` tool show: the list (parent/child
 * trees, with a one-line "doing" per session) and one session in full.
 * Both surfaces call these functions and print the same text, or the
 * objects as JSON.
 *
 * "doing" is the session's plan goal (+ progress, e.g. 2/5), from
 * run/<uuid>/plan.json. An optional run/<uuid>/status.json, written by
 * something outside kl, overrides it (status.ts).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { readPlan, type PlanData } from "../../extensions/kiln-lite/plan.ts";
import { inboxFiles } from "../client/messages.ts";
import { liveLeases, type Lease } from "./lease.ts";
import { inboxDir, klRoot, runDir } from "./paths.ts";
import { lastSeen, listEntries, visibleEntries, type RegistryEntry } from "./registry.ts";
import { resolveTarget } from "./resolve.ts";
import { shortId } from "./resolve.ts";
import { oneLine, readStatus, type SessionStatus } from "./status.ts";
import { existsSync } from "node:fs";

export interface SessionRow {
	uuid: string;
	/** Shortest unique uuid prefix (for name@<id>). */
	id: string;
	name: string;
	agent: string;
	running: boolean;
	/** busy/idle when running, else null. */
	state: "busy" | "idle" | null;
	/** Transcript mtime, ISO; null if never written. */
	last_seen: string | null;
	cwd: string;
	parent: string | null;
	/** Depth in the printed tree (0 = root). */
	depth: number;
	/** One line: the status summary, else the plan goal + progress, else "". */
	doing: string;
	/** True for the session asking (SESSION_UUID). */
	self: boolean;
}

export interface SessionList {
	rows: SessionRow[];
	/** Root trees left out by the limit. */
	older: number;
	/** Never-started sessions left out (no --all). */
	hidden: number;
}

function progress(plan: PlanData): string {
	const done = plan.tasks.filter((t) => t.status === "done").length;
	return plan.tasks.length ? `${done}/${plan.tasks.length}` : "";
}

/** The one-line "doing": status summary, else plan goal (+ progress), else "". */
export function doingLine(status: SessionStatus | null, plan: PlanData | null, max = 60): string {
	if (status && status.summary.trim()) return oneLine(status.summary, max);
	if (!plan || !plan.goal.trim()) return "";
	const p = progress(plan);
	return p ? `${oneLine(plan.goal, max - p.length - 1)} ${p}` : oneLine(plan.goal, max);
}

export function listSessions(opts: { limit?: number; all?: boolean; root?: string; self?: string } = {}): SessionList {
	const root = opts.root ?? klRoot();
	const limit = opts.limit ?? 20;
	const live = liveLeases(root);
	// No transcript = never exchanged a message: hidden unless live or --all.
	const listed = listEntries(root);
	const entries = opts.all ? listed : visibleEntries(listed, live);
	const hidden = listed.length - entries.length;
	// Short ids stay unique against hidden entries too (resolve.ts sees them).
	const all = [...new Set([...listed.map((e) => e.uuid), ...live.keys()])];
	const seen = new Map<string, Date | null>(entries.map((e) => [e.uuid, lastSeen(e)]));
	const recency = (e: RegistryEntry): number => (seen.get(e.uuid) ?? new Date(e.created)).getTime() || 0;
	const byUuid = new Map(entries.map((e) => [e.uuid, e]));
	const children = new Map<string, RegistryEntry[]>();
	const roots: RegistryEntry[] = [];
	for (const e of entries) {
		if (e.parent && byUuid.has(e.parent) && e.parent !== e.uuid) {
			const list = children.get(e.parent) ?? [];
			list.push(e);
			children.set(e.parent, list);
		} else roots.push(e);
	}
	// A tree is as recent as its most recent member.
	const treeRecency = (e: RegistryEntry, depth = 0): number =>
		depth > 50 ? recency(e) : Math.max(recency(e), ...(children.get(e.uuid) ?? []).map((c) => treeRecency(c, depth + 1)));
	roots.sort((a, b) => treeRecency(b) - treeRecency(a));

	const rows: SessionRow[] = [];
	const printed = new Set<string>();
	const add = (e: RegistryEntry, depth: number): void => {
		if (printed.has(e.uuid)) return;
		printed.add(e.uuid);
		const l = live.get(e.uuid);
		rows.push({
			uuid: e.uuid,
			id: shortId(e.uuid, all),
			name: l?.name ?? e.name,
			agent: e.agent,
			running: !!l,
			state: l ? l.state : null,
			last_seen: seen.get(e.uuid)?.toISOString() ?? null,
			cwd: e.cwd,
			parent: e.parent ?? null,
			depth,
			doing: doingLine(readStatus(e.uuid, root), readPlan(root, e.uuid)),
			self: e.uuid === opts.self,
		});
		for (const c of (children.get(e.uuid) ?? []).sort((a, b) => recency(b) - recency(a))) add(c, depth + 1);
	};
	const shown = Number.isFinite(limit) ? roots.slice(0, limit) : roots;
	for (const r of shown) add(r, 0);
	return { rows, older: roots.length - shown.length, hidden };
}

function fmtTime(iso: string | null | undefined): string {
	if (!iso) return "-";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const tilde = (p: string): string => {
	const h = homedir();
	return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};

export function formatSessionList(list: SessionList, root = klRoot()): string {
	const { rows, older, hidden } = list;
	const never = hidden ? `(${hidden} never started a conversation; kl sessions --all)` : "";
	if (rows.length === 0) return never || `(no sessions in ${runDir(root)})`;
	const idWidth = Math.max(8, ...rows.map((r) => r.id.length));
	const label = (r: SessionRow): string => `${"  ".repeat(r.depth)}${r.depth ? "└ " : ""}${r.name}${r.self ? " (you)" : ""}`;
	const nameWidth = Math.max(28, ...rows.map((r) => label(r).length));
	const doingWidth = Math.min(60, Math.max(5, ...rows.map((r) => r.doing.length)));
	const lines = [`  ${"NAME".padEnd(nameWidth)} ${"STATE".padEnd(6)} ${"LAST SEEN".padEnd(16)} ${"ID".padEnd(idWidth)}  ${"DOING".padEnd(doingWidth)}  CWD`];
	for (const r of rows) {
		lines.push(
			`${r.running ? "*" : " "} ${label(r).padEnd(nameWidth)} ${(r.state ?? "-").padEnd(6)} ${fmtTime(r.last_seen).padEnd(16)} ${r.id.padEnd(idWidth)}  ${(r.doing || "-").padEnd(doingWidth)}  ${tilde(r.cwd)}`,
		);
	}
	if (older) lines.push(`(${older} older; kl sessions --all)`);
	if (never) lines.push(never);
	lines.push("* = running. Reach one by name, or name@<id> when a name was reused. kl sessions <name> shows one in full.");
	return lines.join("\n");
}

export interface SessionDetail {
	uuid: string;
	id: string;
	name: string;
	/** Every name it has run under, oldest first. */
	names: string[];
	agent: string;
	home: string;
	running: boolean;
	state: "busy" | "idle" | null;
	/** When the lease entered its current state. */
	since: string | null;
	tmux: string | null;
	created: string;
	last_seen: string | null;
	cwd: string;
	transcript: string;
	parent: { uuid: string; name: string; running: boolean } | null;
	children: { uuid: string; name: string; running: boolean }[];
	inbox: { path: string; messages: number; unread: number };
	status: SessionStatus | null;
	plan: PlanData | null;
	doing: string;
	/** Resolver note (e.g. other sessions used this name). */
	note?: string;
}

/** One session in full. Throws ResolveError for an unknown target. */
export function sessionDetail(target: string, opts: { root?: string } = {}): SessionDetail {
	const root = opts.root ?? klRoot();
	const r = resolveTarget(target, { root });
	const entries = listEntries(root);
	const live = liveLeases(root);
	const byUuid = new Map(entries.map((e) => [e.uuid, e]));
	const all = [...new Set([...entries.map((e) => e.uuid), ...live.keys()])];
	const e = r.entry;
	const l: Lease | null = r.lease;
	const ref = (uuid: string) => ({ uuid, name: live.get(uuid)?.name ?? byUuid.get(uuid)?.name ?? uuid, running: live.has(uuid) });
	const dir = inboxDir(r.uuid, root);
	const files = inboxFiles(dir);
	const unread = files.filter((f) => !existsSync(join(dir, `${f.slice(0, -3)}.read`))).length;
	const status = readStatus(r.uuid, root);
	const plan = readPlan(root, r.uuid);
	const seen = e ? lastSeen(e) : null;
	return {
		uuid: r.uuid,
		id: shortId(r.uuid, all),
		name: r.name,
		names: e ? e.names.map((n) => n.name) : [r.name],
		agent: e?.agent ?? "",
		home: e?.home ?? "",
		running: !!l,
		state: l ? l.state : null,
		since: l?.since || null,
		tmux: l?.tmux || null,
		created: e?.created ?? "",
		last_seen: seen ? seen.toISOString() : null,
		cwd: e?.cwd ?? "",
		transcript: e?.transcript ?? "",
		parent: e?.parent ? ref(e.parent) : null,
		children: entries
			.filter((c) => c.parent === r.uuid && c.uuid !== r.uuid)
			.sort((a, b) => (a.created < b.created ? -1 : 1))
			.map((c) => ref(c.uuid)),
		inbox: { path: dir, messages: files.length, unread },
		status,
		plan,
		doing: doingLine(status, plan),
		...(r.note ? { note: r.note } : {}),
	};
}

const MARK = { done: "[x]", in_progress: "[>]", pending: "[ ]" } as const;

export function formatSessionDetail(d: SessionDetail): string {
	const who = (x: { name: string; running: boolean }) => `${x.name}${x.running ? " *" : ""}`;
	const lines = [
		`${d.name}${d.running ? " *" : ""}  (${d.agent || "?"}, id ${d.id})`,
		`  state:      ${d.running ? `${d.state}${d.since ? ` since ${fmtTime(d.since)}` : ""}${d.tmux ? `, tmux ${d.tmux}` : ""}` : "not running"}`,
		`  last seen:  ${fmtTime(d.last_seen)}   created ${fmtTime(d.created)}`,
		`  parent:     ${d.parent ? who(d.parent) : "-"}`,
		`  children:   ${d.children.length ? d.children.map(who).join(", ") : "-"}`,
		`  cwd:        ${d.cwd || "-"}`,
		`  home:       ${d.home || "-"}`,
		`  transcript: ${d.transcript || "-"}`,
		`  inbox:      ${d.inbox.messages} message${d.inbox.messages === 1 ? "" : "s"}, ${d.inbox.unread} unread  ${d.inbox.path}`,
		`  uuid:       ${d.uuid}`,
	];
	if (d.names.length > 1) lines.push(`  names:      ${d.names.join(", ")}`);
	if (d.status) {
		lines.push("", `status${d.status.updated_at ? ` (${fmtTime(d.status.updated_at)})` : ""}: ${d.status.summary}`);
		if (d.status.detail?.trim()) lines.push(...d.status.detail.trimEnd().split("\n").map((l) => `  ${l}`.trimEnd()));
	}
	if (d.plan) {
		const p = d.plan;
		const n = (s: PlanData["tasks"][number]["status"]) => p.tasks.filter((t) => t.status === s).length;
		const prog = [`${n("done")}/${p.tasks.length} done`, n("in_progress") ? `${n("in_progress")} in progress` : ""].filter(Boolean).join(", ");
		lines.push("", `plan: ${p.goal}`, `  progress:   ${prog}${p.updated_at ? `  (updated ${fmtTime(p.updated_at)})` : ""}`);
		if (p.project) lines.push(`  project:    ${p.project}`);
		if (p.worktree) lines.push(`  worktree:   ${p.worktree}`);
		for (const t of p.tasks) lines.push(`  ${MARK[t.status] ?? "[?]"} ${t.description}`);
	} else if (!d.status) {
		lines.push("", "(no plan)");
	}
	lines.push("", "* = running");
	return lines.join("\n");
}

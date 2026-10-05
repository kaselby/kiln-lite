/**
 * Session registry: one YAML file per Pi session UUID (the UUID is
 * the identity; names are handles). Written by kl at launch and on rename,
 * never at exit. Liveness is NOT here (see lease.ts); "last seen" is the
 * transcript's mtime.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";

import { writeAtomic, isoNow } from "./fsutil.ts";
import { klRoot, sessionsDir, UUID_RE } from "./paths.ts";

export interface NameBinding {
	name: string;
	/** When this session (re)started running under the name. ISO, UTC. */
	bound: string;
}

export interface RegistryEntry {
	uuid: string;
	/** Agent name (agent.yml `name`). */
	agent: string;
	/** Handle of the latest run. */
	name: string;
	/** Every handle it has run under, each with its latest bind time. */
	names: NameBinding[];
	home: string;
	transcript: string;
	cwd: string;
	/** Parent session's UUID (never its name). */
	parent?: string;
	created: string;
	/** What mail does when nothing is live. Only `park` is acted on today. */
	wake: "park" | "auto";
	/** Frozen at first launch; everything else is re-derived from home + agent.yml at wake. */
	launch: { model?: string; thinking?: string };
}

export function entryPath(uuid: string, root = klRoot()): string {
	if (!UUID_RE.test(uuid)) throw new Error(`not a session uuid: ${uuid}`);
	return join(sessionsDir(root), `${uuid}.yml`);
}

export function readEntry(uuid: string, root = klRoot()): RegistryEntry | null {
	let text: string;
	try {
		text = readFileSync(entryPath(uuid, root), "utf8");
	} catch {
		return null;
	}
	return parseEntry(text);
}

export function parseEntry(text: string): RegistryEntry | null {
	let raw: unknown;
	try {
		raw = yaml.load(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.uuid !== "string" || typeof r.name !== "string") return null;
	const names: NameBinding[] = Array.isArray(r.names)
		? (r.names as unknown[])
				.filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
				.filter((n) => typeof n.name === "string")
				.map((n) => ({ name: n.name as string, bound: asIso(n.bound) }))
		: [];
	const launch = (r.launch && typeof r.launch === "object" ? r.launch : {}) as Record<string, unknown>;
	return {
		uuid: r.uuid,
		agent: String(r.agent ?? ""),
		name: r.name,
		names,
		home: String(r.home ?? ""),
		transcript: String(r.transcript ?? ""),
		cwd: String(r.cwd ?? ""),
		parent: typeof r.parent === "string" && r.parent ? r.parent : undefined,
		created: asIso(r.created),
		wake: r.wake === "auto" ? "auto" : "park",
		launch: {
			model: typeof launch.model === "string" ? launch.model : undefined,
			thinking: typeof launch.thinking === "string" ? launch.thinking : undefined,
		},
	};
}

/** js-yaml turns unquoted timestamps into Dates; keep everything as ISO strings. */
function asIso(v: unknown): string {
	if (v instanceof Date) return isoNow(v);
	return typeof v === "string" ? v : "";
}

export function formatEntry(e: RegistryEntry): string {
	const q = (s: string) => JSON.stringify(s);
	const lines = [
		`uuid: ${e.uuid}`,
		`agent: ${e.agent}`,
		`name: ${e.name}`,
		"names:",
		...e.names.map((n) => `  - {name: ${n.name}, bound: ${q(n.bound)}}`),
		`home: ${q(e.home)}`,
		`transcript: ${q(e.transcript)}`,
		`cwd: ${q(e.cwd)}`,
	];
	if (e.parent) lines.push(`parent: ${e.parent}`);
	lines.push(`created: ${q(e.created)}`, `wake: ${e.wake}`);
	const launch: string[] = [];
	if (e.launch.model) launch.push(`model: ${q(e.launch.model)}`);
	if (e.launch.thinking) launch.push(`thinking: ${q(e.launch.thinking)}`);
	lines.push(`launch: {${launch.join(", ")}}`);
	return `${lines.join("\n")}\n`;
}

export function writeEntry(e: RegistryEntry, root = klRoot()): void {
	writeAtomic(entryPath(e.uuid, root), formatEntry(e));
}

export function listEntries(root = klRoot()): RegistryEntry[] {
	let files: string[];
	try {
		files = readdirSync(sessionsDir(root));
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const f of files) {
		if (!f.endsWith(".yml") || f.startsWith(".")) continue;
		const e = readEntry(f.slice(0, -4), root);
		if (e) out.push(e);
	}
	return out;
}

/** Record that `uuid` now runs as `name` (new binding, or a fresh `bound` time for an old one). */
export function bindName(e: RegistryEntry, name: string, now = isoNow()): RegistryEntry {
	const names = e.names.filter((n) => n.name !== name);
	names.push({ name, bound: now });
	return { ...e, name, names };
}

/** Newest bind time of `name` in this entry, or null. */
export function boundAt(e: RegistryEntry, name: string): string | null {
	let best: string | null = null;
	for (const n of e.names) if (n.name === name && (best === null || n.bound > best)) best = n.bound;
	return best;
}

/** Transcript mtime ("last seen"), or null if the file is gone or never written. */
export function lastSeen(e: RegistryEntry): Date | null {
	try {
		return statSync(e.transcript).mtime;
	} catch {
		return null;
	}
}

export function entryExists(uuid: string, root = klRoot()): boolean {
	return existsSync(entryPath(uuid, root));
}

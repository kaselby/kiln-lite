/**
 * Session registry: one YAML file per Pi session UUID (the UUID is
 * the identity; names are handles). Written by the session's own process
 * at each start (extensions/kiln-lite/session.ts), never at exit. Liveness
 * is NOT here (see lease.ts); "last seen" is the transcript's mtime.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import yaml from "js-yaml";

import { writeAtomic, isoNow } from "./fsutil.ts";
import { entryPath, klRoot, sessionUuids } from "./paths.ts";

export { entryPath };

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
	lines.push(`created: ${q(e.created)}`);
	return `${lines.join("\n")}\n`;
}

export function writeEntry(e: RegistryEntry, root = klRoot()): void {
	writeAtomic(entryPath(e.uuid, root), formatEntry(e));
}

export function listEntries(root = klRoot()): RegistryEntry[] {
	const out: RegistryEntry[] = [];
	for (const uuid of sessionUuids(root)) {
		const e = readEntry(uuid, root);
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

/** Entries worth listing: a transcript exists (a message was exchanged) or the session is live. */
export function visibleEntries(entries: RegistryEntry[], live: { has(uuid: string): boolean }): RegistryEntry[] {
	return entries.filter((e) => live.has(e.uuid) || lastSeen(e) !== null);
}

export function entryExists(uuid: string, root = klRoot()): boolean {
	return existsSync(entryPath(uuid, root));
}

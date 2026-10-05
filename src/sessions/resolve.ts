/**
 * Name → session resolution, the one module used by message,
 * attach, resume and the kl CLI:
 *   1. a live lease with that name
 *   2. else the registry entry that bound the name most recently
 *      (the result says when other matches were skipped)
 *   3. `name@<uuid-prefix>` / `@<uuid-prefix>`: exact
 *   4. an agent name: that agent's one live session, else its most recently
 *      bound one (with a note); several live → error listing them
 *   5. else: loud error
 */

import { liveLeases, type Lease } from "./lease.ts";
import { boundAt, listEntries, type RegistryEntry } from "./registry.ts";
import { klRoot } from "./paths.ts";

export interface Resolved {
	uuid: string;
	entry: RegistryEntry | null;
	/** Live lease, or null if not running. */
	lease: Lease | null;
	/** The name the caller should use to talk about it. */
	name: string;
	/** Set when an implicit pick skipped other sessions. */
	note?: string;
}

export class ResolveError extends Error {}

const dashless = (u: string): string => u.replace(/-/g, "").toLowerCase();

/**
 * The shortest prefix of `uuid` (dashes dropped) that no other uuid in
 * `among` shares, and at least 8 characters, git-style. Pi's v7 UUIDs start
 * with a timestamp, so sessions started within ~65 s share their first 8.
 */
export function shortId(uuid: string, among: Iterable<string>): string {
	const me = dashless(uuid);
	let len = 8;
	for (const other of among) {
		const o = dashless(other);
		if (o === me) continue;
		let i = 0;
		while (i < me.length && me[i] === o[i]) i++;
		len = Math.max(len, i + 1);
	}
	return me.slice(0, Math.min(len, me.length));
}

/** Every uuid kl knows: registry entries plus live leases. The population for shortId. */
export function knownUuids(root = klRoot()): string[] {
	return [...new Set([...listEntries(root).map((e) => e.uuid), ...liveLeases(root).keys()])];
}

/** git-style prefix match against the uuid, ignoring dashes. */
function prefixMatches(uuid: string, prefix: string): boolean {
	return uuid.replace(/-/g, "").toLowerCase().startsWith(prefix.replace(/-/g, "").toLowerCase());
}

export function resolveTarget(target: string, opts: { root?: string } = {}): Resolved {
	const root = opts.root ?? klRoot();
	const t = target.trim();
	if (!t) throw new ResolveError("empty session name");
	const entries = listEntries(root);
	const live = liveLeases(root);
	const byUuid = new Map(entries.map((e) => [e.uuid, e]));
	const all = [...new Set([...entries.map((e) => e.uuid), ...live.keys()])];
	const short = (u: string): string => shortId(u, all);

	const at = t.indexOf("@");
	if (at !== -1) {
		const name = t.slice(0, at);
		const prefix = t.slice(at + 1);
		if (prefix.replace(/-/g, "").length < 4) throw new ResolveError(`'${t}': id prefix needs at least 4 characters`);
		let matches = all.filter((u) => prefixMatches(u, prefix));
		if (name) {
			matches = matches.filter((u) => {
				const e = byUuid.get(u);
				return (e && e.names.some((n) => n.name === name)) || live.get(u)?.name === name;
			});
		}
		if (matches.length === 0) throw new ResolveError(`no session matches '${t}'`);
		if (matches.length > 1) {
			throw new ResolveError(`'${t}' is ambiguous: ${matches.map((u) => short(u)).join(", ")}; use a longer prefix`);
		}
		const uuid = matches[0];
		const entry = byUuid.get(uuid) ?? null;
		const lease = live.get(uuid) ?? null;
		return { uuid, entry, lease, name: lease?.name ?? entry?.name ?? (name || short(uuid)) };
	}

	// 1. live lease holding the name
	const liveHits = [...live.values()].filter((l) => l.name === t);
	if (liveHits.length > 0) {
		// Hard-unique among live sessions; >1 means something bypassed the lock.
		liveHits.sort((a, b) => (a.since < b.since ? 1 : -1));
		const l = liveHits[0];
		const others = entries.filter((e) => e.uuid !== l.uuid && e.names.some((n) => n.name === t)).length + liveHits.length - 1;
		return {
			uuid: l.uuid,
			entry: byUuid.get(l.uuid) ?? null,
			lease: l,
			name: t,
			note: others > 0 ? `resolved to the live session; ${others} other session(s) used this name, use ${t}@<id> for another` : undefined,
		};
	}

	// 2. most recently bound
	const hits = entries
		.map((e) => ({ e, bound: boundAt(e, t) }))
		.filter((h): h is { e: RegistryEntry; bound: string } => h.bound !== null)
		.sort((a, b) => (a.bound < b.bound ? 1 : a.bound > b.bound ? -1 : 0));
	if (hits.length > 0) {
		const { e } = hits[0];
		return {
			uuid: e.uuid,
			entry: e,
			lease: live.get(e.uuid) ?? null,
			name: live.get(e.uuid)?.name ?? t,
			note:
				hits.length > 1
					? `resolved to the most recent of ${hits.length} sessions named ${t} (${short(e.uuid)}); use ${t}@<id> for another: ${hits
							.slice(1)
							.map((h) => short(h.e.uuid))
							.join(", ")}`
					: undefined,
		};
	}

	// 4. an agent name
	const ofAgent = entries.filter((e) => e.agent === t);
	if (ofAgent.length > 0) {
		const running = ofAgent.filter((e) => live.has(e.uuid));
		if (running.length > 1) {
			const list = running.map((e) => `${live.get(e.uuid)!.name} (${short(e.uuid)})`).join(", ");
			throw new ResolveError(`${t} is an agent with ${running.length} running sessions: ${list}; name one`);
		}
		const lastBound = (e: RegistryEntry): string => e.names.reduce((m, n) => (n.bound > m ? n.bound : m), "");
		const e = running[0] ?? [...ofAgent].sort((a, b) => (lastBound(a) < lastBound(b) ? 1 : lastBound(a) > lastBound(b) ? -1 : 0))[0];
		const lease = live.get(e.uuid) ?? null;
		const name = lease?.name ?? e.name;
		return {
			uuid: e.uuid,
			entry: e,
			lease,
			name,
			note: lease
				? `${t} is an agent; resolved to its running session ${name}`
				: `${t} is an agent; resolved to its most recent session ${name}`,
		};
	}

	throw new ResolveError(`unknown session '${t}' (no live session or registry entry has that name; see kl sessions)`);
}

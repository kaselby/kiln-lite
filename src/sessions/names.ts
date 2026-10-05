/**
 * Drawing a session name at launch: <agent>-<adj>-<noun>, unique
 * among live sessions (hard), avoiding names bound in the last ~3 weeks
 * (soft), under the names.lock mkdir lock. Never seeded from the UUID and
 * never suffixed: on a clash, redraw.
 */

import { randomInt } from "node:crypto";

export const ADJECTIVES = [
	"bright",
	"still",
	"deep",
	"coral",
	"ember",
	"iron",
	"jade",
	"thorn",
	"swift",
	"wild",
	"storm",
	"blue",
	"red",
	"shadow",
	"stone",
	"silver",
	"first",
	"dawn",
	"dusk",
	"quiet",
	"bold",
	"hollow",
	"gentle",
	"amber",
	"copper",
	"frost",
	"gold",
	"grey",
	"green",
	"lone",
	"loud",
	"misty",
	"moon",
	"north",
	"sharp",
	"sleek",
	"slow",
	"small",
	"snow",
	"soft",
	"south",
	"tall",
	"tame",
	"warm",
	"wise",
	"young",
	"ancient",
	"calm",
	"clear",
	"clever",
	"crisp",
	"fair",
	"fine",
	"glad",
	"keen",
	"lush",
	"mild",
	"neat",
	"proud",
	"rare",
];

export const NOUNS = [
	"raven",
	"hare",
	"falcon",
	"wren",
	"keep",
	"brook",
	"isle",
	"peak",
	"moth",
	"crane",
	"forge",
	"ridge",
	"jay",
	"pine",
	"haven",
	"pond",
	"marsh",
	"bear",
	"wolf",
	"fox",
	"stag",
	"otter",
	"owl",
	"lark",
	"finch",
	"hawk",
	"dove",
	"heron",
	"eagle",
	"thrush",
	"glade",
	"grove",
	"vale",
	"fen",
	"mesa",
	"cliff",
	"shore",
	"bay",
	"reef",
	"cove",
	"fjord",
	"loch",
	"dune",
	"moor",
	"heath",
	"cairn",
	"tower",
	"gate",
	"hall",
	"hearth",
	"barn",
	"mill",
	"forest",
	"wood",
	"copse",
	"trail",
	"path",
	"lane",
	"road",
	"bridge",
];

import { withLock } from "./fsutil.ts";
import { liveLeases } from "./lease.ts";
import { listEntries } from "./registry.ts";
import { klRoot, namesLockPath } from "./paths.ts";
import { tmuxSessionNames } from "./tmux.ts";

/** Names bound within this window are avoided by new draws (soft). */
export const RECENT_MS = 21 * 24 * 3600 * 1000;
const MAX_TRIES = 400;

export const AGENT_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface DrawInput {
	agent: string;
	/** Names held right now (live leases, tmux sessions). Never drawn. */
	held: ReadonlySet<string>;
	/** Names bound recently. Avoided unless nothing else is left. */
	recent: ReadonlySet<string>;
	rand?: (n: number) => number;
}

/** Pure draw. Throws if every name for this agent is held. */
export function drawName(input: DrawInput): string {
	const { agent, held, recent } = input;
	if (!AGENT_NAME_RE.test(agent)) throw new Error(`agent name '${agent}' must match [a-z][a-z0-9_]*`);
	const rand = input.rand ?? ((n: number) => randomInt(n));
	const pick = () => `${agent}-${ADJECTIVES[rand(ADJECTIVES.length)]}-${NOUNS[rand(NOUNS.length)]}`;
	for (let i = 0; i < MAX_TRIES; i++) {
		const n = pick();
		if (!held.has(n) && !recent.has(n)) return n;
	}
	// Random draws keep hitting: walk the whole pool, recent-but-free last.
	let fallback: string | null = null;
	for (const a of ADJECTIVES) {
		for (const b of NOUNS) {
			const n = `${agent}-${a}-${b}`;
			if (held.has(n)) continue;
			if (!recent.has(n)) return n;
			fallback ??= n;
		}
	}
	if (fallback) return fallback;
	throw new Error(`no free session name for agent '${agent}': all ${ADJECTIVES.length * NOUNS.length} are live`);
}

export interface NameState {
	held: Set<string>;
	recent: Set<string>;
}

/** Current held/recent sets from leases, tmux and the registry. */
export function nameState(opts: { root?: string; now?: number; excludeUuid?: string } = {}): NameState {
	const root = opts.root ?? klRoot();
	const now = opts.now ?? Date.now();
	const held = new Set<string>();
	for (const l of liveLeases(root).values()) {
		if (l.uuid === opts.excludeUuid) continue;
		held.add(l.name);
		if (l.tmux) held.add(l.tmux);
	}
	for (const t of tmuxSessionNames()) held.add(t);
	const recent = new Set<string>();
	for (const e of listEntries(root)) {
		for (const n of e.names) {
			const t = Date.parse(n.bound);
			if (Number.isFinite(t) && now - t < RECENT_MS) recent.add(n.name);
		}
	}
	return { held, recent };
}

/**
 * Under names.lock: compute state, let `choose` pick a name (or draw one),
 * then run `commit(name)` (create the tmux session, write the lease) before
 * the lock drops, so a concurrent draw sees the name as held.
 */
export function reserveName<T>(
	choose: (state: NameState) => string,
	commit: (name: string) => T,
	opts: { root?: string; excludeUuid?: string } = {},
): T {
	const root = opts.root ?? klRoot();
	return withLock(namesLockPath(root), () => {
		const name = choose(nameState({ root, excludeUuid: opts.excludeUuid }));
		return commit(name);
	});
}

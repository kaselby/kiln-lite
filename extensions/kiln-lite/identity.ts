/**
 * Deterministic agent ID generation.
 *
 * Shape: <name>-<adjective>-<noun>, seeded from the Pi session UUID.
 * Same UUID -> same ID, so /resume recovers the original agent ID.
 */

import { createHash } from "node:crypto";

// Small curated lists. ~60 each gives ~3600 combinations, plenty for dedup
// within a single machine's active sessions. Kept deliberately short so the
// word pool is easy to scan and extend without ballooning the file.

const ADJECTIVES = [
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

const NOUNS = [
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

/**
 * Generate a deterministic agent ID from a session UUID and name prefix.
 *
 * Uses SHA-256 of the UUID to extract two indices — stable across runs,
 * reproducible from the UUID alone. Same UUID + name -> same ID.
 */
export function generateAgentId(name: string, sessionUuid: string): string {
	const hash = createHash("sha256").update(sessionUuid).digest();
	// Use two distinct 4-byte spans to get two independent indices.
	const adjIdx = hash.readUInt32BE(0) % ADJECTIVES.length;
	const nounIdx = hash.readUInt32BE(4) % NOUNS.length;
	return `${name}-${ADJECTIVES[adjIdx]}-${NOUNS[nounIdx]}`;
}

/**
 * Pure formatting helpers for tool_result mutation.
 *
 * These are extracted from the tool_result handler so the suffix composition
 * rules can be tested in isolation. The handler proper only orchestrates
 * side-effects (state/inbox queries) and then calls these functions.
 */

import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

/**
 * Compose tool_result suffix blocks into a single suffix string.
 *
 * Inputs are arbitrary text blocks (e.g. session-state line, inbox notification
 * blob). Rules:
 *   - Empty / whitespace-only blocks are dropped.
 *   - Leading newlines on each block are stripped.
 *   - All blocks are joined by "\n\n" and the whole thing is prefixed with
 *     "\n\n" so it lands cleanly after existing tool result text.
 *   - Returns null when nothing survives the filter — the caller should
 *     skip the mutation entirely in that case (avoids appending an empty
 *     suffix that adds trailing whitespace to every tool result).
 *
 * Order of blocks is preserved.
 */
export function composeToolResultSuffix(blocks: string[]): string | null {
	const surviving = blocks.filter((s) => s.length > 0);
	if (surviving.length === 0) return null;
	const joined = surviving.map((s) => s.replace(/^\n+/, "")).join("\n\n");
	return `\n\n${joined}`;
}

/**
 * Append a text suffix to the last text content item in an array, or push a
 * new text item if none exist. Non-text content (images etc.) is preserved
 * in place — the suffix MUST land in a text block, never inside an image.
 *
 * If the array is empty or contains only non-text items, a new text item
 * holding the suffix (with leading whitespace trimmed) is pushed at the end.
 *
 * Returns a new array; the input is not mutated.
 */
export function appendTextToContent(
	content: (TextContent | ImageContent)[],
	suffix: string,
): (TextContent | ImageContent)[] {
	const out = [...content];
	for (let i = out.length - 1; i >= 0; i--) {
		const item = out[i];
		if (item.type === "text") {
			out[i] = { ...item, text: item.text + suffix };
			return out;
		}
	}
	out.push({ type: "text", text: suffix.trimStart() });
	return out;
}

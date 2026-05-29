import { test } from "node:test";
import assert from "node:assert/strict";

import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

import {
	composeToolResultSuffix,
	appendTextToContent,
} from "../extensions/kiln-lite/lib/formatting.ts";

// --- composeToolResultSuffix ---

test("composeToolResultSuffix returns null when all blocks empty", () => {
	assert.equal(composeToolResultSuffix([]), null);
	assert.equal(composeToolResultSuffix([""]), null);
	assert.equal(composeToolResultSuffix(["", ""]), null);
});

test("composeToolResultSuffix joins surviving blocks with double newline + prefix", () => {
	assert.equal(composeToolResultSuffix(["[state]"]), "\n\n[state]");
	assert.equal(composeToolResultSuffix(["[state]", "[inbox]"]), "\n\n[state]\n\n[inbox]");
});

test("composeToolResultSuffix strips leading newlines on each block (idempotent)", () => {
	// Mimics the real-world case where inboxSuffix already starts with "\n\n".
	assert.equal(composeToolResultSuffix(["\n\n[inbox]"]), "\n\n[inbox]");
	assert.equal(
		composeToolResultSuffix(["[state]", "\n\n[inbox]"]),
		"\n\n[state]\n\n[inbox]",
	);
});

test("composeToolResultSuffix drops empty blocks but keeps non-empty", () => {
	assert.equal(composeToolResultSuffix(["", "[a]", "", "[b]"]), "\n\n[a]\n\n[b]");
	assert.equal(composeToolResultSuffix(["[a]", ""]), "\n\n[a]");
});

test("composeToolResultSuffix preserves block order", () => {
	const result = composeToolResultSuffix(["first", "second", "third"]);
	assert.equal(result, "\n\nfirst\n\nsecond\n\nthird");
});

// --- appendTextToContent ---

test("appendTextToContent appends to last text item", () => {
	const input: TextContent[] = [{ type: "text", text: "original" }];
	const out = appendTextToContent(input, "\n\nsuffix");
	assert.deepEqual(out, [{ type: "text", text: "original\n\nsuffix" }]);
	// Input not mutated
	assert.deepEqual(input, [{ type: "text", text: "original" }]);
});

test("appendTextToContent walks backwards to find the LAST text item", () => {
	const input: (TextContent | ImageContent)[] = [
		{ type: "text", text: "first" },
		{ type: "text", text: "second" },
	];
	const out = appendTextToContent(input, "!");
	assert.deepEqual(out, [
		{ type: "text", text: "first" },
		{ type: "text", text: "second!" },
	]);
});

test("appendTextToContent preserves non-text items in-place", () => {
	const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
	const input: (TextContent | ImageContent)[] = [
		{ type: "text", text: "caption" },
		image,
	];
	const out = appendTextToContent(input, "\n\nsuffix");
	// Suffix went into text item, not the image
	assert.deepEqual(out[0], { type: "text", text: "caption\n\nsuffix" });
	assert.deepEqual(out[1], image);
});

test("appendTextToContent finds text BEFORE a trailing image", () => {
	const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
	const input: (TextContent | ImageContent)[] = [
		{ type: "text", text: "before" },
		image,
	];
	const out = appendTextToContent(input, "!");
	assert.equal((out[0] as TextContent).text, "before!");
	assert.equal(out[1], image);
});

test("appendTextToContent pushes new text item when no text exists, trimming leading whitespace", () => {
	const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
	const input: (TextContent | ImageContent)[] = [image];
	const out = appendTextToContent(input, "\n\nsuffix");
	assert.equal(out.length, 2);
	assert.deepEqual(out[0], image);
	// Suffix's leading whitespace gets trimmed since there's no prior text to "follow"
	assert.deepEqual(out[1], { type: "text", text: "suffix" });
});

test("appendTextToContent pushes text item for empty input", () => {
	const out = appendTextToContent([], "\n\nsuffix");
	assert.deepEqual(out, [{ type: "text", text: "suffix" }]);
});

test("appendTextToContent returns a NEW array (no in-place mutation)", () => {
	const input: TextContent[] = [{ type: "text", text: "x" }];
	const out = appendTextToContent(input, "y");
	assert.notEqual(out, input, "should return a fresh array");
});

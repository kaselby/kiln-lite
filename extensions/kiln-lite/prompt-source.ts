/**
 * Shared parsing and resolution for prompts supplied inline or by file path.
 *
 * Configuration keeps the source rather than eagerly reading files. This lets
 * lifecycle prompts pick up edits made during a running session when the prompt
 * is eventually dispatched.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { PromptSource } from "./types.ts";

/**
 * Parse a raw configuration value as either inline prompt text or `{ path }`.
 * Returns undefined after warning when the value has an invalid shape.
 */
export function parsePromptSource(
	value: unknown,
	label: string,
	warn: (msg: string) => void,
): PromptSource | undefined {
	if (typeof value === "string") return value;

	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const path = (value as Record<string, unknown>).path;
		if (typeof path === "string" && path.trim()) {
			return { path: path.trim() };
		}
	}

	warn(`kiln-lite: ${label} must be inline text or a mapping with a non-empty 'path' — ignoring`);
	return undefined;
}

/**
 * Resolve prompt text. Inline text is returned verbatim; file paths are read
 * at call time and resolved relative to the agent home unless absolute.
 */
export function resolvePromptSource(
	source: PromptSource,
	agentHome: string,
	label: string,
	warn: (msg: string) => void,
): string | null {
	if (typeof source === "string") return source;

	const path = isAbsolute(source.path) ? source.path : join(agentHome, source.path);
	if (!existsSync(path)) {
		warn(`kiln-lite: ${label} file not found: ${path}`);
		return null;
	}
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		warn(`kiln-lite: failed to read ${label} file ${path}: ${(err as Error).message}`);
		return null;
	}
}

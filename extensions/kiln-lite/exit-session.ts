/**
 * Exit-session pure logic — types and helpers with no pi dependency.
 *
 * The pi-dependent tool wrapper lives in exit-session-tool.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ContinuationConfig {
	handoff: string;
	template?: string;
}

/**
 * Resolve a handoff value to text. If it looks like a file path (absolute or
 * ~/...) and the file exists, read its contents. Otherwise return as-is.
 */
export function resolveHandoff(raw: string): string {
	let path = raw.trim();
	if (path.startsWith("~/")) {
		path = join(homedir(), path.slice(2));
	}
	if (path.startsWith("/") && existsSync(path)) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Read failed — fall through to raw text
		}
	}
	return raw;
}

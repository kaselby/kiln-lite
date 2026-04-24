/**
 * Shell tool discovery.
 *
 * Scans $AGENT_HOME/<tools_dir>/ at session_start, parses the YAML header
 * (fenced between `# ---` lines), and renders a compact tool-index block
 * that gets injected into the system prompt. The scripts themselves are
 * just executables — the agent invokes them through Pi's built-in `bash`
 * tool, which inherits $PATH (env.ts prepends the tools dir).
 *
 * Tool header format:
 *   #!/usr/bin/env bash
 *   # ---
 *   # name: mytool
 *   # description: One-line description
 *   # usage: mytool <args>        # or `arguments:` (legacy alias)
 *   # ---
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export interface ToolHeader {
	/** Tool name — registered as pi tool with this name. Falls back to filename. */
	name: string;
	/** One-line description for LLM tool selection. */
	description: string;
	/** Usage string for the tool index block in the system prompt. */
	usage?: string;
	/** Full path to the executable on disk. */
	path: string;
}

/**
 * Scan one or more tool directories for executables with YAML headers.
 * Returns headers for successfully-parsed tools.
 * Non-executables and files without headers are skipped silently.
 * Malformed headers are surfaced via `warn`.
 *
 * Dirs are scanned in order — if two tools have the same `name`, the earlier
 * one wins. In practice kiln-lite's extension only passes a single dir
 * ($AGENT_HOME/<tools_dir>); bundled tools are copied there by bootstrap.sh.
 */
export function discoverTools(toolsDirs: string[], warn: (msg: string) => void): ToolHeader[] {
	const seen = new Set<string>();
	const headers: ToolHeader[] = [];

	for (const dir of toolsDirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			// Dir doesn't exist — fine, skip.
			continue;
		}
		for (const name of entries) {
			const path = join(dir, name);
			let st;
			try {
				st = statSync(path);
			} catch {
				continue;
			}
			if (!st.isFile()) continue;
			// Must be executable by owner (mode & 0o100).
			if ((st.mode & 0o100) === 0) continue;

			const header = parseHeader(path, name, warn);
			if (!header) continue;
			if (seen.has(header.name)) continue; // earlier dir wins
			seen.add(header.name);
			headers.push(header);
		}
	}
	// Alphabetical — stable order in the tool index.
	headers.sort((a, b) => a.name.localeCompare(b.name));
	return headers;
}

/**
 * Extract the YAML header block from a script file.
 * Header is delimited by `# ---` lines; each body line is `# key: value`.
 * Returns null if no header or header is malformed beyond repair.
 */
function parseHeader(path: string, filename: string, warn: (msg: string) => void): ToolHeader | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		warn(`kiln-lite: failed to read tool ${path}: ${(err as Error).message}`);
		return null;
	}

	const lines = text.split("\n");
	let startIdx = -1;
	let endIdx = -1;
	for (let i = 0; i < Math.min(lines.length, 30); i++) {
		const trimmed = lines[i].trim();
		if (trimmed === "# ---") {
			if (startIdx === -1) {
				startIdx = i;
			} else {
				endIdx = i;
				break;
			}
		}
	}
	if (startIdx === -1 || endIdx === -1) return null;

	const body = lines
		.slice(startIdx + 1, endIdx)
		.map((l) => (l.startsWith("# ") ? l.slice(2) : l.startsWith("#") ? l.slice(1) : l))
		.join("\n");

	let parsed: unknown;
	try {
		parsed = yaml.load(body);
	} catch (err) {
		warn(`kiln-lite: tool ${filename} has malformed YAML header: ${(err as Error).message}`);
		return null;
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		warn(`kiln-lite: tool ${filename} header is not a mapping`);
		return null;
	}

	const obj = parsed as Record<string, unknown>;
	const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : filename;
	const description = typeof obj.description === "string" ? obj.description.trim() : "";
	if (!description) {
		warn(`kiln-lite: tool ${filename} missing 'description' — skipping`);
		return null;
	}
	// Accept either `usage` or `arguments` (legacy/common alternative) as the usage hint.
	const usageRaw = typeof obj.usage === "string" ? obj.usage : typeof obj.arguments === "string" ? obj.arguments : undefined;
	const usage = usageRaw ? usageRaw.trim() : undefined;

	return { name, description, usage, path };
}

/**
 * Render the tool index block for injection into the system prompt.
 * Format: `- **name** — description` per line. `usage` appended inline if present.
 *
 * The agent invokes these via Pi's built-in `bash` tool (e.g. `bash -c "seek foo"`).
 * env.ts prepends $AGENT_HOME/<tools_dir> to PATH so bare names resolve.
 */
export function renderToolIndex(headers: ToolHeader[]): string {
	if (!headers.length) return "";
	const lines = headers.map((h) => {
		const usageSuffix = h.usage ? ` \`${h.usage}\`` : "";
		return `- **${h.name}**${usageSuffix} — ${h.description}`;
	});
	return lines.join("\n");
}

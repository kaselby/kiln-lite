/**
 * Shell tool discovery + registration.
 *
 * Scans $AGENT_HOME/<tools_dir>/ at session_start, parses the YAML header
 * (fenced between `# ---` lines), and registers each as a Pi tool with a
 * single `args: string` parameter (spec §Shell Tools, v1 model).
 *
 * Tool header format:
 *   #!/usr/bin/env bash
 *   # ---
 *   # name: mytool
 *   # description: One-line description
 *   # usage: mytool <args>
 *   # ---
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import yaml from "js-yaml";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
 * one wins. Callers should put user-customizable dirs first (e.g. $AGENT_HOME
 * before the bundled package tools), so users can override bundled tools.
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
	const usage = typeof obj.usage === "string" ? obj.usage.trim() : undefined;

	return { name, description, usage, path };
}

/**
 * Render the tool index block for injection into the system prompt.
 * Format: `- **name** — description` per line. `usage` appended inline if present.
 */
export function renderToolIndex(headers: ToolHeader[]): string {
	if (!headers.length) return "";
	const lines = headers.map((h) => {
		const usageSuffix = h.usage ? ` \`${h.usage}\`` : "";
		return `- **${h.name}**${usageSuffix} — ${h.description}`;
	});
	return lines.join("\n");
}

/**
 * Register each discovered tool with Pi.
 * Every tool takes a single `args: string` parameter (v1 uniform model).
 */
export function registerShellTools(
	pi: ExtensionAPI,
	headers: ToolHeader[],
	env: Record<string, string>,
): void {
	for (const h of headers) {
		pi.registerTool({
			name: h.name,
			label: h.name,
			description: h.description,
			parameters: Type.Object({
				args: Type.String({ description: "Raw argument string passed to the script" }),
			}),
			async execute(_toolCallId, params, signal) {
				const text = await runScript(h.path, params.args, env, signal);
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			},
		});
	}
}

/**
 * Spawn the script with `args` as a single argv string, passing through env.
 * Collects stdout+stderr and returns them concatenated. Rejects on non-zero exit.
 */
function runScript(
	scriptPath: string,
	args: string,
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// Use shell mode: the script is invoked like `<path> <args>` via /bin/sh -c,
		// so the user's `args` string gets normal shell word-splitting and quoting.
		// The script itself is responsible for handling its argv.
		const cmd = `${shellQuote(scriptPath)} ${args}`;
		const child = spawn(cmd, {
			shell: true,
			env: { ...process.env, ...env },
			signal,
		});

		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (d: Buffer) => out.push(d));
		child.stderr?.on("data", (d: Buffer) => err.push(d));

		child.on("error", (e) => reject(e));
		child.on("close", (code) => {
			const stdout = Buffer.concat(out).toString("utf8");
			const stderr = Buffer.concat(err).toString("utf8");
			if (code === 0) {
				resolve(stderr.trim() ? `${stdout}\n[stderr]\n${stderr}` : stdout);
			} else {
				reject(new Error(`${scriptPath} exited ${code}\n${stderr || stdout}`));
			}
		});
	});
}

/** Minimal shell-quoting for the script path (spaces, etc). */
function shellQuote(s: string): string {
	if (/^[\w@%+=:,.\/-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

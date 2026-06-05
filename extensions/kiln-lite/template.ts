/**
 * Template loading and application.
 *
 * A template is a partial agent.yml override at $AGENT_HOME/templates/<name>.yml.
 * Selected with KL_TEMPLATE env var (set by `kl --template <name>`).
 *
 * Precedence: agent.yml < template < CLI flags
 *
 * All top-level fields override. Exception: context_injection obeys a
 * `context_injection_mode` field in the template:
 *   - "replace" (default): template's list replaces agent.yml's entirely.
 *   - "append": template's entries are added after agent.yml's.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import type { AgentConfig, ContextInjectionEntry } from "./types.ts";

/**
 * Resolve template file path. Tries <name>.yml, then bare <name>.
 * Returns null if neither exists.
 */
function resolveTemplatePath(agentHome: string, name: string): string | null {
	const withExt = join(agentHome, "templates", `${name}.yml`);
	if (existsSync(withExt)) return withExt;
	const bare = join(agentHome, "templates", name);
	if (existsSync(bare)) return bare;
	return null;
}

/**
 * Load a template by name and apply it onto an existing config.
 * Mutates `config` in place. Warns on non-fatal issues.
 *
 * @returns The template name if successfully applied, null otherwise.
 */
export function applyTemplate(
	config: AgentConfig,
	agentHome: string,
	templateName: string,
	warn: (msg: string) => void,
): string | null {
	const filePath = resolveTemplatePath(agentHome, templateName);
	if (!filePath) {
		warn(
			`kiln-lite: template '${templateName}' not found (looked in ${join(agentHome, "templates/")})`,
		);
		return null;
	}

	let raw: unknown;
	try {
		const contents = readFileSync(filePath, "utf8");
		raw = yaml.load(contents);
	} catch (err) {
		warn(`kiln-lite: failed to parse template '${templateName}': ${(err as Error).message}`);
		return null;
	}

	if (raw === null || raw === undefined) {
		warn(`kiln-lite: template '${templateName}' is empty — no overrides applied`);
		return null;
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warn(`kiln-lite: template '${templateName}' must be a YAML mapping`);
		return null;
	}

	const obj = raw as Record<string, unknown>;

	// Determine context_injection merge mode.
	let ciMode: "replace" | "append" = "replace";
	if (typeof obj.context_injection_mode === "string") {
		const mode = obj.context_injection_mode.trim().toLowerCase();
		if (mode === "append" || mode === "replace") {
			ciMode = mode;
		} else {
			warn(
				`kiln-lite: template '${templateName}' has invalid context_injection_mode '${obj.context_injection_mode}' — using 'replace'`,
			);
		}
	}

	// Apply scalar overrides.
	if (typeof obj.name === "string" && obj.name.trim()) {
		config.name = obj.name.trim();
	}
	if (typeof obj.system_prompt === "string" && obj.system_prompt.trim()) {
		config.system_prompt = obj.system_prompt.trim();
	}
	if (typeof obj.cleanup === "string") {
		config.cleanup = obj.cleanup;
	}
	if (typeof obj.tools_dir === "string" && obj.tools_dir.trim()) {
		config.tools_dir = obj.tools_dir.trim();
	}
	if (typeof obj.inbox_dir === "string" && obj.inbox_dir.trim()) {
		config.inbox_dir = obj.inbox_dir.trim();
	}
	if (typeof obj.sessions_dir === "string" && obj.sessions_dir.trim()) {
		config.sessions_dir = obj.sessions_dir.trim();
	}
	if (typeof obj.session_state_interval === "number" && Number.isFinite(obj.session_state_interval)) {
		const n = Math.floor(obj.session_state_interval);
		if (n >= 0) config.session_state_interval = n;
	}

	// Apply startup override.
	if (Array.isArray(obj.startup)) {
		const cmds: string[] = [];
		for (const c of obj.startup) {
			if (typeof c === "string") cmds.push(c);
		}
		config.startup = cmds;
	}

	// Apply context_injection (respecting mode).
	if (Array.isArray(obj.context_injection)) {
		const entries: ContextInjectionEntry[] = [];
		for (const [i, e] of obj.context_injection.entries()) {
			if (e === null || typeof e !== "object" || Array.isArray(e)) {
				warn(`kiln-lite: template '${templateName}' context_injection[${i}] is not a mapping — skipping`);
				continue;
			}
			const entry = e as Record<string, unknown>;
			const hasPath = typeof entry.path === "string" && (entry.path as string).trim() !== "";
			const hasCommand = typeof entry.command === "string" && (entry.command as string).trim() !== "";
			if (!hasPath && !hasCommand) {
				warn(`kiln-lite: template '${templateName}' context_injection[${i}] needs 'path' or 'command' — skipping`);
				continue;
			}
			if (hasPath && hasCommand) {
				warn(`kiln-lite: template '${templateName}' context_injection[${i}] has both 'path' and 'command' — skipping`);
				continue;
			}
			if (typeof entry.label !== "string" || !entry.label.trim()) {
				warn(`kiln-lite: template '${templateName}' context_injection[${i}] missing 'label' — skipping`);
				continue;
			}
			const parsed: ContextInjectionEntry = { label: entry.label.trim() };
			if (hasPath) parsed.path = (entry.path as string).trim();
			if (hasCommand) parsed.command = (entry.command as string).trim();
			if (typeof entry.dynamic === "boolean") parsed.dynamic = entry.dynamic;
			entries.push(parsed);
		}

		if (ciMode === "append") {
			config.context_injection = [...config.context_injection, ...entries];
		} else {
			config.context_injection = entries;
		}
	}

	return templateName;
}


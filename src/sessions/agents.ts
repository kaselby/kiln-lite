/**
 * Installed agents: one home per dir under $KL_AGENTS_DIR (default
 * <kl root>/agents), counted only if it has an agent.yml. Same rule as bin/kl's
 * resolve_agent_home / list_agent_homes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import yaml from "js-yaml";

import { readYamlMapping } from "../../extensions/kiln-lite/config.ts";
import { klRoot } from "./paths.ts";

export interface AgentInfo {
	name: string;
	home: string;
	/** First line of agent.yml `description`, or "". */
	description: string;
}

export function agentsDir(): string {
	const env = process.env.KL_AGENTS_DIR?.trim();
	return resolve(env || join(klRoot(), "agents"));
}

const AGENT_DIR_NAME = /^[a-z][a-z0-9_]*$/;

/** The agent `kl run` and the subagent tool use when none is named. */
export const DEFAULT_AGENT = "worker";

/**
 * Default agent name: $KL_DEFAULT_AGENT, else `default_agent:` in
 * <kl root>/config.yml, else "worker". Only the name: the agent may not be
 * installed. Throws on a name outside the agent-name grammar.
 */
export function defaultAgentName(root = klRoot()): string {
	const fromEnv = process.env.KL_DEFAULT_AGENT?.trim();
	const fromConfig = readYamlMapping(join(root, "config.yml"), "kl config.yml", () => {})?.default_agent;
	const [name, source] = fromEnv
		? [fromEnv, "KL_DEFAULT_AGENT"]
		: fromConfig !== undefined && fromConfig !== null
			? [String(fromConfig).trim(), "config.yml default_agent"]
			: [DEFAULT_AGENT, ""];
	if (!AGENT_DIR_NAME.test(name)) {
		throw new Error(`${source} '${name}' is not an agent name (lowercase letter, then [a-z0-9_])`);
	}
	return name;
}

/** Home of the installed agent `name`, or null. */
export function agentHome(name: string): string | null {
	if (!AGENT_DIR_NAME.test(name)) return null;
	const home = join(agentsDir(), name);
	return existsSync(join(home, "agent.yml")) ? home : null;
}

/** The subagent tool's pick: `name`, else the default agent; must be installed. Throws otherwise. */
export function resolveAgent(name?: string): { name: string; home: string } {
	const picked = name ?? defaultAgentName();
	const home = agentHome(picked);
	if (home) return { name: picked, home };
	const installed = listAgents().map((a) => a.name).join(", ") || "(none)";
	const which = name === undefined ? "default agent" : "installed agent";
	throw new Error(`no ${which} '${picked}'. Installed: ${installed}`);
}

export function listAgents(): AgentInfo[] {
	const dir = agentsDir();
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return [];
	}
	const out: AgentInfo[] = [];
	for (const name of names) {
		const home = join(dir, name);
		try {
			if (!statSync(home).isDirectory()) continue;
		} catch {
			continue;
		}
		const yml = join(home, "agent.yml");
		if (!existsSync(yml)) continue;
		let description = "";
		try {
			const raw = yaml.load(readFileSync(yml, "utf8")) as Record<string, unknown> | null;
			if (raw && typeof raw.description === "string") description = raw.description.trim().split("\n")[0] ?? "";
		} catch {
			// unreadable agent.yml: list it without a description
		}
		out.push({ name, home, description });
	}
	return out;
}

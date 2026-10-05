/**
 * Installed agents: one home per dir under $KL_AGENTS_DIR (default
 * ~/.kl/agents), counted only if it has an agent.yml. Same rule as bin/kl's
 * resolve_agent_home / list_agent_homes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import yaml from "js-yaml";

export interface AgentInfo {
	name: string;
	home: string;
	/** First line of agent.yml `description`, or "". */
	description: string;
}

export function agentsDir(): string {
	const env = process.env.KL_AGENTS_DIR?.trim();
	return resolve(env || join(homedir(), ".kl", "agents"));
}

const AGENT_DIR_NAME = /^[a-z][a-z0-9_]*$/;

/** Home of the installed agent `name`, or null. */
export function agentHome(name: string): string | null {
	if (!AGENT_DIR_NAME.test(name)) return null;
	const home = join(agentsDir(), name);
	return existsSync(join(home, "agent.yml")) ? home : null;
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

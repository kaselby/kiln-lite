/** Pure text helpers for subagent.ts (no Pi imports, so CJS tests can load them). */

import type { AgentInfo } from "../../src/sessions/agents.ts";

const AGENT_LIST_CAP = 15;

/** Tool description; the installed-agent list is read once, at load. Pure apart from `agents`. */
export function buildDescription(agents: AgentInfo[]): string {
	const lines = [
		"Launch a subagent: a new session of an installed kl agent, running on its own in tmux, as your child.",
		"It returns the child's session name at once. The child reports back with the message tool; its message arrives in your inbox like any other.",
		"wait=true blocks until a message from the child arrives, the child goes idle, or it exits (the user can interrupt).",
		"Children are stopped when your session ends; their transcripts stay resumable.",
		"",
	];
	if (agents.length === 0) {
		lines.push("No installed agents found under $KL_AGENTS_DIR (default <kl root>/agents).");
	} else {
		lines.push("Installed agents:");
		for (const a of agents.slice(0, AGENT_LIST_CAP)) lines.push(`- ${a.name}${a.description ? `: ${a.description}` : ""}`);
		if (agents.length > AGENT_LIST_CAP) lines.push(`- ... ${agents.length - AGENT_LIST_CAP} more (\`kl agents\`)`);
	}
	return lines.join("\n");
}

/** What the child sees first. Pure. */
export function childPrompt(parentName: string, parentUuid: string, prompt: string): string {
	return (
		`You were launched as a subagent by ${parentName} (session ${parentUuid}). ` +
		`Send your results with the message tool, to: "${parentName}".\n\n${prompt}`
	);
}

/** `from:` value of an inbox message's frontmatter, or null. Pure. */
export function messageFrom(text: string): string | null {
	if (!text.startsWith("---")) return null;
	const end = text.indexOf("\n---", 3);
	const head = end === -1 ? text : text.slice(0, end);
	const m = head.match(/^from:\s*(.+?)\s*$/m);
	return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

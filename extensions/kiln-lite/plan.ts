/**
 * Plan persistence, formatting, and reminder logic.
 *
 * Pure module — no pi SDK dependencies. The pi tool wrapper lives in
 * plan-tool.ts and composes these building blocks.
 *
 * Plan shape: `{ goal, tasks: [{ description, status }], updated_at }`.
 * Stored at `$AGENT_HOME/state/sessions/<agent-id>/plan.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- Types ---

export interface PlanTask {
	description: string;
	status: "pending" | "in_progress" | "done";
}

export interface PlanData {
	goal: string;
	/** Project this work belongs to, if any. */
	project?: string;
	/** Name or path of the worktree being worked in, if any. */
	worktree?: string;
	tasks: PlanTask[];
	updated_at: string;
}

// --- Disk I/O ---

export function planPath(agentHome: string, agentId: string): string {
	return join(agentHome, "state", "sessions", agentId, "plan.json");
}

export function readPlan(agentHome: string, agentId: string): PlanData | null {
	const path = planPath(agentHome, agentId);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.goal !== "string") return null;
		if (parsed.project !== undefined && typeof parsed.project !== "string") return null;
		if (parsed.worktree !== undefined && typeof parsed.worktree !== "string") return null;
		if (!Array.isArray(parsed.tasks)) return null;
		return parsed as PlanData;
	} catch {
		return null;
	}
}

export function writePlan(agentHome: string, agentId: string, plan: PlanData): void {
	const dir = join(agentHome, "state", "sessions", agentId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(planPath(agentHome, agentId), `${JSON.stringify(plan, null, 2)}\n`);
}

/**
 * Resolve a sticky plan field (project / worktree). These are slow-changing
 * ambient context, not part of the task-list churn, so a plan update that
 * omits them keeps the prior value. An explicit empty string clears it.
 */
export function resolveSticky(
	param: string | undefined,
	prior: string | undefined,
): string | undefined {
	if (param === undefined) return prior;
	return param || undefined;
}

// --- Summary formatting ---

export function formatPlanSummary(plan: PlanData): string {
	const counts = { done: 0, in_progress: 0, pending: 0 };
	for (const t of plan.tasks) counts[t.status]++;
	const total = plan.tasks.length;

	const parts = [`${counts.done}/${total} done`];
	if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);

	const context = [plan.project, plan.worktree].filter(Boolean).join(" @ ");
	const head = context ? `${plan.goal} (${context})` : plan.goal;
	let summary = `[Plan] ${head} | ${parts.join(", ")}`;

	const inProgress = plan.tasks.filter((t) => t.status === "in_progress");
	if (inProgress.length > 0) {
		summary += "\nIn progress:";
		for (const t of inProgress) summary += `\n- ${t.description}`;
	}

	return summary;
}

// --- Reminder ---

export interface PlanReminderDeps {
	getAgentHome: () => string | null;
	getAgentId: () => string | null;
}

export interface PlanReminder {
	/** Call on every tool_result. Returns reminder suffix or empty string. */
	maybeSuffix(): string;
	/** Reset the call counter — call when the plan is updated. */
	resetCounter(): void;
}

export function createPlanReminder(deps: PlanReminderDeps, interval = 15): PlanReminder {
	let callsSincePlanWrite = 0;

	return {
		maybeSuffix(): string {
			callsSincePlanWrite++;
			if (interval <= 0) return "";
			if (callsSincePlanWrite % interval !== 0) return "";

			const agentHome = deps.getAgentHome();
			const agentId = deps.getAgentId();
			if (!agentHome || !agentId) return "";

			const plan = readPlan(agentHome, agentId);
			if (!plan) return "";
			if (!plan.tasks.some((t) => t.status === "in_progress")) return "";

			return formatPlanSummary(plan);
		},
		resetCounter(): void {
			callsSincePlanWrite = 0;
		},
	};
}

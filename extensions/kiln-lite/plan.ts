/**
 * Plan persistence, formatting, and reminder logic.
 *
 * Pure module — no pi SDK dependencies. The pi tool wrapper lives in
 * plan-tool.ts and composes these building blocks.
 *
 * Plan shape: `{ goal, tasks: [{ description, status }], updated_at }`.
 * Stored at `<kl root>/run/<session uuid>/plan.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { planPath } from "../../src/sessions/paths.ts";

export { planPath };

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

export function readPlan(klRoot: string, sessionUuid: string): PlanData | null {
	const path = planPath(sessionUuid, klRoot);
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

export function writePlan(klRoot: string, sessionUuid: string, plan: PlanData): void {
	mkdirSync(dirname(planPath(sessionUuid, klRoot)), { recursive: true });
	writeFileSync(planPath(sessionUuid, klRoot), `${JSON.stringify(plan, null, 2)}\n`);
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
	getKlRoot: () => string | null;
	getSessionUuid: () => string | null;
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

			const klRoot = deps.getKlRoot();
			const sessionUuid = deps.getSessionUuid();
			if (!klRoot || !sessionUuid) return "";

			const plan = readPlan(klRoot, sessionUuid);
			if (!plan) return "";
			if (!plan.tasks.some((t) => t.status === "in_progress")) return "";

			return formatPlanSummary(plan);
		},
		resetCounter(): void {
			callsSincePlanWrite = 0;
		},
	};
}

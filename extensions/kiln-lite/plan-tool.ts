/**
 * Plan tool — pi integration wrapper.
 *
 * Registers the `plan` tool via pi's extension API and wires it to the
 * pure persistence/reminder logic in plan.ts. The tool lets agents
 * externalize a task breakdown; the reminder periodically nudges when
 * in-progress tasks haven't been updated.
 */

import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import {
	writePlan,
	readPlan,
	resolveSticky,
	createPlanReminder,
	type PlanData,
	type PlanTask,
	type PlanReminderDeps,
} from "./plan.ts";

// Re-export for consumers that want I/O or types without importing plan.ts directly.
export { type PlanData, type PlanTask, readPlan, planPath } from "./plan.ts";

// --- Schema ---

const PlanParams = Type.Object({
	goal: Type.String({ description: "Brief description of what you're working on." }),
	project: Type.Optional(
		Type.String({ description: "What project you are working on. Sticky: omit to keep the prior value, pass \"\" to clear." }),
	),
	worktree: Type.Optional(
		Type.String({ description: "Name or path of the worktree you're working in. Sticky: omit to keep the prior value, pass \"\" to clear." }),
	),
	tasks: Type.Array(
		Type.Object({
			description: Type.String({ description: "What this task involves." }),
			status: Type.Union(
				[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")],
				{ description: "Task status." },
			),
		}),
		{ description: "Ordered list of tasks. Each call replaces the entire list — include all tasks, not just changes." },
	),
});

// --- Tool builder ---

export interface PlanToolDeps extends PlanReminderDeps {}

export interface PlanToolKit {
	/** Tool definition — pass to pi.registerTool(). */
	tool: ReturnType<typeof defineTool>;
	/**
	 * Call from the tool_result handler on every tool result. Returns a
	 * reminder suffix when the plan looks stale (in-progress tasks that
	 * haven't been updated in `interval` tool calls), empty string otherwise.
	 */
	maybeSuffix(): string;
}

const PLAN_DESCRIPTION =
	"Create or update your working plan. Externalize your task breakdown before starting complex work. " +
	"Each call replaces the entire plan — include all tasks, not just changes.\n\n" +
	"Call this tool to:\n" +
	"- Break down a complex task before starting\n" +
	"- Mark tasks as done as you complete them\n" +
	"- Adjust the plan when requirements change";

const PLAN_PROMPT_SNIPPET =
	"- **plan** — Create or update your working plan. " +
	"Break down complex tasks, mark progress, adjust as requirements change. " +
	"Each call replaces the entire plan.";

export function buildPlanToolKit(deps: PlanToolDeps, interval = 15): PlanToolKit {
	const reminder = createPlanReminder(deps, interval);

	const tool = defineTool({
		name: "plan",
		label: "Plan",
		description: PLAN_DESCRIPTION,
		promptSnippet: PLAN_PROMPT_SNIPPET,
		parameters: PlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<unknown>> {
			const agentHome = deps.getAgentHome();
			const agentId = deps.getAgentId();
			if (!agentHome || !agentId) {
				throw new Error("Session not initialized — plan tool called before session_start.");
			}

			// project/worktree are sticky ambient context, not part of the
			// task-list churn: omitting them keeps the prior value; pass an
			// empty string to clear.
			const existing = readPlan(agentHome, agentId);
			const project = resolveSticky(params.project, existing?.project);
			const worktree = resolveSticky(params.worktree, existing?.worktree);

			const plan: PlanData = {
				goal: params.goal,
				...(project ? { project } : {}),
				...(worktree ? { worktree } : {}),
				tasks: params.tasks as PlanTask[],
				updated_at: new Date().toISOString(),
			};

			writePlan(agentHome, agentId, plan);
			reminder.resetCounter();

			const counts = { done: 0, in_progress: 0, pending: 0 };
			for (const t of plan.tasks) counts[t.status]++;

			return {
				content: [
					{
						type: "text",
						text: `Plan updated. ${counts.done}/${plan.tasks.length} done, ${counts.in_progress} in progress, ${counts.pending} pending.`,
					},
				],
				details: { goal: plan.goal, taskCount: plan.tasks.length },
			};
		},
	});

	return { tool, maybeSuffix: () => reminder.maybeSuffix() };
}

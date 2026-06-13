import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	planPath,
	readPlan,
	writePlan,
	formatPlanSummary,
	createPlanReminder,
	type PlanData,
} from "../extensions/kiln-lite/plan.ts";

function makeTmpHome(): string {
	const dir = join(tmpdir(), `plan-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// --- planPath ---

test("planPath builds expected path", () => {
	assert.equal(
		planPath("/home/agent", "agent-bright-fox"),
		join("/home/agent", "state", "sessions", "agent-bright-fox", "plan.json"),
	);
});

// --- readPlan / writePlan ---

test("readPlan returns null when no plan exists", () => {
	const home = makeTmpHome();
	assert.equal(readPlan(home, "agent-test-one"), null);
	rmSync(home, { recursive: true });
});

test("writePlan persists and readPlan recovers it", () => {
	const home = makeTmpHome();
	const plan: PlanData = {
		goal: "Ship the feature",
		tasks: [
			{ description: "Write code", status: "done" },
			{ description: "Write tests", status: "in_progress" },
			{ description: "Review", status: "pending" },
		],
		updated_at: "2026-06-13T12:00:00.000Z",
	};
	writePlan(home, "agent-test-two", plan);

	assert.ok(existsSync(planPath(home, "agent-test-two")));

	const recovered = readPlan(home, "agent-test-two");
	assert.deepEqual(recovered, plan);

	rmSync(home, { recursive: true });
});

test("writePlan creates session directory if absent", () => {
	const home = makeTmpHome();
	const id = "agent-mkdir-test";
	const dir = join(home, "state", "sessions", id);
	assert.ok(!existsSync(dir));

	writePlan(home, id, {
		goal: "test",
		tasks: [],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	assert.ok(existsSync(dir));
	assert.ok(existsSync(planPath(home, id)));

	rmSync(home, { recursive: true });
});

test("readPlan returns null on malformed JSON", () => {
	const home = makeTmpHome();
	const id = "agent-bad-json";
	const dir = join(home, "state", "sessions", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "plan.json"), "not json{{{");

	assert.equal(readPlan(home, id), null);
	rmSync(home, { recursive: true });
});

test("readPlan returns null on valid JSON with wrong shape", () => {
	const home = makeTmpHome();
	const id = "agent-wrong-shape";
	const dir = join(home, "state", "sessions", id);
	mkdirSync(dir, { recursive: true });

	// Missing tasks array
	writeFileSync(join(dir, "plan.json"), JSON.stringify({ goal: "hi" }));
	assert.equal(readPlan(home, id), null);

	// Missing goal
	writeFileSync(join(dir, "plan.json"), JSON.stringify({ tasks: [] }));
	assert.equal(readPlan(home, id), null);

	// tasks is not an array
	writeFileSync(join(dir, "plan.json"), JSON.stringify({ goal: "hi", tasks: "nope" }));
	assert.equal(readPlan(home, id), null);

	// Primitive value
	writeFileSync(join(dir, "plan.json"), '"just a string"');
	assert.equal(readPlan(home, id), null);

	rmSync(home, { recursive: true });
});

// --- formatPlanSummary ---

test("formatPlanSummary shows counts and in-progress items", () => {
	const plan: PlanData = {
		goal: "Port plan tool",
		tasks: [
			{ description: "Write code", status: "done" },
			{ description: "Write tests", status: "in_progress" },
			{ description: "Review", status: "pending" },
		],
		updated_at: "2026-06-13T12:00:00.000Z",
	};
	const summary = formatPlanSummary(plan);
	assert.ok(summary.startsWith("[Plan] Port plan tool"));
	assert.ok(summary.includes("1/3 done"));
	assert.ok(summary.includes("1 in progress"));
	assert.ok(summary.includes("1 pending"));
	assert.ok(summary.includes("In progress:"));
	assert.ok(summary.includes("- Write tests"));
});

test("formatPlanSummary omits in-progress section when none exist", () => {
	const plan: PlanData = {
		goal: "Done plan",
		tasks: [{ description: "Task", status: "done" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	};
	const summary = formatPlanSummary(plan);
	assert.ok(!summary.includes("In progress:"));
	assert.ok(summary.includes("1/1 done"));
});

test("formatPlanSummary omits zero-count statuses", () => {
	const plan: PlanData = {
		goal: "All pending",
		tasks: [
			{ description: "A", status: "pending" },
			{ description: "B", status: "pending" },
		],
		updated_at: "2026-06-13T12:00:00.000Z",
	};
	const summary = formatPlanSummary(plan);
	assert.ok(summary.includes("0/2 done"));
	assert.ok(summary.includes("2 pending"));
	assert.ok(!summary.includes("in progress"));
});

test("formatPlanSummary lists multiple in-progress tasks", () => {
	const plan: PlanData = {
		goal: "Multi-track",
		tasks: [
			{ description: "Alpha", status: "in_progress" },
			{ description: "Beta", status: "in_progress" },
			{ description: "Gamma", status: "pending" },
		],
		updated_at: "2026-06-13T12:00:00.000Z",
	};
	const summary = formatPlanSummary(plan);
	assert.ok(summary.includes("2 in progress"));
	assert.ok(summary.includes("- Alpha"));
	assert.ok(summary.includes("- Beta"));
});

// --- createPlanReminder: maybeSuffix ---

test("maybeSuffix fires at interval when plan has in_progress tasks", () => {
	const home = makeTmpHome();
	const agentId = "agent-reminder-test";

	writePlan(home, agentId, {
		goal: "Reminder test",
		tasks: [{ description: "Working", status: "in_progress" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => agentId },
		5,
	);

	// Calls 1-4: no reminder
	for (let i = 0; i < 4; i++) {
		assert.equal(reminder.maybeSuffix(), "", `call ${i + 1} should be empty`);
	}

	// Call 5: reminder fires
	const suffix = reminder.maybeSuffix();
	assert.ok(suffix.includes("[Plan]"), "call 5 should fire reminder");
	assert.ok(suffix.includes("Reminder test"));
	assert.ok(suffix.includes("- Working"));

	// Calls 6-9: no reminder
	for (let i = 0; i < 4; i++) {
		assert.equal(reminder.maybeSuffix(), "", `call ${i + 6} should be empty`);
	}

	// Call 10: reminder fires again
	assert.ok(reminder.maybeSuffix().includes("[Plan]"), "call 10 should fire reminder");

	rmSync(home, { recursive: true });
});

test("maybeSuffix does not fire when plan has no in_progress tasks", () => {
	const home = makeTmpHome();
	const agentId = "agent-no-ip";

	writePlan(home, agentId, {
		goal: "All done",
		tasks: [{ description: "Task", status: "done" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => agentId },
		3,
	);

	for (let i = 0; i < 10; i++) {
		assert.equal(reminder.maybeSuffix(), "", `call ${i + 1} should be empty`);
	}

	rmSync(home, { recursive: true });
});

test("maybeSuffix does not fire when no plan exists", () => {
	const home = makeTmpHome();
	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => "agent-no-plan" },
		3,
	);

	for (let i = 0; i < 10; i++) {
		assert.equal(reminder.maybeSuffix(), "");
	}

	rmSync(home, { recursive: true });
});

test("maybeSuffix returns empty before session_start (null deps)", () => {
	const reminder = createPlanReminder(
		{ getAgentHome: () => null, getAgentId: () => null },
		3,
	);

	for (let i = 0; i < 10; i++) {
		assert.equal(reminder.maybeSuffix(), "");
	}
});

test("resetCounter restarts the cadence", () => {
	const home = makeTmpHome();
	const agentId = "agent-reset-test";

	writePlan(home, agentId, {
		goal: "Reset test",
		tasks: [{ description: "Work", status: "in_progress" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => agentId },
		5,
	);

	// 4 calls, then reset
	for (let i = 0; i < 4; i++) reminder.maybeSuffix();
	reminder.resetCounter();

	// Post-reset: need 5 more calls to trigger
	for (let i = 0; i < 4; i++) {
		assert.equal(reminder.maybeSuffix(), "", `post-reset call ${i + 1} should be empty`);
	}

	// Call 5 since reset: fires
	assert.ok(reminder.maybeSuffix().includes("[Plan]"), "should fire 5 calls after reset");

	rmSync(home, { recursive: true });
});

test("maybeSuffix returns empty when interval is 0 (disabled)", () => {
	const home = makeTmpHome();
	const agentId = "agent-disabled";

	writePlan(home, agentId, {
		goal: "Test",
		tasks: [{ description: "Work", status: "in_progress" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => agentId },
		0,
	);

	for (let i = 0; i < 20; i++) {
		assert.equal(reminder.maybeSuffix(), "");
	}

	rmSync(home, { recursive: true });
});

test("maybeSuffix picks up plan changes between intervals", () => {
	const home = makeTmpHome();
	const agentId = "agent-dynamic";

	// Start with in_progress task
	writePlan(home, agentId, {
		goal: "Dynamic",
		tasks: [{ description: "Alpha", status: "in_progress" }],
		updated_at: "2026-06-13T12:00:00.000Z",
	});

	const reminder = createPlanReminder(
		{ getAgentHome: () => home, getAgentId: () => agentId },
		3,
	);

	// Advance to the check point
	for (let i = 0; i < 2; i++) reminder.maybeSuffix();

	// Change the plan on disk — mark done, no more in_progress
	writePlan(home, agentId, {
		goal: "Dynamic",
		tasks: [{ description: "Alpha", status: "done" }],
		updated_at: "2026-06-13T12:01:00.000Z",
	});

	// Call 3: check fires but plan has no in_progress → no reminder
	assert.equal(reminder.maybeSuffix(), "");

	rmSync(home, { recursive: true });
});

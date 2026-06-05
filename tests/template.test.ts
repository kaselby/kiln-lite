import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyTemplate, expandTemplateVars, buildTemplateVars } from "../extensions/kiln-lite/template.ts";
import type { AgentConfig } from "../extensions/kiln-lite/types.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "kl-template-test-"));
}

function cleanup(home: string) {
	rmSync(home, { recursive: true, force: true });
}

function baseConfig(): AgentConfig {
	return {
		name: "cal",
		context_injection: [
			{ path: "memory/core.md", label: "Core Memory" },
			{ path: "memory/volatile.md", label: "Volatile" },
		],
		startup: ["echo hello"],
		cleanup: "base cleanup prompt",
		tools_dir: "tools",
		inbox_dir: "inbox",
		sessions_dir: "sessions",
		session_state_interval: 15,
	};
}

function writeTemplate(home: string, name: string, content: string) {
	const dir = join(home, "templates");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.yml`), content);
}

test("applyTemplate returns null when template not found", () => {
	const home = makeHome();
	try {
		const config = baseConfig();
		const warnings: string[] = [];
		const result = applyTemplate(config, home, "nonexistent", (m) => warnings.push(m));
		assert.equal(result, null);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /not found/);
	} finally {
		cleanup(home);
	}
});

test("applyTemplate overrides scalar fields", () => {
	const home = makeHome();
	try {
		writeTemplate(home, "worker", `
name: worker-cal
cleanup: "worker cleanup"
session_state_interval: 5
`);
		const config = baseConfig();
		const result = applyTemplate(config, home, "worker", () => {});
		assert.equal(result, "worker");
		assert.equal(config.name, "worker-cal");
		assert.equal(config.cleanup, "worker cleanup");
		assert.equal(config.session_state_interval, 5);
		// Untouched fields stay as base.
		assert.equal(config.tools_dir, "tools");
	} finally {
		cleanup(home);
	}
});

test("applyTemplate replaces context_injection by default", () => {
	const home = makeHome();
	try {
		writeTemplate(home, "minimal", `
context_injection:
  - path: templates/minimal.md
    label: Minimal Role
`);
		const config = baseConfig();
		applyTemplate(config, home, "minimal", () => {});
		assert.equal(config.context_injection.length, 1);
		assert.equal(config.context_injection[0].label, "Minimal Role");
	} finally {
		cleanup(home);
	}
});

test("applyTemplate appends context_injection when mode is append", () => {
	const home = makeHome();
	try {
		writeTemplate(home, "coordinator", `
context_injection_mode: append
context_injection:
  - path: templates/coordinator.md
    label: Coordinator Role
`);
		const config = baseConfig();
		applyTemplate(config, home, "coordinator", () => {});
		assert.equal(config.context_injection.length, 3);
		assert.equal(config.context_injection[0].label, "Core Memory");
		assert.equal(config.context_injection[1].label, "Volatile");
		assert.equal(config.context_injection[2].label, "Coordinator Role");
	} finally {
		cleanup(home);
	}
});

test("applyTemplate with explicit replace mode replaces", () => {
	const home = makeHome();
	try {
		writeTemplate(home, "fresh", `
context_injection_mode: replace
context_injection:
  - path: only-this.md
    label: Only This
`);
		const config = baseConfig();
		applyTemplate(config, home, "fresh", () => {});
		assert.equal(config.context_injection.length, 1);
		assert.equal(config.context_injection[0].label, "Only This");
	} finally {
		cleanup(home);
	}
});

test("applyTemplate resolves bare name (no .yml extension)", () => {
	const home = makeHome();
	try {
		const dir = join(home, "templates");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "bare"), "cleanup: bare-cleanup\n");
		const config = baseConfig();
		const result = applyTemplate(config, home, "bare", () => {});
		assert.equal(result, "bare");
		assert.equal(config.cleanup, "bare-cleanup");
	} finally {
		cleanup(home);
	}
});

test("applyTemplate overrides startup list", () => {
	const home = makeHome();
	try {
		writeTemplate(home, "quiet", `
startup:
  - echo quiet
  - echo mode
`);
		const config = baseConfig();
		applyTemplate(config, home, "quiet", () => {});
		assert.deepEqual(config.startup, ["echo quiet", "echo mode"]);
	} finally {
		cleanup(home);
	}
});

test("expandTemplateVars substitutes known vars", () => {
	const result = expandTemplateVars("Hello {agent_id}, today is {today}.", {
		agent_id: "cal-bright-bear",
		today: "2026-05-31",
	});
	assert.equal(result, "Hello cal-bright-bear, today is 2026-05-31.");
});

test("expandTemplateVars leaves unknown vars untouched", () => {
	const result = expandTemplateVars("{known} and {unknown}", { known: "yes" });
	assert.equal(result, "yes and {unknown}");
});

test("buildTemplateVars includes agent_id, today, now", () => {
	const vars = buildTemplateVars("cal-test-id", "uuid-123");
	assert.equal(vars.agent_id, "cal-test-id");
	assert.match(vars.today, /^\d{4}-\d{2}-\d{2}$/);
	assert.match(vars.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test("buildTemplateVars picks up KL_VAR_* from env", () => {
	process.env.KL_VAR_ROLE = "coordinator";
	process.env.KL_VAR_TEAM = "shuttle";
	try {
		const vars = buildTemplateVars("cal-test", "uuid");
		assert.equal(vars.role, "coordinator");
		assert.equal(vars.team, "shuttle");
	} finally {
		delete process.env.KL_VAR_ROLE;
		delete process.env.KL_VAR_TEAM;
	}
});

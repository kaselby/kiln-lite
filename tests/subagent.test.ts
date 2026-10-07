import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDescription, childPrompt, messageFrom } from "../extensions/kiln-lite/subagent-text.ts";
import { spawnSync } from "node:child_process";

import { agentHome, defaultAgentName, listAgents, resolveAgent } from "../src/sessions/agents.ts";
import { REPO_ROOT } from "../src/launcher.ts";

test("messageFrom reads the frontmatter from: line only", () => {
	assert.equal(messageFrom("---\nid: x\nfrom: sam-red-fox\nsummary: hi\n---\nfrom: body\n"), "sam-red-fox");
	assert.equal(messageFrom("---\nsummary: hi\n---\nfrom: body\n"), null);
	assert.equal(messageFrom("no frontmatter"), null);
});

test("childPrompt names the parent and keeps the task verbatim", () => {
	const p = childPrompt("lead-grey-reef", "0123abcd-1111", "do `x`\nthen y");
	assert.match(p, /launched as a subagent by lead-grey-reef \(session 0123abcd-1111\)/);
	assert.match(p, /to: "lead-grey-reef"/);
	assert.ok(p.endsWith("\n\ndo `x`\nthen y"));
});

test("agents dir: listing, description first line, cap in the tool description", () => {
	const dir = mkdtempSync(join(tmpdir(), "kl-agents-"));
	const prev = process.env.KL_AGENTS_DIR;
	process.env.KL_AGENTS_DIR = dir;
	try {
		for (let i = 0; i < 17; i++) {
			mkdirSync(join(dir, `a${i}`));
			writeFileSync(join(dir, `a${i}`, "agent.yml"), `name: a${i}\ndescription: |\n  role ${i}\n  more\n`);
		}
		mkdirSync(join(dir, "noyml"));
		const agents = listAgents();
		assert.equal(agents.length, 17);
		assert.equal(agents.find((a) => a.name === "a3")?.description, "role 3");
		assert.equal(agentHome("noyml"), null);
		assert.equal(agentHome("../x"), null);
		assert.equal(agentHome("a1"), join(dir, "a1"));
		const d = buildDescription(agents, "worker");
		assert.equal((d.match(/^- a\d+: role/gm) ?? []).length, 15);
		assert.match(d, /\.\.\. 2 more/);
		assert.match(d, /Without `agent`, it launches the default agent: worker\./);
		assert.match(buildDescription([], "worker"), /No installed agents/);
	} finally {
		if (prev === undefined) delete process.env.KL_AGENTS_DIR;
		else process.env.KL_AGENTS_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("default agent: KL_DEFAULT_AGENT, else config.yml default_agent, else worker; the subagent tool uses it", () => {
	const root = mkdtempSync(join(tmpdir(), "kl-root-"));
	const saved = { env: process.env.KL_DEFAULT_AGENT, root: process.env.KL_ROOT, dir: process.env.KL_AGENTS_DIR };
	process.env.KL_ROOT = root;
	process.env.KL_AGENTS_DIR = join(root, "agents");
	delete process.env.KL_DEFAULT_AGENT;
	try {
		assert.equal(defaultAgentName(), "worker");
		assert.throws(() => resolveAgent(), /no default agent 'worker'/);
		mkdirSync(join(root, "agents", "worker"), { recursive: true });
		writeFileSync(join(root, "agents", "worker", "agent.yml"), "name: worker\n");
		assert.deepEqual(resolveAgent(), { name: "worker", home: join(root, "agents", "worker") });
		writeFileSync(join(root, "config.yml"), "default_agent: helper\n");
		assert.equal(defaultAgentName(), "helper");
		process.env.KL_DEFAULT_AGENT = "scout";
		assert.equal(defaultAgentName(), "scout");
		process.env.KL_DEFAULT_AGENT = "Bad-Name";
		assert.throws(() => defaultAgentName(), /KL_DEFAULT_AGENT 'Bad-Name' is not an agent name/);
		assert.equal(resolveAgent("worker").name, "worker"); // a named agent doesn't consult the default
	} finally {
		for (const [k, v] of [["KL_DEFAULT_AGENT", saved.env], ["KL_ROOT", saved.root], ["KL_AGENTS_DIR", saved.dir]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("bin/kl with no agent: the default agent, never $AGENT_HOME", () => {
	const root = mkdtempSync(join(tmpdir(), "kl-root-"));
	try {
		const self = join(root, "agents", "scout");
		mkdirSync(self, { recursive: true });
		writeFileSync(join(self, "agent.yml"), "name: scout\n");
		writeFileSync(join(root, "config.yml"), "default_agent: helper\n");
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, KL_ROOT: root, AGENT_HOME: self };
		// helper isn't installed, so kl stops before launching anything.
		const r = spawnSync(join(REPO_ROOT, "bin", "kl"), ["run"], { env, encoding: "utf8" });
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no default agent 'helper' at .*agents\/helper \(use 'kl init helper' to create/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

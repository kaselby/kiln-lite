import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDescription, childPrompt, messageFrom } from "../extensions/kiln-lite/subagent-text.ts";
import { agentHome, listAgents } from "../src/sessions/agents.ts";

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
		const d = buildDescription(agents);
		assert.equal((d.match(/^- a\d+: role/gm) ?? []).length, 15);
		assert.match(d, /\.\.\. 2 more/);
		assert.match(buildDescription([]), /No installed agents/);
	} finally {
		if (prev === undefined) delete process.env.KL_AGENTS_DIR;
		else process.env.KL_AGENTS_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

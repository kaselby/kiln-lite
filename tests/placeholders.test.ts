import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expandPlaceholders, buildBasePlaceholders } from "../extensions/kiln-lite/placeholders.ts";

describe("expandPlaceholders", () => {
	it("substitutes known vars", () => {
		const result = expandPlaceholders("Hello {name}, today is {today}", {
			name: "Cal",
			today: "2026-05-31",
		});
		assert.equal(result, "Hello Cal, today is 2026-05-31");
	});

	it("leaves unknown vars untouched", () => {
		const result = expandPlaceholders("{known} and {unknown}", { known: "yes" });
		assert.equal(result, "yes and {unknown}");
	});

	it("handles empty vars map", () => {
		const result = expandPlaceholders("{foo} bar", {});
		assert.equal(result, "{foo} bar");
	});

	it("handles text with no placeholders", () => {
		const result = expandPlaceholders("no placeholders here", { foo: "bar" });
		assert.equal(result, "no placeholders here");
	});

	it("handles multiple occurrences of same var", () => {
		const result = expandPlaceholders("{x} + {x}", { x: "1" });
		assert.equal(result, "1 + 1");
	});

	it("does not expand nested braces", () => {
		const result = expandPlaceholders("{{foo}}", { foo: "bar" });
		// Outer { is literal, inner {foo} expands, trailing } is literal
		assert.equal(result, "{bar}");
	});
});

describe("buildBasePlaceholders", () => {
	it("includes expected base keys", () => {
		const vars = buildBasePlaceholders({
			agentId: "cal-test-session",
			agentHome: "/home/test/.kl/agent",
			sessionUuid: "abc-123",
		});
		assert.equal(vars.agent_id, "cal-test-session");
		assert.equal(vars.agent_home, "/home/test/.kl/agent");
		assert.equal(vars.session_uuid, "abc-123");
		assert.match(vars.today, /^\d{4}-\d{2}-\d{2}$/);
	});
});

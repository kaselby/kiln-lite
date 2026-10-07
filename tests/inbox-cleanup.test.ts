import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cleanInboxes } from "../src/daemon/inbox-cleanup.ts";
import { inboxDir } from "../src/sessions/paths.ts";

test("cleanInboxes sweeps stale read pairs in every run/<uuid>/inbox, keeps unread and fresh mail", () => {
	const root = mkdtempSync(join(tmpdir(), "kl-sweep-"));
	const dir = inboxDir("0aaa0d7c-d216-74b9-910c-aea077fe8fd5", root);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(root, "run", "names.lock")); // not a session: skipped
	for (const m of ["old", "new", "unread"]) writeFileSync(join(dir, `${m}.md`), "x");
	writeFileSync(join(dir, "old.read"), "");
	writeFileSync(join(dir, "new.read"), "");
	const longAgo = new Date(Date.now() - 10 * 86400_000);
	utimesSync(join(dir, "old.read"), longAgo, longAgo);

	const r = cleanInboxes({ root, maxAgeMs: 86400_000 });
	assert.deepEqual(r, { sessionsScanned: 1, deleted: 1 });
	assert.ok(!existsSync(join(dir, "old.md")) && !existsSync(join(dir, "old.read")));
	assert.ok(existsSync(join(dir, "new.md")) && existsSync(join(dir, "unread.md")));
	rmSync(root, { recursive: true });
});

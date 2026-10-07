/**
 * Per-session runtime config: run/<uuid>/config.yml over agent.yml over
 * config.yml for timestamps and session_state_interval, read at use, and
 * `kl config` to show/set/unset it. Temp KL_ROOT and HOME throughout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../extensions/kiln-lite/config.ts";
import { runtimeConfig } from "../extensions/kiln-lite/runtime-config.ts";
import { writeEntry } from "../src/sessions/registry.ts";
import { sessionConfigPath } from "../src/sessions/paths.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const UUID = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kl-rtc-"));
	const home = join(root, "agents", "bob");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(root, "run", UUID), { recursive: true });
	return { root, home, path: sessionConfigPath(UUID, root) };
}

/** Atomic write, as kl config does: a new inode every time. */
function put(path: string, text: string): void {
	writeFileSync(`${path}.tmp`, text);
	renameSync(`${path}.tmp`, path);
}

test("layering: session file > agent.yml > config.yml, timestamps merged one level", () => {
	const { root, home, path } = setup();
	writeFileSync(join(root, "config.yml"), "timestamps:\n  every_minutes: 3\n  per_turn: false\nsession_state_interval: 7\n");
	writeFileSync(join(home, "agent.yml"), "timestamps:\n  every_calls: 5\n  per_turn: true\n");
	const c = loadConfig({ agentHome: home, klRoot: root, warn: () => {} });
	assert.deepEqual(c.timestamps, { per_turn: true, every_calls: 5, every_minutes: 3 });

	put(path, "timestamps:\n  every_minutes: 1\n");
	const rt = runtimeConfig(path, { timestamps: c.timestamps, session_state_interval: c.session_state_interval }, () => {});
	assert.deepEqual(rt.get(), { timestamps: { per_turn: true, every_calls: 5, every_minutes: 1 }, session_state_interval: 7 });

	put(path, "timestamps: false\nsession_state_interval: 2\n");
	assert.deepEqual(rt.get(), { timestamps: false, session_state_interval: 2 });
	rmSync(root, { recursive: true, force: true });
});

test("edits to the session file apply on the next read; bad values warn once and are ignored", () => {
	const { root, path } = setup();
	const base = { timestamps: { per_turn: true, every_calls: 20, every_minutes: 10 }, session_state_interval: 15 } as const;
	const warnings: string[] = [];
	const rt = runtimeConfig(path, { ...base }, (m) => warnings.push(m));

	const first = rt.get();
	assert.deepEqual(first, base, "no file: no overrides");
	assert.equal(rt.get(), first, "unchanged file: same object");

	put(path, "session_state_interval: 3\n");
	assert.equal(rt.get().session_state_interval, 3);
	put(path, "session_state_interval: 4\n");
	assert.equal(rt.get().session_state_interval, 4);

	put(path, "session_state_interval: -1\nbogus: 1\n");
	assert.equal(rt.get().session_state_interval, 15);
	put(path, "session_state_interval: -1\nbogus: 1\ntimestamps: {every_calls: 2}\n");
	const v = rt.get();
	assert.equal(v.session_state_interval, 15);
	assert.equal(v.timestamps && v.timestamps.every_calls, 2);
	assert.equal(warnings.filter((w) => w.includes("session_state_interval must be")).length, 1);
	assert.equal(warnings.filter((w) => w.includes("bogus")).length, 1);

	rmSync(path);
	assert.deepEqual(rt.get(), base, "file removed: back to the base");
	rmSync(root, { recursive: true, force: true });
});

function kl(root: string, args: string[], extra: Record<string, string> = {}) {
	const env: Record<string, string | undefined> = { ...process.env, KL_ROOT: root, HOME: root, ...extra };
	if (!("SESSION_UUID" in extra)) delete env.SESSION_UUID;
	return spawnSync(join(REPO, "bin", "kl"), ["config", ...args], { env, encoding: "utf8" });
}

test("kl config shows effective values with sources, sets, unsets, and defaults to this session inside one", () => {
	const { root, home, path } = setup();
	writeFileSync(join(root, "config.yml"), "session_state_interval: 7\n");
	writeFileSync(join(home, "agent.yml"), "timestamps:\n  every_calls: 5\n");
	const created = "2026-10-07T00:00:00Z";
	writeEntry(
		{ uuid: UUID, agent: "bob", name: "bob-red-fox", names: [{ name: "bob-red-fox", bound: created }], home, transcript: "/x", cwd: "/", created },
		root,
	);
	const row = (out: string, key: string) => out.split("\n").find((l) => l.startsWith(`${key} `))?.trim().split(/\s+/);

	let r = kl(root, ["bob-red-fox"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(row(r.stdout, "timestamps.every_calls"), ["timestamps.every_calls", "5", "agent.yml"]);
	assert.deepEqual(row(r.stdout, "session_state_interval"), ["session_state_interval", "7", "config.yml"]);
	assert.deepEqual(row(r.stdout, "timestamps.every_minutes"), ["timestamps.every_minutes", "10", "default"]);
	assert.equal(existsSync(path), false, "showing doesn't create the file");

	r = kl(root, ["bob-red-fox", "timestamps.every_minutes=2", "session_state_interval=0"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(row(r.stdout, "timestamps.every_minutes"), ["timestamps.every_minutes", "2", "session"]);
	assert.deepEqual(row(r.stdout, "timestamps.every_calls"), ["timestamps.every_calls", "5", "agent.yml"]);
	assert.equal(readFileSync(path, "utf8"), "timestamps:\n  every_minutes: 2\nsession_state_interval: 0\n");

	r = kl(root, ["timestamps=false"], { SESSION_UUID: UUID });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(row(r.stdout, "timestamps"), ["timestamps", "off", "session"]);

	r = kl(root, ["bob-red-fox", "session_state_interval=-3"]);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /session_state_interval must be a number >= 0/);
	assert.match(readFileSync(path, "utf8"), /session_state_interval: 0/, "a rejected value isn't written");
	r = kl(root, ["bob-red-fox", "timestamps.nope=1"]);
	assert.notEqual(r.status, 0);

	r = kl(root, ["bob-red-fox", "timestamps=", "session_state_interval="]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(path), false, "nothing left: the file is removed");
	assert.deepEqual(row(r.stdout, "session_state_interval"), ["session_state_interval", "7", "config.yml"]);

	r = kl(root, []);
	assert.notEqual(r.status, 0, "outside a session, a session is required");
	rmSync(root, { recursive: true, force: true });
});

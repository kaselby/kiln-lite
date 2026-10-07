/**
 * Scheduled wakes (outside the daemon). A wake is a record under
 * <kl root>/run/<session uuid>/schedule/ plus one detached worker process
 * (src/schedule-worker.ts) that sleeps until a time, or polls a pid until it
 * exits, then delivers the note to the session's own inbox through the
 * daemon (deliver_self). Wakes survive the session's exit (the note parks in
 * its inbox); workers don't survive a reboot.
 *
 *   <id>.json    record: kind, target, worker pid, note, requester
 *   <id>.armed   gate: the worker waits for it, so its pid is on record before it can fire
 *   <id>.error   delivery failed after retries (kept so `list` shows it)
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import type { Requester } from "./daemon/protocol.ts";
import { resolveTsxBin } from "./client/autostart.ts";
import { pidAlive, writeAtomic, isoNow } from "./sessions/fsutil.ts";
import { scheduleDir } from "./sessions/paths.ts";

export { scheduleDir };

export const WORKER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "schedule-worker.ts");
export const DEFAULT_NOTE = "A scheduled wake fired. Check on the thing you were waiting for.";
const ID_RE = /^wake-[0-9]+-[0-9a-f]{8}$/;

export interface WakeRecord {
	id: string;
	kind: "at" | "watch";
	/** at: epoch ms; watch: pid. */
	target: number;
	worker_pid: number;
	created: string;
	note: string;
	requester: Requester;
}

const recordPath = (dir: string, id: string) => join(dir, `${id}.json`);
const armedPath = (dir: string, id: string) => join(dir, `${id}.armed`);
const errorPath = (dir: string, id: string) => join(dir, `${id}.error`);

export function validWakeId(id: string): boolean {
	return ID_RE.test(id);
}

export function newWakeId(now = Date.now()): string {
	return `wake-${Math.floor(now / 1000)}-${randomBytes(4).toString("hex")}`;
}

/** "30s" | "10m" | "2h" | "1d" → seconds. Throws on anything else. */
export function parseDelay(delay: string): number {
	const m = delay.trim().match(/^([0-9]+)([smhd])$/);
	if (!m) throw new Error(`bad delay '${delay}': use forms like 30s, 10m, 2h, 1d`);
	const n = Number(m[1]);
	if (!(n > 0)) throw new Error("delay must be greater than zero");
	const secs = n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
	if (!Number.isSafeInteger(secs * 1000)) throw new Error("delay is too large");
	return secs;
}

export function readRecord(dir: string, id: string): WakeRecord | null {
	try {
		const r = JSON.parse(readFileSync(recordPath(dir, id), "utf8")) as WakeRecord;
		return r && (r.kind === "at" || r.kind === "watch") ? r : null;
	} catch {
		return null;
	}
}

function removeWake(dir: string, id: string): void {
	for (const p of [recordPath(dir, id), armedPath(dir, id), errorPath(dir, id)]) {
		try {
			unlinkSync(p);
		} catch {
			// not there
		}
	}
}

/** The worker for `id` is running (pid alive and its command line names the id). */
export function workerAlive(pid: number, id: string): boolean {
	if (!pidAlive(pid)) return false;
	try {
		const cmd = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return cmd.includes(` ${id}`);
	} catch {
		return false;
	}
}

export interface CreateInput {
	uuid: string;
	requester: Requester;
	kind: "at" | "watch";
	/** at: epoch ms; watch: pid. */
	target: number;
	note?: string;
	root?: string;
	/** Tests: start the worker some other way. Returns its pid. */
	startWorker?: (dir: string, id: string) => number;
}

export function createWake(input: CreateInput): WakeRecord {
	if (input.kind === "watch") {
		if (!Number.isInteger(input.target) || input.target <= 0) throw new Error("watch needs a positive integer pid");
		if (!pidAlive(input.target)) throw new Error(`PID ${input.target} is not alive`);
	} else if (!(input.target > Date.now())) {
		throw new Error("that time is in the past");
	}
	const dir = scheduleDir(input.uuid, input.root);
	mkdirSync(dir, { recursive: true });
	const record: WakeRecord = {
		id: newWakeId(),
		kind: input.kind,
		target: input.target,
		worker_pid: 0,
		created: isoNow(),
		note: input.note?.trim() ? input.note : DEFAULT_NOTE,
		requester: input.requester,
	};
	writeAtomic(recordPath(dir, record.id), `${JSON.stringify(record, null, 2)}\n`);
	let pid: number;
	try {
		pid = (input.startWorker ?? spawnWorker)(dir, record.id);
	} catch (err) {
		removeWake(dir, record.id);
		throw new Error(`failed to start the wake worker: ${(err as Error).message}`);
	}
	record.worker_pid = pid;
	writeAtomic(recordPath(dir, record.id), `${JSON.stringify(record, null, 2)}\n`);
	writeFileSync(armedPath(dir, record.id), "");
	return record;
}

function spawnWorker(dir: string, id: string): number {
	const child = spawn(resolveTsxBin(), [WORKER_ENTRY, dir, id, String(process.pid)], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	if (!child.pid) throw new Error("spawn returned no pid");
	return child.pid;
}

export function describe(r: WakeRecord, now = Date.now()): string {
	if (r.kind === "watch") return `when PID ${r.target} exits`;
	return `at ${new Date(r.target).toISOString()} (${Math.max(0, Math.ceil((r.target - now) / 1000))}s from now)`;
}

export function listWakes(uuid: string, root?: string): string {
	const dir = scheduleDir(uuid, root);
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		// none yet
	}
	const lines: string[] = [];
	for (const f of files) {
		const id = f.slice(0, -5);
		const r = readRecord(dir, id);
		if (!r) {
			lines.push(`- ${id}: unreadable record`);
			continue;
		}
		const status = workerAlive(r.worker_pid, id) ? "alive" : "DEAD";
		lines.push(`- ${id} [${r.kind}] fires ${describe(r)}: worker ${status} (pid ${r.worker_pid})`);
		lines.push(`  note: ${r.note.split("\n")[0]}`);
		const err = errorPath(dir, id);
		if (existsSync(err)) lines.push(`  error: ${readFileSync(err, "utf8").split("\n")[0]}`);
	}
	return lines.length ? lines.join("\n") : "No pending wakes.";
}

export function cancelWake(uuid: string, id: string, root?: string): string {
	if (!validWakeId(id)) throw new Error(`invalid wake id: ${id}`);
	const dir = scheduleDir(uuid, root);
	const r = readRecord(dir, id);
	if (!r) throw new Error(`no such wake: ${id}`);
	if (workerAlive(r.worker_pid, id)) {
		try {
			process.kill(r.worker_pid, "SIGTERM");
		} catch {
			// gone
		}
	}
	removeWake(dir, id);
	return `Wake ${id} cancelled.`;
}

// --- worker ---------------------------------------------------------------

export type Deliver = (requester: Requester, summary: string, body: string) => Promise<void>;

export interface WorkerOptions {
	dir: string;
	id: string;
	/** The process that created the wake; if it dies before arming, give up. */
	creatorPid: number;
	deliver: Deliver;
	retryMs?: number;
	pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait, fire, deliver. Returns an exit code. */
export async function runWorker(o: WorkerOptions): Promise<number> {
	if (!validWakeId(o.id)) return 2;
	const dir = resolve(o.dir);
	while (!existsSync(armedPath(dir, o.id))) {
		// The record exists before the worker starts, so a missing one means cancelled.
		if (!existsSync(recordPath(dir, o.id))) return 0;
		if (!pidAlive(o.creatorPid)) return 1;
		await sleep(50);
	}
	let r = readRecord(dir, o.id);
	if (!r) return 0; // cancelled
	let summary: string;
	if (r.kind === "at") {
		// setTimeout caps at ~24.8 days; sleep in chunks.
		while (Date.now() < r.target) await sleep(Math.min(r.target - Date.now(), 2 ** 30));
		summary = "Scheduled wake";
	} else {
		while (pidAlive(r.target)) await sleep(o.pollMs ?? 2000);
		summary = `Watched process ${r.target} exited`;
	}
	r = readRecord(dir, o.id);
	if (!r) return 0; // cancelled while waiting
	let lastErr = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await o.deliver(r.requester, summary, r.note);
			removeWake(dir, o.id);
			return 0;
		} catch (err) {
			lastErr = (err as Error).message;
			if (attempt < 3) await sleep(o.retryMs ?? 2000);
		}
	}
	writeFileSync(errorPath(dir, o.id), `delivery failed after 3 attempts at ${isoNow()}: ${lastErr}\n`);
	return 1;
}

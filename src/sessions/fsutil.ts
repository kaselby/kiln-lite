/**
 * Small filesystem primitives shared by the registry, leases and locks.
 */

import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";

/** Write via tmp + rename in the same dir, so readers never see a partial file. */
export function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** kill -0. EPERM counts as alive (exists, not ours). */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface LockOptions {
	/** Give up after this long (ms). Default 20000. */
	timeoutMs?: number;
	/** Poll interval while the lock is held by someone else. Default 50. */
	pollMs?: number;
	/** Called once if we wait on a live holder. */
	onWait?: (holderPid: number) => void;
	/** Called when a dead holder's lock is broken. */
	onBreak?: (holderPid: number) => void;
}

/**
 * mkdir lock with the holder's pid inside (`<lock>/pid`). A lock whose
 * holder is dead is broken. A lock with no pid file yet (holder between
 * mkdir and write) is treated as live for a grace second.
 * Returns a release function; throws on timeout.
 */
export function acquireLock(lockPath: string, opts: LockOptions = {}): () => void {
	const timeoutMs = opts.timeoutMs ?? 20000;
	const pollMs = opts.pollMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	mkdirSync(dirname(lockPath), { recursive: true });
	let waited = false;
	let noPidSince: number | null = null;
	for (;;) {
		try {
			mkdirSync(lockPath);
			writeFileSync(join(lockPath, "pid"), String(process.pid));
			return () => releaseLock(lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		let holder = NaN;
		try {
			holder = Number(readFileSync(join(lockPath, "pid"), "utf8").trim());
		} catch {
			// holder hasn't written its pid yet
		}
		if (Number.isFinite(holder) && holder > 0) {
			noPidSince = null;
			if (!pidAlive(holder)) {
				opts.onBreak?.(holder);
				releaseLock(lockPath);
				continue;
			}
			if (!waited) {
				waited = true;
				opts.onWait?.(holder);
			}
		} else {
			noPidSince ??= Date.now();
			if (Date.now() - noPidSince > 1000) {
				opts.onBreak?.(0);
				releaseLock(lockPath);
				continue;
			}
		}
		if (Date.now() > deadline) {
			throw new Error(`lock ${lockPath} still held by pid ${Number.isFinite(holder) ? holder : "?"} after ${timeoutMs}ms`);
		}
		sleepMs(pollMs);
	}
}

function releaseLock(lockPath: string): void {
	try {
		unlinkSync(join(lockPath, "pid"));
	} catch {
		// already gone
	}
	try {
		rmdirSync(lockPath);
	} catch {
		// already gone
	}
}

export function withLock<T>(lockPath: string, fn: () => T, opts?: LockOptions): T {
	const release = acquireLock(lockPath, opts);
	try {
		return fn();
	} finally {
		release();
	}
}

export function isoNow(date = new Date()): string {
	return date.toISOString().replace(/\.\d+Z$/, "Z");
}

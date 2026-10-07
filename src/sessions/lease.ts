/**
 * Lease: liveness, written by the running pi process about itself.
 * Live = lease exists, pid alive, and that pid's start time (and boot id)
 * match what the lease recorded, so a reused pid never looks live.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

import { pidAlive, writeAtomic, isoNow } from "./fsutil.ts";
import { klRoot, leasePath, sessionUuids } from "./paths.ts";

export { leasePath };

export interface Lease {
	uuid: string;
	pid: number;
	/** Process start time (ISO, second precision, from ps lstart). */
	started: string;
	boot_id: string;
	name: string;
	/** tmux session name, if the process runs in one. */
	tmux: string;
	state: "busy" | "idle";
	since: string;
}

/** Start time of `pid` (ISO), or null if it isn't running. */
export function processStartTime(pid: number): string | null {
	return processStartTimes([pid]).get(pid) ?? null;
}

/** One `ps` call for many pids. */
export function processStartTimes(pids: number[]): Map<number, string> {
	const out = new Map<number, string>();
	const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
	if (valid.length === 0) return out;
	let text = "";
	try {
		text = execFileSync("ps", ["-o", "pid=,lstart=", "-p", valid.join(",")], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (err) {
		// ps exits 1 when none of the pids exist; stdout may still hold some rows
		text = String((err as { stdout?: unknown }).stdout ?? "");
	}
	for (const line of text.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.+)$/);
		if (!m) continue;
		const d = new Date(m[2].trim());
		if (!Number.isNaN(d.getTime())) out.set(Number(m[1]), isoNow(d));
	}
	return out;
}

let cachedBootId: string | null = null;
/** Boot id: Linux's random boot_id, else macOS kern.boottime seconds. "" if neither. */
export function bootId(): string {
	if (cachedBootId !== null) return cachedBootId;
	let id = "";
	try {
		id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		try {
			const t = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			const m = t.match(/sec = (\d+)/);
			if (m) id = `boottime-${m[1]}`;
		} catch {
			// unknown platform: liveness falls back to pid + start time
		}
	}
	cachedBootId = id;
	return id;
}

export function readLease(uuid: string, root = klRoot()): Lease | null {
	try {
		const raw = JSON.parse(readFileSync(leasePath(uuid, root), "utf8")) as Partial<Lease>;
		if (typeof raw.pid !== "number" || typeof raw.started !== "string") return null;
		return {
			uuid,
			pid: raw.pid,
			started: raw.started,
			boot_id: raw.boot_id ?? "",
			name: raw.name ?? "",
			tmux: raw.tmux ?? "",
			state: raw.state === "busy" ? "busy" : "idle",
			since: raw.since ?? "",
		};
	} catch {
		return null;
	}
}

export function writeLease(lease: Lease, root = klRoot()): void {
	const { uuid, ...body } = lease;
	writeAtomic(leasePath(uuid, root), `${JSON.stringify(body)}\n`);
}

/** `startTimes` lets callers batch the ps lookup (see liveLeases). */
export function leaseIsLive(lease: Lease, startTimes?: Map<number, string>): boolean {
	if (!pidAlive(lease.pid)) return false;
	const started = startTimes ? startTimes.get(lease.pid) : processStartTime(lease.pid);
	if (!started || started !== lease.started) return false;
	const boot = bootId();
	if (lease.boot_id && boot && lease.boot_id !== boot) return false;
	return true;
}

export function allLeases(root = klRoot()): Lease[] {
	const out: Lease[] = [];
	for (const uuid of sessionUuids(root)) {
		const l = readLease(uuid, root);
		if (l) out.push(l);
	}
	return out;
}

/** Live leases keyed by uuid (one ps call). */
export function liveLeases(root = klRoot()): Map<string, Lease> {
	const leases = allLeases(root);
	const starts = processStartTimes(leases.map((l) => l.pid).filter(pidAlive));
	const out = new Map<string, Lease>();
	for (const l of leases) if (leaseIsLive(l, starts)) out.set(l.uuid, l);
	return out;
}

/** The live lease for `uuid`, or null (dead or reused pid = not live). */
export function liveLease(uuid: string, root = klRoot()): Lease | null {
	const l = readLease(uuid, root);
	return l && leaseIsLive(l) ? l : null;
}

/** A fresh lease for this process. */
export function selfLease(uuid: string, name: string, tmux: string, state: Lease["state"] = "idle"): Lease {
	const started = processStartTime(process.pid);
	if (!started) throw new Error(`could not read this process's start time (pid ${process.pid})`);
	return { uuid, pid: process.pid, started, boot_id: bootId(), name, tmux, state, since: isoNow() };
}

/** Remove the lease only if it is ours (pid matches). */
export function releaseLease(uuid: string, pid = process.pid, root = klRoot()): boolean {
	const l = readLease(uuid, root);
	if (!l || l.pid !== pid) return false;
	try {
		unlinkSync(leasePath(uuid, root));
		return true;
	} catch {
		return false;
	}
}

/**
 * Session identity inside the pi process: read the UUID from the
 * transcript header, pick the name, take the lease, write the registry
 * entry and the `kl-name` transcript entry, keep the tmux session name in
 * step with the transcript.
 *
 * Name choice at session_start:
 *   - reload: keep the current name.
 *   - first start in a kl-launched process: $KL_NAME (kl reserved it under
 *     names.lock and created the tmux session with it).
 *   - otherwise (plain `pi -e`, or /new /fork /clone /resume in-process):
 *     an existing entry's last name if nothing live holds it, else a fresh
 *     draw, under names.lock.
 */

import { isoNow } from "../../src/sessions/fsutil.ts";
import { readLease, leaseIsLive, releaseLease, selfLease, writeLease, type Lease } from "../../src/sessions/lease.ts";
import { drawName, reserveName } from "../../src/sessions/names.ts";
import { UUID_RE, klRoot } from "../../src/sessions/paths.ts";
import { bindName, readEntry, writeEntry, type RegistryEntry } from "../../src/sessions/registry.ts";
import { ownTmuxSession, renameOwnTmuxSession } from "../../src/sessions/tmux.ts";

export const NAME_ENTRY = "kl-name";

export interface SessionCtxLike {
	cwd: string;
	model?: { provider?: string; id?: string };
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}

export interface BoundSession {
	uuid: string;
	name: string;
	entry: RegistryEntry;
	lease: Lease;
	/** True when this start (re)bound the name: append a kl-name entry. */
	rebound: boolean;
}

export type ClaimResult = { ok: true; session: BoundSession } | { ok: false; reason: string };

/** KL_NAME/KL_PARENT/KL_WAKE belong to the first session_start of the process only. */
let launchEnvConsumed = false;

export function resetLaunchEnvForTests(): void {
	launchEnvConsumed = false;
}

export interface ClaimInput {
	reason: string;
	agent: string;
	home: string;
	ctx: SessionCtxLike;
	thinking?: string;
	/** Name held before a reload. */
	currentName?: string;
	warn: (msg: string) => void;
}

export function claimSession(input: ClaimInput): ClaimResult {
	const { ctx, agent, home, warn } = input;
	const root = klRoot();
	const uuid = ctx.sessionManager.getSessionId();
	if (!uuid || !UUID_RE.test(uuid)) return { ok: false, reason: `session id '${uuid}' is not a UUID` };
	const transcript = ctx.sessionManager.getSessionFile() ?? "";

	const existing = readLease(uuid, root);
	if (existing && existing.pid !== process.pid && leaseIsLive(existing)) {
		return {
			ok: false,
			reason: `session ${existing.name} (${uuid}) is already running as pid ${existing.pid}; refusing to start a second process on the same transcript`,
		};
	}

	let launchName: string | undefined;
	let parent: string | undefined;
	let wakeMode: "park" | "auto" = "park";
	if (!launchEnvConsumed) {
		launchEnvConsumed = true;
		launchName = process.env.KL_NAME?.trim() || undefined;
		const p = process.env.KL_PARENT?.trim();
		if (p) {
			if (UUID_RE.test(p)) parent = p;
			else warn(`kiln-lite: KL_PARENT '${p}' is not a session UUID; not recording a parent`);
		}
		if (process.env.KL_WAKE === "auto") wakeMode = "auto";
	}
	// Children inherit our env through bash; don't let them reuse it.
	delete process.env.KL_NAME;
	delete process.env.KL_PARENT;
	delete process.env.KL_WAKE;

	const prior = readEntry(uuid, root);
	const tmuxName = ownTmuxSession();
	const commit = (name: string): BoundSession => {
		const lease = selfLease(uuid, name, tmuxName ? name : "");
		writeLease(lease, root);
		const now = isoNow();
		let entry: RegistryEntry;
		if (prior) {
			entry = prior.name === name && input.reason === "reload" ? prior : bindName(prior, name, now);
			if (transcript && entry.transcript !== transcript) entry = { ...entry, transcript };
		} else {
			entry = {
				uuid,
				agent,
				name,
				names: [{ name, bound: now }],
				home,
				transcript,
				cwd: ctx.cwd,
				parent,
				created: now,
				wake: wakeMode,
				launch: {
					model: ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinking: input.thinking,
				},
			};
		}
		writeEntry(entry, root);
		return { uuid, name, entry, lease, rebound: entry !== prior };
	};

	try {
		let session: BoundSession;
		const reloadName = input.reason === "reload" ? (input.currentName ?? prior?.name) : undefined;
		if (reloadName) {
			session = commit(reloadName);
		} else if (launchName) {
			session = commit(launchName);
		} else {
			session = reserveName(
				(state) =>
					// Our own tmux session holding the name doesn't count.
					prior && (!state.held.has(prior.name) || prior.name === tmuxName)
						? prior.name
						: drawName({ agent, held: state.held, recent: state.recent }),
				commit,
				{ root, excludeUuid: uuid },
			);
		}
		if (tmuxName && tmuxName !== session.name) {
			const r = renameOwnTmuxSession(session.name);
			if (!r.ok) warn(`kiln-lite: could not rename tmux session ${tmuxName} → ${session.name}: ${r.error}`);
			else session.lease = { ...session.lease, tmux: session.name };
			writeLease(session.lease, root);
		}
		return { ok: true, session };
	} catch (err) {
		return { ok: false, reason: `could not register session: ${(err as Error).message}` };
	}
}

/** Mirror busy/idle into the lease (agent_start / agent_settled). */
export function setLeaseState(session: BoundSession, state: Lease["state"]): void {
	session.lease = { ...session.lease, state, since: isoNow() };
	try {
		writeLease(session.lease);
	} catch {
		// best effort: liveness doesn't depend on state
	}
}

export function releaseSession(session: BoundSession | null): void {
	if (session) releaseLease(session.uuid);
}

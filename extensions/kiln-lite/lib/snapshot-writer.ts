/**
 * Write-once snapshot guard.
 *
 * The system-prompt snapshot for a given agent-id is meant to be written
 * exactly once — at the FIRST compose of a fresh session — and then read
 * verbatim on every subsequent resume. The "first compose" detection lives
 * across two handlers (session_start checks for an existing snapshot;
 * before_agent_start writes a new one on the first call where none exists),
 * which historically made the invariant fragile.
 *
 * SnapshotWriter encapsulates the write-once bit so callers can't
 * accidentally double-write. Construct one per session; call markExisting()
 * at session_start if you find a snapshot on disk, then writeOnce() from
 * before_agent_start unconditionally — repeat calls are no-ops.
 */

import { readPromptSnapshot, writePromptSnapshot } from "../snapshot.ts";

export interface SnapshotWriter {
	/** True if a snapshot has been written (either by us this session, or pre-existing). */
	isWritten(): boolean;
	/** Mark the snapshot as pre-existing — call at session_start when readPromptSnapshot returns non-null. */
	markExisting(): void;
	/**
	 * Write the snapshot if it hasn't been written yet. Idempotent — subsequent
	 * calls in the same session are no-ops, preserving the "captured at first
	 * compose" invariant. Best-effort write (delegates to writePromptSnapshot).
	 */
	writeOnce(prompt: string): void;
}

export interface CreateSnapshotWriterOptions {
	agentHome: string;
	agentId: string;
	warn?: (msg: string) => void;
}

export function createSnapshotWriter(opts: CreateSnapshotWriterOptions): SnapshotWriter {
	let written = false;
	return {
		isWritten: () => written,
		markExisting: () => {
			written = true;
		},
		writeOnce: (prompt: string) => {
			if (written) return;
			writePromptSnapshot(opts.agentHome, opts.agentId, prompt, opts.warn);
			written = true;
		},
	};
}

/**
 * Convenience: construct a SnapshotWriter, eagerly checking for an existing
 * on-disk snapshot. Returns both the writer and the loaded prompt (or null).
 *
 * Use at session_start when you want to:
 *   1. Detect resume mode (cachedSystemPrompt = result.existing)
 *   2. Hand a writer to before_agent_start that already knows not to re-write
 */
export function loadOrCreateSnapshotWriter(opts: CreateSnapshotWriterOptions): {
	writer: SnapshotWriter;
	existing: string | null;
} {
	const writer = createSnapshotWriter(opts);
	const existing = readPromptSnapshot(opts.agentHome, opts.agentId, opts.warn);
	if (existing !== null) writer.markExisting();
	return { writer, existing };
}

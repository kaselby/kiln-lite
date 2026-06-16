/**
 * Public surface of the kiln-lite library.
 *
 * The default-harness composition lives in `./install.ts` as
 * `installDefaultHarness`. Building blocks (factories, pure helpers, types)
 * are re-exported here for custom harnesses that want to compose their own
 * lifecycle without inheriting every kiln-lite decision.
 *
 * Stable surface — additions allowed, renames considered breaking.
 */

// --- Default composition ---
export { installDefaultHarness, inferSessionUuid, type HarnessHandle } from "./install.ts";

// --- Pure helpers (lib-native) ---
export {
	composeToolResultSuffix,
	appendTextToContent,
} from "./formatting.ts";
export {
	resolveAgentId,
	type ResolveAgentIdOptions,
	type ResolvedAgentId,
} from "./resolve-agent-id.ts";
export {
	createSnapshotWriter,
	loadOrCreateSnapshotWriter,
	type SnapshotWriter,
	type CreateSnapshotWriterOptions,
} from "./snapshot-writer.ts";
export { runAgentEndOrdered, type RunAgentEndOptions } from "./agent-end.ts";

// --- Re-exports of stable kiln-lite primitives ---
// Harnesses use these directly. The lib namespace just centralizes imports
// so a harness doesn't have to know the internal file layout.

export { resolveAgentHomeDetailed, loadAgentConfig } from "../config.ts";
export { buildEnv, applyEnv } from "../env.ts";
export { generateAgentId } from "../identity.ts";
export { composeSystemPrompt, preloadStaticInjection } from "../prompt.ts";
export { discoverTools, renderToolIndex } from "../tools.ts";
export { startInboxWatcher, type InboxWatcher, type InboxWatcherOptions } from "../inbox.ts";
export {
	createCleanupDispatcher,
	registerExitCommands,
	type CleanupDispatcher,
	type ExitCommandOptions,
} from "../cleanup.ts";
export { ensureScaffold } from "../bootstrap.ts";
export { buildMessageTool } from "../message-tool.ts";
export { buildExitSessionTool, type ExitSessionToolDeps } from "../exit-session-tool.ts";
export { resolveHandoff, type ContinuationConfig } from "../exit-session.ts";
export { registerSpawnCommand } from "../spawn.ts";
export { createSessionStateHook, type SessionStateHook } from "../session-state.ts";
export {
	loadCommandGates,
	applyCommandGates,
	defaultGateNotifier,
	DEFAULT_CONFIRM_TIMEOUT_MS,
	type CompiledGate,
	type GateNotifier,
	type GateNotifyInfo,
} from "../gates.ts";
export {
	applyTemplate,
} from "../template.ts";
export {
	expandPlaceholders,
	buildBasePlaceholders,
} from "../placeholders.ts";
export {
	readMeta,
	writeMeta,
	readPromptSnapshot,
	writePromptSnapshot,
	findAgentIdForUuid,
	uniquifyAgentId,
	snapshotDir,
	snapshotsRoot,
	metaPath,
	promptPath,
	type SnapshotMeta,
} from "../snapshot.ts";
export type {
	AgentConfig,
	ContextInjectionEntry,
	SessionState,
} from "../types.ts";
export { DaemonClient } from "../../../src/client/index.ts";

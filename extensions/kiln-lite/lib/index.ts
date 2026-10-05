/**
 * Public surface of the kiln-lite library, for agent extensions that want
 * kl's building blocks. Additions allowed; renames are breaking.
 */

export { installCore, inferSessionUuid, type CoreHandle } from "./core.ts";
export { composeToolResultSuffix, appendTextToContent } from "./formatting.ts";
export { resolveAgentId, type ResolveAgentIdOptions, type ResolvedAgentId } from "./resolve-agent-id.ts";

export { resolveAgentHomeDetailed, resolveKlRoot, loadConfig, loadAgentConfig } from "../config.ts";
export { buildEnv, applyEnv } from "../env.ts";
export { generateAgentId } from "../identity.ts";
export {
	applyPrompt,
	buildCustomPrompt,
	loadBaseline,
	loadIdentity,
	renderSections,
	renderSessionSection,
	renderToolRules,
	type PromptParts,
	type SessionInfo,
} from "../prompt.ts";
export { startInboxWatcher, type InboxWatcher, type InboxWatcherOptions } from "../inbox.ts";
export { buildMessageTool } from "../message-tool.ts";
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
export { readMeta, writeMeta, findAgentIdForUuid, uniquifyAgentId, snapshotDir, snapshotsRoot, metaPath, type SnapshotMeta } from "../snapshot.ts";
export type { AgentConfig, SectionEntry, TimestampConfig, PromptFileSource, PromptSource, SessionState } from "../types.ts";
export { DaemonClient } from "../../../src/client/index.ts";

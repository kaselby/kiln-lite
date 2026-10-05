/**
 * Shared types for kiln-lite.
 */

/**
 * One agent.yml `sections:` entry. Rendered once at session start into a
 * named Pi system-prompt section (`<name>…</name>`), appended after kl's
 * `session` section in listed order.
 */
export interface SectionEntry {
	/** Section/tag name. Must match Pi's `^[a-z][a-z0-9_-]*$`. */
	name: string;
	/** File to read (absolute, or relative to `baseDir`). Exclusive with `command`. */
	path?: string;
	/** Shell command whose stdout becomes the section. Exclusive with `path`. */
	command?: string;
	/** Dir that relative paths resolve against and commands run in: the dir of the config file that declared the entry. */
	baseDir: string;
}

export interface PromptFileSource {
	/** Absolute path or path relative to $AGENT_HOME. */
	path: string;
}

/** Prompt text supplied inline or loaded from a file when it is used. */
export type PromptSource = string | PromptFileSource;

/** Timestamp settings. `timestamps: false` in config disables both kinds. */
export interface TimestampConfig {
	/** Inject a hidden `[time: …]` message at the start of every user turn. */
	per_turn: boolean;
	/** During autonomous stretches, stamp a tool result every N calls (0 = off). */
	every_calls: number;
	/** …or once this many minutes have passed since the last stamp (0 = off). */
	every_minutes: number;
}

/**
 * Merged kl configuration: `~/.kl/config.yml` (global) with the agent's
 * `agent.yml` overriding it key by key (top-level keys replace; no deep merge).
 */
export interface AgentConfig {
	/** Agent name — first component of <name>-<adj>-<noun> session ids. agent.yml only. */
	name: string;
	description?: string;
	/** Default model for `kl run` (`provider/id`, optional `:thinking` suffix). */
	model?: string;
	/** Default thinking level for `kl run`. */
	thinking?: string;
	/**
	 * Agent identity prompt file. Default: `SYSTEM.md` in the agent dir if it
	 * exists. Resolved against `system_prompt_base`.
	 */
	system_prompt?: string;
	/** Dir `system_prompt` resolves against (dir of the config file that set it). */
	system_prompt_base: string;
	/** Named prompt sections rendered once at session start. */
	sections: SectionEntry[];
	/** false empties Pi's contextFiles (AGENTS.md / CLAUDE.md). Default true. */
	project_context: boolean;
	timestamps: TimestampConfig | false;

	// --- Keys read by modules outside this slice (messaging / lifecycle). ---
	// Recognized so they don't warn; not part of the minimal schema.

	/** Cleanup prompt (inline or `{ path }`) for /exit and exit_session. Empty = no cleanup turn. */
	cleanup: PromptSource;
	/** Inbox dir, relative to the agent home (the messaging slice moves inboxes to ~/.kl/run). */
	inbox_dir: string;
	/** Tool calls between `[Session state]` suffixes; 0 disables. */
	session_state_interval: number;
}

/**
 * Session-scoped runtime state, shared with per-feature modules.
 */
export interface SessionState {
	/** Resolved agent home (the agent folder). */
	agentHome: string;
	/** Session id (<name>-<adj>-<noun>). */
	agentId: string;
	/** Pi session UUID. Transcript-only; never shown in the prompt. */
	sessionUuid: string;
	config: AgentConfig;
	/** Env vars exported to spawned processes. */
	env: Record<string, string>;
	/**
	 * How this process was launched (fork via /spawn, or `kl resume`).
	 * Drives a one-time orientation reminder.
	 */
	sessionOrigin?: { kind: "fork" | "resume"; parentAgentId?: string };
}

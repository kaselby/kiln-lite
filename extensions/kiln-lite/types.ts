/**
 * Shared types for kiln-lite.
 */

/**
 * One `prompt.extra_sections` entry. Rendered once at session start into a
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

/**
 * The `prompt:` block, merged key by key across config.yml and agent.yml.
 */
export interface PromptConfig {
	/**
	 * Identity file, resolved against `identity_base`. Unset: IDENTITY.md in
	 * the agent folder if present, else the built-in identity.
	 */
	identity?: string;
	/** Dir `identity` resolves against (dir of the config file that set it). */
	identity_base: string;
	/** false drops kl's whole <harness> block: baseline, <tools>, <rules>. */
	include_kl_prompt: boolean;
	/** false drops Pi's <addendum> (APPEND_SYSTEM.md / --append-system-prompt). */
	include_appended_prompt: boolean;
	/** false drops Pi's <project_context> (AGENTS.md / CLAUDE.md). */
	include_project_context: boolean;
	/** Named sections rendered once at session start, after <session>. */
	extra_sections: SectionEntry[];
}

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
 * `agent.yml` overriding it key by key. Top-level keys replace, except
 * `prompt:`, which merges key by key one level down.
 */
export interface AgentConfig {
	/** Agent name — first component of <name>-<adj>-<noun> session ids. agent.yml only. */
	name: string;
	description?: string;
	/** Default model for `kl run` (`provider/id`, optional `:thinking` suffix). */
	model?: string;
	/** Default thinking level for `kl run`. */
	thinking?: string;
	/** The `prompt:` block: what goes into the system prompt. */
	prompt: PromptConfig;
	timestamps: TimestampConfig | false;

	// --- Keys read by modules outside this slice (messaging / lifecycle). ---
	// Recognized so they don't warn; not part of the minimal schema.

	/** Cleanup prompt (inline or `{ path }`) for /exit and exit_session. Empty = no cleanup turn. */
	cleanup: PromptSource;
	/** Tool calls between `[Session state]` suffixes; 0 disables. */
	session_state_interval: number;
	/** Load base pi's global extensions (~/.pi/agent/extensions) into kl agents. Default true. */
	pi_extensions: boolean;
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

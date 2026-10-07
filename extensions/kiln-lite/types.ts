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
	/** Named sections rendered once at session start, after <session>. */
	extra_sections: SectionEntry[];
}

/**
 * The `external:` block: things kl agents pick up from outside the agent and
 * kl. Merged key by key across config.yml and agent.yml, like `prompt:`.
 */
export interface ExternalConfig {
	/** Load base pi's global extensions (~/.pi/agent/extensions). */
	extensions: boolean;
	/**
	 * Load skills from outside the agent: base pi's ~/.pi/agent/skills (after
	 * the agent's) and Pi's own global, project and package skills. false
	 * passes --no-skills: only the agent's skills remain.
	 */
	skills: boolean;
	/** false drops Pi's <addendum> (APPEND_SYSTEM.md / --append-system-prompt). */
	appended_prompt: boolean;
	/** false drops Pi's <project_context> (AGENTS.md / CLAUDE.md). */
	project_context: boolean;
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
 * `prompt:` and `external:`, which merge key by key one level down.
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
	/** The `external:` block: base Pi extensions/skills, APPEND_SYSTEM.md, AGENTS.md. */
	external: ExternalConfig;
	timestamps: TimestampConfig | false;

	// --- Keys read by modules outside this slice (messaging / lifecycle). ---
	// Recognized so they don't warn; not part of the minimal schema.

	/** Cleanup prompt (inline or `{ path }`) for /cleanup and exit_session. Empty = no cleanup turn. */
	cleanup: PromptSource;
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
	 * How this process was launched (fork via /spawn, `kl resume`, or new),
	 * and the parent's name if the registry gives it one. Drives a one-time
	 * orientation reminder; unset for a new session without a parent.
	 */
	sessionOrigin?: { kind: "new" | "fork" | "resume"; subagentOf?: string };
}

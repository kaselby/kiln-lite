/**
 * Shared types for kiln-lite.
 */

export interface ContextInjectionEntry {
	/** Path relative to $AGENT_HOME. Mutually exclusive with `command`. */
	path?: string;
	/**
	 * Shell command whose stdout becomes the injected content. Executed with
	 * `sh -c` under the agent's env + cwd. Stderr is surfaced via the extension's
	 * warn channel; non-zero exit or timeout causes the entry to be skipped for
	 * that turn. Mutually exclusive with `path`.
	 */
	command?: string;
	/** Human-readable label for the injected section. */
	label: string;
	/**
	 * If true, re-read (path) or re-run (command) on every turn. Defaults to
	 * false. Dynamic entries cost prompt-cache reuse and, for commands, add
	 * per-turn latency — keep the command fast (<100ms).
	 */
	dynamic?: boolean;
}

export interface AgentConfig {
	/** Agent name — first component of <name>-<adj>-<noun> session IDs. */
	name: string;
	/** Optional system prompt file (path relative to $AGENT_HOME). Replaces Pi's base prompt. */
	system_prompt?: string;
	/** Ordered list of files to inject into the assembled system prompt. */
	context_injection: ContextInjectionEntry[];
	/** Shell commands run sequentially at session_start. */
	startup: string[];
	/**
	 * Cleanup prompt template. Supports {today}, {agent_id}, {session_uuid}, {summary_path}.
	 * If empty/unset, no cleanup turn is dispatched — session exits normally.
	 */
	cleanup: string;
	/** Directory for shell tool discovery (relative to $AGENT_HOME). */
	tools_dir: string;
	/** Directory for per-agent inboxes (relative to $AGENT_HOME). */
	inbox_dir: string;
	/** Directory for session summaries (relative to $AGENT_HOME). */
	sessions_dir: string;
	/**
	 * Tool calls between `[Session state] ...` suffixes appended to tool
	 * results. 0 disables the periodic status line. Default 15.
	 */
	session_state_interval: number;
}

/**
 * Session-scoped runtime state.
 * Owned by index.ts, shared with the per-feature modules.
 */
export interface SessionState {
	/** Resolved $AGENT_HOME. */
	agentHome: string;
	/** Agent ID for this session (<name>-<adj>-<noun>). */
	agentId: string;
	/** Pi session UUID. */
	sessionUuid: string;
	/** Loaded agent.yml (or defaults). */
	config: AgentConfig;
	/** Env vars exported to spawned scripts. */
	env: Record<string, string>;
	/** Cached static context-injection contents, keyed by path. */
	staticInjection: Map<string, string>;
	/**
	 * Cached system prompt base (either agent.yml system_prompt contents, or Pi's passed prompt).
	 * Set on first before_agent_start call.
	 */
	systemPromptBase: string | null;
	/**
	 * If non-null, the resumed system prompt to replay verbatim on every
	 * before_agent_start. Loaded at session_start when a snapshot exists
	 * for the resolved agent-id (i.e. we are resuming a prior session).
	 * Live (fresh) sessions leave this null and re-render each turn.
	 */
	cachedSystemPrompt: string | null;
	/**
	 * Whether the system-prompt.txt snapshot for this agent-id has been
	 * written to disk yet. Set true when we load an existing snapshot or
	 * when we write one at first compose. Prevents repeated writes.
	 */
	snapshotWritten: boolean;
	/** Template name applied to this session (from KL_TEMPLATE), if any. */
	template?: string;
}

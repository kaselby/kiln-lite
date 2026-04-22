/**
 * Shared types for kiln-lite.
 */

export interface ContextInjectionEntry {
	/** Path relative to $AGENT_HOME. */
	path: string;
	/** Human-readable label for the injected section. */
	label: string;
	/** If true, re-read file contents on every turn. Defaults to false. */
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
	/** Directory for session ID files + summaries (relative to $AGENT_HOME). */
	sessions_dir: string;
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
}

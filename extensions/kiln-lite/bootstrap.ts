/**
 * First-run auto-scaffold.
 *
 * On session_start, if `$AGENT_HOME` is set explicitly and the dir doesn't yet
 * have an `agent.yml`, we spawn the repo's `bootstrap.sh` to scaffold the
 * standard layout (memory/, tools/, skills/, venv/, etc). This makes
 * `pi install . && AGENT_HOME=~/my-agent pi` a single-step setup.
 *
 * Safety rails:
 *   - Never auto-scaffold when `AGENT_HOME` is unset (user is on the
 *     built-in default path). We don't want to silently create ~/.agent/.
 *   - Refuse if the target dir exists and has non-hidden content but no
 *     agent.yml — that's a "populated but not kiln-lite-shaped" state we
 *     shouldn't clobber. User runs bootstrap.sh manually with the flags
 *     they want.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export interface ScaffoldDeps {
	/** Resolved $AGENT_HOME. */
	agentHome: string;
	/** Whether AGENT_HOME was set by the env (true) or fell back to default (false). */
	explicitHome: boolean;
	/** UI hook for progress indication. Undefined in headless modes. */
	ui?: {
		notify: (msg: string, type?: "info" | "warning" | "error") => void;
		setWorkingMessage: (msg?: string) => void;
	};
	/** Warn sink — also used for info-level messages when no UI. */
	warn: (msg: string) => void;
}

/**
 * Check whether $AGENT_HOME needs scaffolding, and if so run bootstrap.sh.
 * Returns true if the home is ready for config loading (either was already
 * scaffolded or just got scaffolded); false if caller should fall back to
 * built-in defaults.
 */
export async function ensureScaffold(deps: ScaffoldDeps): Promise<boolean> {
	const { agentHome, explicitHome, ui, warn } = deps;
	const agentYml = join(agentHome, "agent.yml");
	if (existsSync(agentYml)) {
		return true;
	}

	if (!explicitHome) {
		warn(
			"kiln-lite: AGENT_HOME not set — using default with built-in config. " +
				"Set AGENT_HOME=<path> and relaunch to auto-scaffold an agent home.",
		);
		return false;
	}

	if (existsSync(agentHome)) {
		const visible = readdirSync(agentHome).filter((name) => !name.startsWith("."));
		if (visible.length > 0) {
			warn(
				`kiln-lite: ${agentHome} has content but no agent.yml — skipping auto-scaffold. ` +
					"Run bootstrap.sh --force to scaffold over existing content.",
			);
			return false;
		}
	}

	const bootstrapScript = resolveBootstrapScript();
	if (!bootstrapScript || !existsSync(bootstrapScript)) {
		warn(
			`kiln-lite: bootstrap.sh not found (looked near ${bootstrapScript ?? "package root"}) — cannot auto-scaffold.`,
		);
		return false;
	}

	if (ui) {
		ui.notify(`kiln-lite: first run — scaffolding ${agentHome} (this may take a few seconds)`, "info");
		ui.setWorkingMessage(`kiln-lite: scaffolding ${agentHome}`);
	} else {
		warn(`kiln-lite: first run — scaffolding ${agentHome}...`);
	}

	try {
		await spawnBootstrap(bootstrapScript, agentHome);
		if (ui) ui.notify(`kiln-lite: scaffold complete at ${agentHome}`, "info");
		return true;
	} catch (err) {
		warn(
			`kiln-lite: auto-scaffold failed: ${(err as Error).message}. ` +
				`Run '${bootstrapScript} ${agentHome}' manually and relaunch.`,
		);
		return false;
	} finally {
		if (ui) ui.setWorkingMessage();
	}
}

/**
 * Resolve bootstrap.sh relative to this module. Mirrors resolveBundledToolsDir
 * in index.ts — extensions/kiln-lite/bootstrap.ts → ../../bootstrap.sh.
 */
function resolveBootstrapScript(): string | null {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return resolve(here, "..", "..", "bootstrap.sh");
	} catch {
		return null;
	}
}

/** Spawn bootstrap.sh <agent-home> and resolve when it exits cleanly. */
function spawnBootstrap(script: string, agentHome: string): Promise<void> {
	return new Promise<void>((res, rej) => {
		const child = spawn("bash", [script, agentHome], {
			stdio: ["ignore", "inherit", "inherit"],
			env: process.env,
		});
		child.on("error", rej);
		child.on("close", (code) => {
			if (code === 0) res();
			else rej(new Error(`bootstrap exited with code ${code}`));
		});
	});
}

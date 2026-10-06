/**
 * kl launcher pieces: build the pi command line for an agent folder.
 *
 * Pure functions (tested in tests/launcher.test.ts) plus a tiny CLI that
 * bin/kl calls through tsx, so the bash launcher keeps tmux/attach logic
 * and this file owns config-driven decisions (it reads the same merged
 * ~/.kl/config.yml + agent.yml the extension reads).
 *
 *   tsx src/launcher.ts plan --home <agent home> [--resume] [--] [pi args...]
 *
 * Effects: creates <kl root>/pi on first use (ensureKlPiDir). Warnings go to
 * stderr. Stdout is NUL-terminated records:
 *   1. the Pi agent dir (value for PI_CODING_AGENT_DIR)
 *   2. the agent name (validated session-id prefix)
 *   3… the pi argv (without the pi binary; user args included, in order)
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveKlRoot, THINKING_LEVELS } from "../extensions/kiln-lite/config.ts";
import type { AgentConfig } from "../extensions/kiln-lite/types.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CORE_ENTRY = join(REPO_ROOT, "extensions", "kiln-lite", "index.ts");
/** kl's bundled skills (messaging), loaded for every agent instead of being copied in. */
export const CORE_SKILLS = join(REPO_ROOT, "skills");

/** Files shared with base pi by symlink (never copied). */
export const SHARED_PI_FILES = ["auth.json", "keybindings.json", "models.json"];

export interface EnsureResult {
	dir: string;
	/** What this call created (for logging); empty when everything existed. */
	created: string[];
}

/**
 * Create `<klRoot>/pi` if needed and symlink auth/keybindings/models to the
 * base pi agent dir when they exist there. Never overwrites, never copies,
 * never touches `basePiDir`. Pi writes its own settings.json.
 */
export function ensureKlPiDir(klRoot: string, basePiDir = join(homedir(), ".pi", "agent")): EnsureResult {
	const dir = join(klRoot, "pi");
	const created: string[] = [];
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		created.push(dir);
	}
	for (const f of SHARED_PI_FILES) {
		const target = join(basePiDir, f);
		const link = join(dir, f);
		if (!existsSync(target) || exists(link)) continue;
		symlinkSync(target, link);
		created.push(`${link} -> ${target}`);
	}
	return { dir, created };
}

/** lstat-based existence: a dangling symlink still counts (don't clobber it). */
function exists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Extension entry points in an extensions dir, in load order, the shapes Pi
 * auto-discovers (package-manager.js collectAutoExtensionEntries): `*.ts|*.js`
 * files, and per subdir its package.json `pi.extensions` list or else its
 * index.ts|index.js; sorted by entry name. kl passes each with its own -e so
 * order is deterministic. Not replicated: Pi's .gitignore filtering.
 */
export function discoverExtensions(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const p = join(dir, e.name);
		let isFile = e.isFile();
		let isDir = e.isDirectory();
		if (e.isSymbolicLink()) {
			try {
				const st = statSync(p);
				isFile = st.isFile();
				isDir = st.isDirectory();
			} catch {
				continue;
			}
		}
		if (isFile && /\.(ts|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
		else if (isDir) out.push(...packageEntries(p));
	}
	return out;
}

/** A subdir's entries: package.json `pi.extensions` (existing paths), else index.ts|index.js. */
function packageEntries(dir: string): string[] {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.pi?.extensions;
		if (Array.isArray(manifest)) {
			const found = manifest.filter((x): x is string => typeof x === "string").map((x) => resolve(dir, x)).filter((x) => existsSync(x));
			if (found.length > 0) return found;
		}
	} catch {
		// no package.json, or not JSON: fall through to index
	}
	for (const idx of ["index.ts", "index.js"]) if (existsSync(join(dir, idx))) return [join(dir, idx)];
	return [];
}

/** The agent's own Pi extensions: `<home>/extensions`. */
export function agentExtensions(agentHome: string): string[] {
	return discoverExtensions(join(agentHome, "extensions"));
}

/** Base pi's global extensions dir (~/.pi/agent/extensions), loaded into kl agents unless `pi_extensions: false`. */
export function basePiExtensionsDir(basePiDir = join(homedir(), ".pi", "agent")): string {
	return join(basePiDir, "extensions");
}

function hasFlag(args: string[], ...flags: string[]): boolean {
	return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
}

/** True if the user chose a thinking level: --thinking, or --model <id>:<level>. */
export function userSetsThinking(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--thinking" || a.startsWith("--thinking=")) return true;
		let model: string | undefined;
		if (a === "--model") model = args[i + 1];
		else if (a.startsWith("--model=")) model = a.slice("--model=".length);
		if (model && modelHasThinkingSuffix(model)) return true;
	}
	return false;
}

export function modelHasThinkingSuffix(model: string): boolean {
	const i = model.lastIndexOf(":");
	return i > 0 && THINKING_LEVELS.includes(model.slice(i + 1));
}

export interface BuildPiArgsOptions {
	agentHome: string;
	config: AgentConfig;
	userArgs: string[];
	/** Resume: skip model/thinking defaults (the transcript carries them). */
	resume?: boolean;
	coreEntry?: string;
	coreSkills?: string;
	/** Base pi agent dir, for its extensions/ (default ~/.pi/agent). */
	basePiDir?: string;
}

/**
 * pi argv: core -e (the only kl entry), base pi's global extensions
 * (unless pi_extensions: false), agent extensions, --skill
 * (kl's bundled skills, then the agent's),
 * model/thinking defaults the user didn't override, -a, then user args.
 */
export function buildPiArgs(opts: BuildPiArgsOptions): string[] {
	const { agentHome, config, userArgs } = opts;
	const args: string[] = ["-e", opts.coreEntry ?? CORE_ENTRY];
	if (config.pi_extensions) for (const ext of discoverExtensions(basePiExtensionsDir(opts.basePiDir))) args.push("-e", ext);
	for (const ext of agentExtensions(agentHome)) args.push("-e", ext);
	if (existsSync(opts.coreSkills ?? CORE_SKILLS)) args.push("--skill", opts.coreSkills ?? CORE_SKILLS);
	const skills = join(agentHome, "skills");
	if (existsSync(skills)) args.push("--skill", skills);

	if (!opts.resume) {
		let model: string | undefined;
		if (config.model && !hasFlag(userArgs, "--model")) {
			model = config.model;
			args.push("--model", model);
		}
		const modelSuffixed = model !== undefined && modelHasThinkingSuffix(model);
		if (config.thinking && !modelSuffixed && !userSetsThinking(userArgs)) {
			args.push("--thinking", config.thinking);
		}
	}
	// -a: pre-trust the launch dir so detached agents never block on pi's
	// project-trust prompt. Scoped to this run's cwd.
	args.push("-a");
	args.push(...userArgs);
	return args;
}

const AGENT_NAME = /^[a-z][a-z0-9_]*$/;

export interface Plan {
	piDir: string;
	agentName: string;
	args: string[];
	warnings: string[];
	created: string[];
}

export function plan(opts: { agentHome: string; userArgs: string[]; resume?: boolean; klRoot?: string; basePiDir?: string }): Plan {
	const warnings: string[] = [];
	const klRoot = opts.klRoot ?? resolveKlRoot();
	const config = loadConfig({ agentHome: opts.agentHome, klRoot, warn: (m) => warnings.push(m) });
	if (!AGENT_NAME.test(config.name)) {
		throw new Error(
			`agent name '${config.name}' (from ${opts.agentHome}) must match [a-z][a-z0-9_]* — session ids are <name>-<adj>-<noun>`,
		);
	}
	const { dir, created } = ensureKlPiDir(klRoot, opts.basePiDir);
	return {
		piDir: dir,
		agentName: config.name,
		args: buildPiArgs({ agentHome: opts.agentHome, config, userArgs: opts.userArgs, resume: opts.resume, basePiDir: opts.basePiDir }),
		warnings,
		created,
	};
}

function main(argv: string[]): number {
	const [cmd, ...rest] = argv;
	if (cmd === "pi-dir") {
		// `kl install`: the kl pi dir, created (with its defaults) if needed.
		const { dir, created } = ensureKlPiDir(resolveKlRoot());
		for (const c of created) process.stderr.write(`kl: created ${c}\n`);
		process.stdout.write(`${dir}\n`);
		return 0;
	}
	if (cmd !== "plan") {
		process.stderr.write("usage: launcher.ts plan --home <agent home> [--resume] [--] [pi args...]\n");
		return 2;
	}
	let agentHome: string | undefined;
	let resume = false;
	let i = 0;
	for (; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--home") agentHome = rest[++i];
		else if (a === "--resume") resume = true;
		else if (a === "--") {
			i++;
			break;
		} else break;
	}
	if (!agentHome) {
		process.stderr.write("launcher: --home is required\n");
		return 2;
	}
	let p: Plan;
	try {
		p = plan({ agentHome: resolve(agentHome), userArgs: rest.slice(i), resume });
	} catch (err) {
		process.stderr.write(`kl: ${(err as Error).message}\n`);
		return 1;
	}
	for (const w of p.warnings) process.stderr.write(`${w}\n`);
	for (const c of p.created) process.stderr.write(`kl: created ${c}\n`);
	process.stdout.write([p.piDir, p.agentName, ...p.args].map((s) => `${s}\0`).join(""));
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}

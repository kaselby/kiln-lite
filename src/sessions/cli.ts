/**
 * The session half of `kl`, called by bin/kl (which resolves the agent home;
 * launchNew runs the pre-launch hook):
 *
 *   run --home <home> [--detach|-d] [--prompt-file F] [--parent <name|uuid>] [--] [pi args...]
 *   resume <target>
 *   attach <target> [--detach|-d]
 *   sessions [<target>] [-n N] [--all] [--json]
 *
 * <target> is anything resolve.ts takes: a name, name@<id-prefix>, @<id-prefix>.
 * resume and attach are the same thing: resolve, wake if nothing is live,
 * then attach (or, with --detach, print the name).
 *
 * Inside a kl session (SESSION_UUID set) run, resume and attach always act
 * as --detach (guardDetach): an agent attaching from its bash tool breaks
 * its own terminal.
 */

import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { launchNew, wake } from "./launch.ts";
import { UUID_RE } from "./paths.ts";
import { readEntry } from "./registry.ts";
import { knownUuids, resolveTarget, ResolveError, shortId } from "./resolve.ts";
import { enter, guardDetach } from "./tmux.ts";
import { formatSessionDetail, formatSessionList, listSessions, sessionDetail } from "./view.ts";

function die(msg: string): never {
	process.stderr.write(`kl: ${msg}\n`);
	process.exit(1);
}

function info(msg: string): void {
	process.stderr.write(`kl: ${msg}\n`);
}


/** --parent: a full UUID with a registry entry, else anything resolveTarget takes. */
function resolveParent(target: string): string {
	if (UUID_RE.test(target) && target.includes("-") && readEntry(target)) return target;
	try {
		return resolveTarget(target).uuid;
	} catch (e) {
		if (e instanceof ResolveError) die(`--parent: ${e.message}`);
		throw e;
	}
}

function cmdRun(args: string[]): void {
	let home = "";
	let detach = false;
	let promptFile = "";
	let parent = "";
	const piArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const val = (flag: string): string => {
			if (i + 1 >= args.length) die(`${flag} needs a value`);
			return args[++i];
		};
		if (a === "--home") home = val(a);
		else if (a === "--detach" || a === "-d") detach = true;
		else if (a === "--prompt-file") promptFile = val(a);
		else if (a.startsWith("--prompt-file=")) promptFile = a.slice("--prompt-file=".length);
		else if (a === "--parent") parent = val(a);
		else if (a.startsWith("--parent=")) parent = a.slice("--parent=".length);
		else if (a === "--") {
			piArgs.push(...args.slice(i + 1));
			break;
		} else piArgs.push(a);
	}
	if (!home) die("run: --home is required (bin/kl passes it)");
	if (promptFile) {
		if (!existsSync(promptFile)) die(`--prompt-file: no such file: ${promptFile}`);
		// Last positional = the prompt (pi [options] [@files...] [messages...]). Never goes through a shell.
		piArgs.push(readFileSync(promptFile, "utf8"));
	}
	const guard = guardDetach(detach);
	if (guard.note) info(guard.note);
	detach = guard.detach;
	const parentUuid = parent ? resolveParent(parent) : undefined;
	let name: string;
	try {
		name = launchNew({ home, piArgs, parent: parentUuid, warn: (w) => info(w) });
	} catch (e) {
		die((e as Error).message);
	}
	if (detach) {
		info(`spawned ${name} (detached)`);
		process.stdout.write(`${name}\n`);
		return;
	}
	info(`spawned ${name}`);
	process.exit(enter(name));
}

/**
 * resume: start a stopped session again, exactly as it was (no pi args), in
 * the background, and print its name. Never attaches.
 * attach: attach to a running session; a stopped one asks first (y/N), and
 * without a terminal to ask in it is an error.
 */
async function cmdResume(verb: string, args: string[]): Promise<void> {
	let detach = false;
	let target = "";
	for (const a of args) {
		if (verb === "attach" && (a === "--detach" || a === "-d")) detach = true;
		else if (!target && !a.startsWith("-")) target = a;
		else die(`${verb}: unexpected argument '${a}' (${verb === "attach" ? "attach takes <session> [-d]" : "resume takes <session>"})`);
	}
	if (!target) die(`${verb} needs a session name (see kl sessions)`);
	const guard = verb === "resume" ? { detach: true, note: "" } : guardDetach(detach);
	if (guard.note) info(guard.note);
	detach = guard.detach;
	let r;
	try {
		r = resolveTarget(target);
	} catch (e) {
		if (e instanceof ResolveError) die(e.message);
		throw e;
	}
	if (r.note) info(r.note);
	let name = r.name;
	if (!r.lease) {
		if (!r.entry) die(`${target} is not running and has no registry entry`);
		if (verb === "attach" && !(await confirmResume(name))) process.exit(1);
		try {
			const w = await wake(r.uuid, { log: info });
			name = w.name;
			info(w.started ? `woke ${name} (${shortId(r.uuid, knownUuids())})` : `${name} was already running`);
		} catch (e) {
			die((e as Error).message);
		}
	} else if (verb === "resume") info(`${name} is already running`);
	if (detach) {
		process.stdout.write(`${name}\n`);
		return;
	}
	process.exit(enter(name));
}

/** attach on a stopped session: ask on the terminal; no terminal → error. */
async function confirmResume(name: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.SESSION_UUID) {
		die(`${name} isn't running; kl resume ${name} starts it`);
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(`${name} isn't running. Resume it? [y/N] `);
		return /^y(es)?$/i.test(answer.trim());
	} catch {
		// Ctrl+D or Ctrl+C at the prompt: no.
		process.stderr.write("\n");
		return false;
	} finally {
		rl.close();
	}
}

function cmdSessions(args: string[]): void {
	let limit = 20;
	let all = false;
	let json = false;
	let target = "";
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--all") (limit = Infinity), (all = true);
		else if (a === "-n") {
			const n = Number(args[++i]);
			if (!Number.isInteger(n) || n <= 0) die(`sessions: -n needs a positive number`);
			limit = n;
		} else if (a === "--json") json = true;
		else if (!a.startsWith("-") && !target) target = a;
		else die(`sessions: unknown argument '${a}'`);
	}
	if (target) {
		let d;
		try {
			d = sessionDetail(target);
		} catch (e) {
			if (e instanceof ResolveError) die(e.message);
			throw e;
		}
		if (d.note) info(d.note);
		console.log(json ? JSON.stringify(d, null, 2) : formatSessionDetail(d));
		return;
	}
	const list = listSessions({ limit, all, self: process.env.SESSION_UUID || undefined });
	console.log(json ? JSON.stringify(list, null, 2) : formatSessionList(list));
}

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "run":
			return cmdRun(rest);
		case "resume":
		case "attach":
			return cmdResume(cmd, rest);
		case "sessions":
			return cmdSessions(rest);
		default:
			die(`unknown session command '${cmd ?? ""}'`);
	}
}

void main(process.argv.slice(2));

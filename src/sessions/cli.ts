/**
 * The session half of `kl`, called by bin/kl (which resolves the agent home;
 * launchNew runs the pre-launch hook):
 *
 *   run --home <home> [--detach|-d] [--prompt-file F] [--parent <name|uuid>] [--wake park|auto] [--] [pi args...]
 *   resume <target> [--detach|-d] [pi args...]
 *   attach <target> [--detach|-d]
 *   sessions [<target>] [-n N] [--all] [--json]
 *   inbox <target>
 *
 * <target> is anything resolve.ts takes: a name, name@<id-prefix>, @<id-prefix>.
 * resume and attach are the same thing: resolve, wake if nothing is live,
 * then attach (or, with --detach, print the name).
 *
 * Inside a kl session (SESSION_UUID set) run, resume and attach always act
 * as --detach (guardDetach): an agent attaching from its bash tool breaks
 * its own terminal.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { launchNew, wake } from "./launch.ts";
import { parseFrontmatter } from "../client/messages.ts";
import { inboxDir, UUID_RE } from "./paths.ts";
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
	let wakeMode: "park" | "auto" | undefined;
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
		else if (a === "--wake" || a.startsWith("--wake=")) {
			const v = a === "--wake" ? val(a) : a.slice("--wake=".length);
			if (v !== "park" && v !== "auto") die(`--wake must be park or auto, not '${v}'`);
			wakeMode = v;
		} else if (a === "--") {
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
		name = launchNew({ home, piArgs, parent: parentUuid, wake: wakeMode, warn: (w) => info(w) });
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

/** resume and attach: resolve → wake if not live → attach (or print the name with --detach). */
function cmdResume(verb: string, args: string[]): void {
	let detach = false;
	let target = "";
	const piArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--detach" || a === "-d") detach = true;
		else if (a === "--") {
			piArgs.push(...args.slice(i + 1));
			break;
		} else if (!target) target = a;
		else piArgs.push(a);
	}
	if (!target) die(`${verb} needs a session name (see kl sessions)`);
	if (verb === "attach" && piArgs.length) die("attach takes no pi args; use kl resume <name> [pi args]");
	const guard = guardDetach(detach);
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
	if (r.lease) {
		if (piArgs.length) info(`${name} is already running; ignoring pi args`);
	} else {
		if (!r.entry) die(`${target} has a live lease but no registry entry`);
		try {
			const w = wake(r.uuid, { piArgs, log: info });
			name = w.name;
			info(w.started ? `woke ${name} (${shortId(r.uuid, knownUuids())})` : `${name} was already running`);
		} catch (e) {
			die((e as Error).message);
		}
	}
	if (detach) {
		process.stdout.write(`${name}\n`);
		return;
	}
	process.exit(enter(name));
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

function cmdInbox(args: string[]): void {
	const target = args[0];
	if (!target) die("inbox needs a session name");
	let r;
	try {
		r = resolveTarget(target);
	} catch (e) {
		if (e instanceof ResolveError) die(e.message);
		throw e;
	}
	if (r.note) info(r.note);
	const dir = inboxDir(r.uuid);
	console.log(`${r.name} (${shortId(r.uuid, knownUuids())}${r.lease ? ", running" : ", not running"}): ${dir}`);
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	} catch {
		// no inbox yet
	}
	if (files.length === 0) {
		console.log("(empty)");
		return;
	}
	for (const f of files) {
		const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8")).fields;
		const read = existsSync(join(dir, `${f.slice(0, -3)}.read`));
		console.log(`${read ? "    " : "new "} ${f}  from ${fm.from ?? "?"}: ${fm.summary ?? ""}`);
	}
}

function main(argv: string[]): void {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "run":
			return cmdRun(rest);
		case "resume":
		case "attach":
			return cmdResume(cmd, rest);
		case "sessions":
			return cmdSessions(rest);
		case "inbox":
			return cmdInbox(rest);
		default:
			die(`unknown session command '${cmd ?? ""}'`);
	}
}

main(process.argv.slice(2));

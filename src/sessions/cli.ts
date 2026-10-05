/**
 * The session half of `kl`, called by bin/kl (which resolves the agent home;
 * launchNew runs the pre-launch hook):
 *
 *   run --home <home> [--detach|-d] [--prompt-file F] [--parent <name|uuid>] [--wake park|auto] [--] [pi args...]
 *   resume <target> [--detach|-d] [pi args...]
 *   attach <target> [--detach|-d]
 *   sessions [-n N] [--all]
 *   inbox <target>
 *
 * <target> is anything resolve.ts takes: a name, name@<id-prefix>, @<id-prefix>.
 * resume and attach are the same thing: resolve, wake if nothing is live,
 * then attach (or, with --detach, print the name).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { launchNew, wake } from "./launch.ts";
import { liveLeases } from "./lease.ts";
import { inboxDir, klRoot, UUID_RE } from "./paths.ts";
import { lastSeen, listEntries, visibleEntries, readEntry, type RegistryEntry } from "./registry.ts";
import { knownUuids, resolveTarget, ResolveError, shortId } from "./resolve.ts";
import { enter } from "./tmux.ts";

function die(msg: string): never {
	process.stderr.write(`kl: ${msg}\n`);
	process.exit(1);
}

function info(msg: string): void {
	process.stderr.write(`kl: ${msg}\n`);
}


function fmtTime(d: Date | null): string {
	if (!d) return "-";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
	let showAll = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--all") (limit = Infinity), (showAll = true);
		else if (args[i] === "-n") limit = Number(args[++i]) || limit;
		else die(`sessions: unknown argument '${args[i]}'`);
	}
	const live = liveLeases();
	// No transcript = never exchanged a message: hidden unless live or --all.
	const listed = listEntries();
	const entries = showAll ? listed : visibleEntries(listed, live);
	const hidden = listed.length - entries.length;
	if (entries.length === 0) {
		console.log(hidden ? `(${hidden} never started a conversation; kl sessions --all)` : `(no sessions in ${join(klRoot(), "run", "sessions")})`);
		return;
	}
	// Short ids stay unique against hidden entries too (resolve.ts sees them).
	const all = [...new Set([...listed.map((e) => e.uuid), ...live.keys()])];
	const ids = new Map(entries.map((e) => [e.uuid, shortId(e.uuid, all)]));
	const idWidth = Math.max(8, ...[...ids.values()].map((id) => id.length));
	const seen = new Map<string, Date | null>(entries.map((e) => [e.uuid, lastSeen(e)]));
	const recency = (e: RegistryEntry): number => (seen.get(e.uuid) ?? new Date(e.created)).getTime() || 0;
	const byUuid = new Map(entries.map((e) => [e.uuid, e]));
	const children = new Map<string, RegistryEntry[]>();
	const roots: RegistryEntry[] = [];
	for (const e of entries) {
		if (e.parent && byUuid.has(e.parent) && e.parent !== e.uuid) {
			const list = children.get(e.parent) ?? [];
			list.push(e);
			children.set(e.parent, list);
		} else roots.push(e);
	}
	// A tree is as recent as its most recent member.
	const treeRecency = (e: RegistryEntry, depth = 0): number =>
		depth > 50 ? recency(e) : Math.max(recency(e), ...(children.get(e.uuid) ?? []).map((c) => treeRecency(c, depth + 1)));
	roots.sort((a, b) => treeRecency(b) - treeRecency(a));

	console.log(`  ${"NAME".padEnd(28)} ${"STATE".padEnd(6)} ${"LAST SEEN".padEnd(16)} ${"ID".padEnd(idWidth)}  CWD`);
	const printed = new Set<string>();
	const print = (e: RegistryEntry, depth: number): void => {
		if (printed.has(e.uuid)) return;
		printed.add(e.uuid);
		const l = live.get(e.uuid);
		const mark = l ? "*" : " ";
		const label = `${"  ".repeat(depth)}${depth ? "└ " : ""}${l?.name ?? e.name}`;
		const state = l ? l.state : "-";
		console.log(`${mark} ${label.padEnd(28)} ${state.padEnd(6)} ${fmtTime(seen.get(e.uuid) ?? null).padEnd(16)} ${ids.get(e.uuid)!.padEnd(idWidth)}  ${e.cwd}`);
		const kids = (children.get(e.uuid) ?? []).sort((a, b) => recency(b) - recency(a));
		for (const c of kids) print(c, depth + 1);
	};
	const shown = roots.slice(0, limit);
	for (const r of shown) print(r, 0);
	if (shown.length < roots.length) console.log(`(${roots.length - shown.length} older; kl sessions --all)`);
	if (hidden) console.log(`(${hidden} never started a conversation; kl sessions --all)`);
	console.log("* = running. Reach one by name, or name@<id> when a name was reused.");
}

function frontmatter(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!text.startsWith("---")) return out;
	for (const line of text.split("\n").slice(1)) {
		if (line.trim() === "---") break;
		const i = line.indexOf(":");
		if (i === -1) continue;
		let v = line.slice(i + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		out[line.slice(0, i).trim()] = v;
	}
	return out;
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
		const fm = frontmatter(readFileSync(join(dir, f), "utf8"));
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

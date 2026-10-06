/**
 * `kl message`: messaging from a shell (bin/kl runs this file with tsx).
 * Inside a session it acts as that session; agents normally use the
 * `message` tool, which calls the same library functions (messages.ts,
 * DaemonClient). Without SESSION_UUID it acts as the human, $USER.
 *
 *   kl message send <session|#channel> <summary> [--body <text> | --body-stdin] [--priority normal|high]
 *   kl message subscribe <channel>
 *   kl message unsubscribe <channel>
 *   kl message channels [--json]
 *   kl message history <session|#channel> [-n N] [--follow] [--json]
 *   kl message status [--json]
 *
 * --json: channels prints a JSON array; history prints JSON Lines (one
 * message object per line), so --follow streams the same shape; status
 * prints an object.
 *
 * Env (set by kl in every agent process):
 *   SESSION_UUID  this session's UUID (its identity). Unset: you are $USER.
 *   AGENT_ID      this session's name (required with SESSION_UUID)
 *   AGENT_NAME    agent name (optional; default: first segment of AGENT_ID)
 */

import { readFileSync } from "node:fs";

import { inboxRoot } from "../sessions/paths.ts";
import { DaemonClient } from "./index.ts";
import {
	channelName,
	followHistory,
	formatChannels,
	formatHistory,
	formatMessage,
	listChannels,
	readHistory,
	resolveHistoryTarget,
	ResolveError,
	validChannel,
	type HistoryTarget,
} from "./messages.ts";

const USAGE = `kl message: send and read messages between sessions

Usage:
  kl message send <session|#channel> <summary> [--body <text> | --body-stdin] [--priority normal|high]
  kl message subscribe <channel>
  kl message unsubscribe <channel>
  kl message channels [--json]
  kl message history <session|#channel> [-n N] [--follow] [--json]
  kl message status [--json]

  send         a DM to a session (by name, as in kl sessions), or #channel
               to everyone subscribed to it
  channels     every channel, with subscribers and message counts
               (* = this session subscribes)
  history      a channel's history, or the mail in a session's inbox,
               oldest first; -n N = the last N (default 20, 0 = all);
               --follow (-f) keeps printing new messages until interrupted
  --json       machine-readable: channels and status print JSON; history
               prints one JSON object per message per line

Inside a kl session you act as that session. From your own shell (no
SESSION_UUID) you act as $USER: send works; subscribe and unsubscribe need
a session.
`;

function die(msg: string): never {
	process.stderr.write(`kl message: ${msg}\n`);
	process.exit(2);
}

/** Outside a session: the human, $USER. No registry entry, so no from_session and no agent-mail disclaimer. */
function humanClient(): DaemonClient {
	const user = process.env.USER || process.env.LOGNAME || "user";
	return new DaemonClient({ requester: { agent: "human", session: `human-${user}`, name: user } });
}

function makeClient(cmd: string): DaemonClient {
	const session = process.env.SESSION_UUID;
	if (!session) {
		if (cmd === "subscribe" || cmd === "unsubscribe") die(`${cmd} needs a kl session (SESSION_UUID not set)`);
		return humanClient();
	}
	const name = process.env.AGENT_ID;
	if (!name) die("AGENT_ID not set (it comes with SESSION_UUID)");
	const agent = process.env.AGENT_NAME ?? name.split("-")[0] ?? "agent";
	return new DaemonClient({ requester: { agent, session, name, inbox_path: inboxRoot() } });
}

interface Parsed {
	positional: string[];
	flags: Record<string, string | boolean>;
}

/** `spec` maps a flag (with dashes) to its kind; unknown flags are an error. */
function parseArgs(argv: string[], spec: Record<string, "string" | "bool">): Parsed {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
			const kind = spec[a];
			if (!kind) die(`unknown flag ${a}`);
			if (kind === "bool") flags[a] = true;
			else {
				if (i + 1 >= argv.length) die(`${a} needs a value`);
				flags[a] = argv[++i];
			}
		} else positional.push(a);
	}
	return { positional, flags };
}

function resolveOrDie(target: string): HistoryTarget {
	try {
		return resolveHistoryTarget(target);
	} catch (e) {
		if (e instanceof ResolveError) die(e.message);
		throw e;
	}
}

const out = (s: string): void => {
	process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
};

async function main(argv: string[]): Promise<void> {
	const [cmd, ...rest] = argv;
	if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
		process.stdout.write(USAGE);
		process.exit(cmd ? 0 : 2);
	}

	switch (cmd) {
		case "send": {
			const { positional, flags } = parseArgs(rest, { "--body": "string", "--body-stdin": "bool", "--priority": "string" });
			const [to, ...words] = positional;
			const summary = words.join(" ");
			if (!to || !summary) die("send needs <session|#channel> <summary>");
			const body = flags["--body-stdin"] ? readFileSync(0, "utf8") : ((flags["--body"] as string | undefined) ?? "");
			const p = flags["--priority"];
			if (p !== undefined && p !== "normal" && p !== "high") die(`--priority must be normal or high, not '${p}'`);
			const priority = p === "high" ? "high" : "normal";
			const client = makeClient(cmd);
			if (to.startsWith("#")) {
				const channel = to.slice(1);
				if (!validChannel(channel)) die(`bad channel name '${to}'`);
				const n = await client.publish(channel, summary, body, priority);
				out(`sent to #${channel} (${n} recipient${n === 1 ? "" : "s"})`);
			} else {
				out(await client.sendDirect(to, summary, body, priority));
			}
			return;
		}
		case "subscribe":
		case "unsubscribe": {
			const { positional } = parseArgs(rest, {});
			const channel = channelName(positional[0] ?? "");
			if (!channel) die(`${cmd} needs <channel>`);
			if (!validChannel(channel)) die(`bad channel name '${positional[0]}'`);
			const client = makeClient(cmd);
			if (cmd === "subscribe") {
				const n = await client.subscribe(channel);
				out(`subscribed to #${channel} (${n} subscriber${n === 1 ? "" : "s"})`);
			} else {
				await client.unsubscribe(channel);
				out(`unsubscribed from #${channel}`);
			}
			return;
		}
		case "channels": {
			const { flags } = parseArgs(rest, { "--json": "bool" });
			const list = listChannels({ self: process.env.SESSION_UUID || undefined });
			out(flags["--json"] ? JSON.stringify(list, null, 2) : formatChannels(list));
			return;
		}
		case "history": {
			const { positional, flags } = parseArgs(rest, { "-n": "string", "--follow": "bool", "-f": "bool", "--json": "bool" });
			if (!positional[0]) die("history needs <session|#channel>");
			if (positional.length > 1) die(`history takes one target, got: ${positional.join(" ")}`);
			const nRaw = flags["-n"];
			const n = nRaw === undefined ? 20 : Number(nRaw);
			if (!Number.isInteger(n) || n < 0) die(`-n must be a whole number, not '${nRaw}'`);
			const target = resolveOrDie(positional[0]);
			if (target.kind === "session" && target.note) process.stderr.write(`kl message: ${target.note}\n`);
			const json = !!flags["--json"];
			const msgs = readHistory(target, { limit: n === 0 ? undefined : n });
			if (json) for (const m of msgs) out(JSON.stringify(m));
			else out(formatHistory(target, msgs));
			if (flags["--follow"] || flags["-f"]) {
				const stop = followHistory(target, (m) => out(json ? JSON.stringify(m) : `\n${formatMessage(m)}`));
				const quit = () => {
					stop();
					process.exit(0);
				};
				process.on("SIGINT", quit);
				process.on("SIGTERM", quit);
				// The poll timer keeps the process alive.
			}
			return;
		}
		case "status": {
			const { flags } = parseArgs(rest, { "--json": "bool" });
			const status = await makeClient(cmd).getStatus();
			if (flags["--json"]) out(JSON.stringify(status, null, 2));
			else for (const [k, v] of Object.entries(status)) out(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
			return;
		}
		default:
			die(`unknown command '${cmd}' (kl message --help)`);
	}
}

main(process.argv.slice(2)).catch((err) => {
	process.stderr.write(`kl message: ${(err as Error).message}\n`);
	process.exit(1);
});

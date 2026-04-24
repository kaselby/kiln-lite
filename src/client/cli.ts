#!/usr/bin/env -S npx tsx
/**
 * kl-msg — thin CLI wrapper around DaemonClient.
 *
 * Invoked from the bash `message` script (and usable standalone) for
 * daemon-bound operations: send DMs, publish/subscribe to channels, query
 * subscriptions and sessions. File-based operations (read, list, clear,
 * stats) stay in the bash script — those paths read files directly and
 * don't need the daemon.
 *
 * Subcommands:
 *   kl-msg send <to> <summary> [--body-stdin | --body <text>] [--priority normal|high]
 *   kl-msg publish <channel> <summary> [--body-stdin | --body <text>] [--priority ...]
 *   kl-msg subscribe <channel>
 *   kl-msg unsubscribe <channel>
 *   kl-msg list-subscriptions
 *   kl-msg list-sessions [--agent NAME]
 *   kl-msg status
 *
 * Required env:
 *   AGENT_ID    this session's id
 *   AGENT_HOME  this session's home dir
 *   INBOX_DIR   inbox dir name under AGENT_HOME (default: inbox)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DaemonClient } from "./index.ts";

function envOrDie(name: string): string {
    const v = process.env[name];
    if (!v) {
        process.stderr.write(`kl-msg: ${name} not set\n`);
        process.exit(2);
    }
    return v;
}

function makeClient(): DaemonClient {
    const agent_name = process.env.AGENT_NAME ?? inferAgentName(envOrDie("AGENT_ID"));
    const agent_home = envOrDie("AGENT_HOME");
    const inbox_dir = process.env.INBOX_DIR ?? "inbox";
    return new DaemonClient({
        requester: {
            agent: agent_name,
            session: envOrDie("AGENT_ID"),
            inbox_path: join(agent_home, inbox_dir),
        },
    });
}

function inferAgentName(agent_id: string): string {
    // agent_id shape: <name>-<adj>-<noun>[-<suffix>]. Everything up to the
    // first `-<adj>` is the name. We don't have the adjective pool handy
    // here, so take the first segment. For the default "agent" name this
    // works; if a deployment picks something hyphenated, set $AGENT_NAME.
    return agent_id.split("-")[0] ?? "agent";
}

function readBody(flags: { body?: string; stdin?: boolean }): string {
    if (flags.stdin) return readFileSync(0, "utf8");
    return flags.body ?? "";
}

interface ParsedArgs {
    positional: string[];
    flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[], flagSpec: Record<string, "string" | "bool">): ParsedArgs {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const kind = flagSpec[key];
            if (!kind) {
                process.stderr.write(`kl-msg: unknown flag --${key}\n`);
                process.exit(2);
            }
            if (kind === "bool") {
                flags[key] = true;
            } else {
                flags[key] = argv[++i] ?? "";
            }
        } else {
            positional.push(a);
        }
    }
    return { positional, flags };
}

async function main(): Promise<void> {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd || cmd === "-h" || cmd === "--help") {
        printUsage();
        process.exit(cmd ? 0 : 2);
    }

    const client = makeClient();

    switch (cmd) {
        case "send": {
            const { positional, flags } = parseArgs(rest, {
                body: "string",
                "body-stdin": "bool",
                priority: "string",
            });
            const [to, ...summaryParts] = positional;
            const summary = summaryParts.join(" ");
            if (!to || !summary) die("send requires <to> <summary>");
            const body = readBody({
                body: flags.body as string | undefined,
                stdin: flags["body-stdin"] as boolean | undefined,
            });
            const priority = (flags.priority === "high" ? "high" : "normal") as "normal" | "high";
            await client.sendDirect(to, summary, body, priority);
            process.stdout.write(`sent -> ${to}\n`);
            return;
        }
        case "publish": {
            const { positional, flags } = parseArgs(rest, {
                body: "string",
                "body-stdin": "bool",
                priority: "string",
            });
            const [channel, ...summaryParts] = positional;
            const summary = summaryParts.join(" ");
            if (!channel || !summary) die("publish requires <channel> <summary>");
            const body = readBody({
                body: flags.body as string | undefined,
                stdin: flags["body-stdin"] as boolean | undefined,
            });
            const priority = (flags.priority === "high" ? "high" : "normal") as "normal" | "high";
            const count = await client.publish(channel, summary, body, priority);
            process.stdout.write(`published to #${channel} (${count} recipient${count === 1 ? "" : "s"})\n`);
            return;
        }
        case "subscribe": {
            const { positional } = parseArgs(rest, {});
            const [channel] = positional;
            if (!channel) die("subscribe requires <channel>");
            const count = await client.subscribe(channel);
            process.stdout.write(`subscribed to #${channel} (${count} total subscriber${count === 1 ? "" : "s"})\n`);
            return;
        }
        case "unsubscribe": {
            const { positional } = parseArgs(rest, {});
            const [channel] = positional;
            if (!channel) die("unsubscribe requires <channel>");
            await client.unsubscribe(channel);
            process.stdout.write(`unsubscribed from #${channel}\n`);
            return;
        }
        case "list-subscriptions": {
            const channels = await client.listSubscriptions();
            if (channels.length === 0) {
                process.stdout.write("(no subscriptions)\n");
            } else {
                for (const c of channels) process.stdout.write(`#${c}\n`);
            }
            return;
        }
        case "list-sessions": {
            const { flags } = parseArgs(rest, { agent: "string" });
            const sessions = await client.listSessions({ agent: flags.agent as string | undefined });
            if (sessions.length === 0) {
                process.stdout.write("(no sessions)\n");
            } else {
                for (const s of sessions) {
                    process.stdout.write(
                        `${s.session_id}\t${s.agent_name}\tpid=${s.pid}\t${s.status}\t${s.last_seen_at}\n`,
                    );
                }
            }
            return;
        }
        case "status": {
            const status = await client.getStatus();
            for (const [k, v] of Object.entries(status)) {
                process.stdout.write(`${k}: ${JSON.stringify(v)}\n`);
            }
            return;
        }
        default:
            die(`unknown subcommand: ${cmd}`);
    }
}

function die(msg: string): never {
    process.stderr.write(`kl-msg: ${msg}\n`);
    process.exit(2);
}

function printUsage(): void {
    process.stdout.write(
        [
            "kl-msg — kiln-lite daemon CLI",
            "",
            "Usage:",
            "  kl-msg send <to> <summary> [--body <text> | --body-stdin] [--priority normal|high]",
            "  kl-msg publish <channel> <summary> [--body <text> | --body-stdin] [--priority ...]",
            "  kl-msg subscribe <channel>",
            "  kl-msg unsubscribe <channel>",
            "  kl-msg list-subscriptions",
            "  kl-msg list-sessions [--agent NAME]",
            "  kl-msg status",
            "",
            "Env:",
            "  AGENT_ID    this session's id (required)",
            "  AGENT_HOME  this session's home dir (required)",
            "  INBOX_DIR   inbox dir name (default: inbox)",
            "  AGENT_NAME  agent name for requester envelope",
            "              (default: first segment of AGENT_ID)",
            "",
        ].join("\n"),
    );
}

main().catch((err) => {
    process.stderr.write(`kl-msg: ${(err as Error).message}\n`);
    process.exit(1);
});

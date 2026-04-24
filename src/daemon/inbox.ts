/**
 * Inbox + channel history writers.
 *
 * Matches the existing kiln-lite message file format so that
 * `skills/messaging/scripts/message read/list/stats` continue to work
 * unchanged: those paths read files directly, while the daemon just takes
 * over writing them.
 *
 * File layout:
 *
 *   <recipient_inbox_root>/<recipient_id>/<YYYYMMDDTHHMMSSZ>-<rand>.md
 *
 *   ---
 *   from: <sender_session_id>
 *   to:   <recipient_session_id>
 *   summary: "..."
 *   timestamp: YYYY-MM-DDTHH:MM:SSZ
 *   priority: normal|high
 *   channel: <optional — present for channel messages>
 *   ---
 *
 *   <body>
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function compactTimestamp(date: Date = new Date()): string {
    // 20260422T170800Z — matches mkid() in skills/messaging/scripts/message
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
    );
}

function isoTimestamp(date: Date = new Date()): string {
    return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/** YAML-escape a scalar for safe inclusion in `summary: "..."`. */
function escapeYamlScalar(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

export interface WriteInboxOptions {
    /** Root directory that holds per-recipient inbox dirs. Typically
     *  `<recipient's agent_home>/inbox`. */
    inboxRoot: string;
    recipient: string;
    sender: string;
    summary: string;
    body: string;
    priority?: "normal" | "high";
    channel?: string;
}

/** Write a single message file to a recipient's inbox. Returns the file path. */
export function writeInboxMessage(opts: WriteInboxOptions): string {
    const priority = opts.priority ?? "normal";
    const now = new Date();
    const dir = join(opts.inboxRoot, opts.recipient);
    mkdirSync(dir, { recursive: true });

    const id = `${compactTimestamp(now)}-${randomBytes(8).toString("hex")}`;
    const filePath = join(dir, `${id}.md`);

    const frontmatter = [
        "---",
        `from: ${opts.sender}`,
        `to: ${opts.recipient}`,
        `summary: "${escapeYamlScalar(opts.summary)}"`,
        `timestamp: ${isoTimestamp(now)}`,
        `priority: ${priority}`,
    ];
    if (opts.channel) frontmatter.push(`channel: ${opts.channel}`);
    frontmatter.push("---", "");

    const content = frontmatter.join("\n") + "\n" + opts.body + "\n";
    writeFileSync(filePath, content);
    return filePath;
}

export interface AppendHistoryOptions {
    channelsDir: string;
    channel: string;
    sender: string;
    summary: string;
    body: string;
    priority?: "normal" | "high";
}

/**
 * Append a message to the shared channel history file. Anyone can read
 * the full history, including subscribers who joined after the message
 * was posted.
 */
export function appendChannelHistory(opts: AppendHistoryOptions): void {
    const priority = opts.priority ?? "normal";
    const channelDir = join(opts.channelsDir, opts.channel);
    mkdirSync(channelDir, { recursive: true });
    const entry = {
        ts: isoTimestamp(),
        from: opts.sender,
        summary: opts.summary,
        body: opts.body,
        priority,
    };
    appendFileSync(join(channelDir, "history.jsonl"), JSON.stringify(entry) + "\n");
}

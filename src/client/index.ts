/**
 * Daemon client — send requests to the kiln-lite daemon.
 *
 * One request per connection: open socket, send one JSON line, read one
 * JSON line back, close. This matches the daemon's handler model (see
 * daemon/index.ts).
 *
 * On first request, if the daemon isn't running, `autostart` spawns one
 * in the background. Subsequent requests reuse the existing daemon.
 *
 * Callers wrap this with a protocol request builder:
 *   const client = new DaemonClient({ agent, session, inbox_path });
 *   await client.subscribe("build-chatter");
 *   const status = await client.call(proto.getStatus());
 */

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import * as proto from "../daemon/protocol.ts";
import { autostartDaemon } from "./autostart.ts";

function defaultSocketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return join(runtime, "kiln-lite.sock");
    return `/tmp/kiln-lite-${process.getuid?.() ?? "nouid"}.sock`;
}

function defaultStateDir(): string {
    return join(homedir(), ".kl", "daemon");
}

export interface DaemonClientOptions {
    requester: proto.Requester;
    socketPath?: string;
    stateDir?: string;
    /** Timeout (ms) for a single request. Default 5000. */
    timeoutMs?: number;
    /** If true, autostart the daemon when the socket isn't up. Default true. */
    autostart?: boolean;
}

export class DaemonClient {
    readonly socketPath: string;
    readonly stateDir: string;
    readonly requester: proto.Requester;
    private timeoutMs: number;
    private shouldAutostart: boolean;

    constructor(opts: DaemonClientOptions) {
        this.requester = opts.requester;
        this.socketPath = opts.socketPath ?? defaultSocketPath();
        this.stateDir = opts.stateDir ?? defaultStateDir();
        this.timeoutMs = opts.timeoutMs ?? 5000;
        this.shouldAutostart = opts.autostart ?? true;
    }

    /**
     * Low-level: send a raw Message and await the response.
     * Retries once with autostart if the initial connection is refused.
     */
    async call(msg: proto.Message): Promise<proto.Message> {
        try {
            return await this.sendOnce(msg);
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException | null)?.code;
            if ((code === "ENOENT" || code === "ECONNREFUSED") && this.shouldAutostart) {
                await autostartDaemon({ socketPath: this.socketPath, stateDir: this.stateDir });
                return this.sendOnce(msg);
            }
            throw err;
        }
    }

    private sendOnce(msg: proto.Message): Promise<proto.Message> {
        return new Promise((resolve, reject) => {
            const socket: Socket = connect(this.socketPath);
            let buffer = "";
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                try {
                    socket.destroy();
                } catch {
                    /* noop */
                }
                fn();
            };

            const timer = setTimeout(() => {
                settle(() => reject(new Error(`daemon request timed out after ${this.timeoutMs}ms`)));
            }, this.timeoutMs);

            socket.setEncoding("utf8");
            socket.on("connect", () => {
                socket.write(proto.toLine(msg));
            });
            socket.on("data", (chunk: string) => {
                buffer += chunk;
                const idx = buffer.indexOf("\n");
                if (idx !== -1) {
                    clearTimeout(timer);
                    const line = buffer.slice(0, idx);
                    try {
                        const response = proto.fromLine(line);
                        settle(() => resolve(response));
                    } catch (err) {
                        settle(() => reject(err));
                    }
                }
            });
            socket.on("end", () => {
                if (!settled && buffer) {
                    clearTimeout(timer);
                    try {
                        const response = proto.fromLine(buffer);
                        settle(() => resolve(response));
                    } catch (err) {
                        settle(() => reject(err));
                    }
                } else if (!settled) {
                    clearTimeout(timer);
                    settle(() => reject(new Error("daemon closed connection before responding")));
                }
            });
            socket.on("error", (err) => {
                clearTimeout(timer);
                settle(() => reject(err));
            });
        });
    }

    /** Assert that a response isn't an error; otherwise throw with the daemon's message. */
    private expect(response: proto.Message): proto.Message {
        if (proto.isError(response)) {
            const msg = typeof response.data.message === "string" ? response.data.message : "daemon error";
            throw new Error(`daemon: ${msg}`);
        }
        return response;
    }

    // -----------------------------------------------------------------------
    // High-level convenience wrappers. Each serializes the right request,
    // calls the daemon, and either returns the structured result or throws
    // on daemon-side error.
    // -----------------------------------------------------------------------

    async register(): Promise<number> {
        const res = this.expect(await this.call(proto.register(this.requester)));
        return typeof res.data.session_count === "number" ? (res.data.session_count as number) : 0;
    }

    async deregister(): Promise<void> {
        this.expect(await this.call(proto.deregister(this.requester)));
    }

    async subscribe(channel: string): Promise<number> {
        const res = this.expect(await this.call(proto.subscribe(channel, this.requester)));
        return typeof res.data.subscriber_count === "number"
            ? (res.data.subscriber_count as number)
            : 0;
    }

    async unsubscribe(channel: string): Promise<void> {
        this.expect(await this.call(proto.unsubscribe(channel, this.requester)));
    }

    async publish(
        channel: string,
        summary: string,
        body: string,
        priority: "normal" | "high" = "normal",
    ): Promise<number> {
        const res = this.expect(
            await this.call(proto.publish(channel, summary, body, priority, this.requester)),
        );
        return typeof res.data.recipient_count === "number"
            ? (res.data.recipient_count as number)
            : 0;
    }

    async sendDirect(
        to: string,
        summary: string,
        body: string,
        priority: "normal" | "high" = "normal",
    ): Promise<void> {
        this.expect(
            await this.call(proto.sendDirect(to, summary, body, priority, this.requester)),
        );
    }

    async listSubscriptions(): Promise<string[]> {
        const res = this.expect(await this.call(proto.listSubscriptions(this.requester)));
        return Array.isArray(res.data.channels) ? (res.data.channels as string[]) : [];
    }

    async listSessions(filter: { agent?: string } = {}): Promise<Array<Record<string, unknown>>> {
        const res = this.expect(await this.call(proto.listSessions(filter)));
        return Array.isArray(res.data.sessions)
            ? (res.data.sessions as Array<Record<string, unknown>>)
            : [];
    }

    async getStatus(): Promise<Record<string, unknown>> {
        const res = this.expect(await this.call(proto.getStatus()));
        return res.data as Record<string, unknown>;
    }
}

export { proto };

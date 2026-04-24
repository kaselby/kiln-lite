#!/usr/bin/env -S npx tsx
/**
 * kiln-lite daemon — Unix socket server.
 *
 * Entry point. Accepts JSON-line requests on a Unix domain socket, routes
 * them to handlers (see handlers.ts), replies on the same connection and
 * closes. One request per connection — the client module opens a fresh
 * socket for each call.
 *
 * Lifecycle:
 *   - On startup: claim socket path (remove stale if unused), write pidfile,
 *     load persisted subscriptions, start tmux-reconcile loop, listen.
 *   - On shutdown: clean up socket + pidfile, wait up to 2s for in-flight
 *     requests, exit.
 *   - Auto-exit: when the last session deregisters, schedule a 30-second
 *     grace shutdown. Any new register call cancels the timer. This covers
 *     "last session ended, nothing needs the daemon" while leaving room for
 *     a quick respawn.
 *
 * Run manually:
 *   node --import tsx src/daemon/index.ts [--socket PATH] [--state-dir DIR] [--foreground]
 *
 * Clients should use `client/autostart.ts` — spawns this in the background
 * on demand.
 */

import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { handlers } from "./handlers.ts";
import * as proto from "./protocol.ts";
import { reconcile } from "./reconcile.ts";
import { DaemonState } from "./state.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function defaultSocketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) return join(runtime, "kiln-lite.sock");
    return `/tmp/kiln-lite-${process.getuid?.() ?? "nouid"}.sock`;
}

function defaultStateDir(): string {
    return join(homedir(), ".kl", "daemon");
}

export interface DaemonConfig {
    socketPath: string;
    stateDir: string;
    pidfilePath: string;
    channelsDir: string;
    logPath: string;
    shutdownGraceMs: number;
    reconcileIntervalMs: number;
}

function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
    const stateDir = overrides.stateDir ?? defaultStateDir();
    return {
        socketPath: overrides.socketPath ?? defaultSocketPath(),
        stateDir,
        pidfilePath: overrides.pidfilePath ?? join(stateDir, "daemon.pid"),
        channelsDir: overrides.channelsDir ?? join(stateDir, "channels"),
        logPath: overrides.logPath ?? join(stateDir, "daemon.log"),
        shutdownGraceMs: overrides.shutdownGraceMs ?? 30_000,
        reconcileIntervalMs: overrides.reconcileIntervalMs ?? 60_000,
    };
}

// ---------------------------------------------------------------------------
// Logger — simple timestamped stdout + daemon.log append
// ---------------------------------------------------------------------------

class DaemonLogger {
    private fd: number | null = null;

    constructor(private path: string, private foreground: boolean) {}

    open(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, "a");
    }

    log(msg: string): void {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        if (this.foreground) process.stdout.write(line);
        if (this.fd !== null) {
            try {
                writeSync(this.fd, line);
            } catch {
                /* noop */
            }
        }
    }

    close(): void {
        if (this.fd !== null) {
            try {
                closeSync(this.fd);
            } catch {
                /* noop */
            }
            this.fd = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export class Daemon {
    config: DaemonConfig;
    state: DaemonState;
    private server: Server | null = null;
    private log: DaemonLogger;
    private shutdownTimer: NodeJS.Timeout | null = null;
    private reconcileTimer: NodeJS.Timeout | null = null;
    private shuttingDown = false;
    private inFlight: Set<Promise<void>> = new Set();

    constructor(overrides: Partial<DaemonConfig> = {}, foreground = false) {
        this.config = loadConfig(overrides);
        this.state = new DaemonState(this.config.stateDir);
        this.log = new DaemonLogger(this.config.logPath, foreground);
    }

    async start(): Promise<void> {
        mkdirSync(this.config.stateDir, { recursive: true });
        this.log.open();

        // Claim the socket: if a stale file is there with no listener, remove it.
        this.clearStaleSocket();

        // Pidfile — only one daemon per machine. If one's already running,
        // bail gracefully — the client can use the existing one.
        if (this.alreadyRunning()) {
            this.log.log(`daemon already running (pidfile: ${this.config.pidfilePath})`);
            throw new Error(`daemon already running at ${this.config.socketPath}`);
        }

        writeFileSync(this.config.pidfilePath, String(process.pid) + "\n");
        this.log.log(`starting daemon pid=${process.pid} socket=${this.config.socketPath}`);

        // Load persisted state
        this.state.loadFromFiles();

        // Set up signal handlers
        process.on("SIGINT", () => void this.shutdown("SIGINT"));
        process.on("SIGTERM", () => void this.shutdown("SIGTERM"));

        // Start reconcile loop
        this.reconcileTimer = setInterval(() => this.runReconcile(), this.config.reconcileIntervalMs);
        this.reconcileTimer.unref();

        // Listen
        await this.listen();

        // If no one registers within the grace window, self-exit.
        this.maybeScheduleShutdown();
    }

    private clearStaleSocket(): void {
        if (!existsSync(this.config.socketPath)) return;
        try {
            // Try connecting — if it succeeds, another daemon owns it.
            const probe = require("node:net").createConnection(this.config.socketPath);
            probe.on("connect", () => {
                probe.destroy();
                throw new Error(`socket ${this.config.socketPath} is in use`);
            });
            probe.on("error", () => {
                probe.destroy();
                try {
                    rmSync(this.config.socketPath, { force: true });
                } catch {
                    /* noop */
                }
            });
        } catch {
            try {
                rmSync(this.config.socketPath, { force: true });
            } catch {
                /* noop */
            }
        }
    }

    private alreadyRunning(): boolean {
        if (!existsSync(this.config.pidfilePath)) return false;
        try {
            const pid = Number(readFileSync(this.config.pidfilePath, "utf8").trim());
            if (!pid || pid === process.pid) return false;
            try {
                process.kill(pid, 0); // signal 0 = "are you there?"
                return true;
            } catch {
                // process is gone; pidfile is stale
                return false;
            }
        } catch {
            return false;
        }
    }

    private listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = createServer((socket) => {
                const handling = this.handleConnection(socket);
                this.inFlight.add(handling);
                handling.finally(() => this.inFlight.delete(handling));
            });
            server.on("error", reject);
            server.listen(this.config.socketPath, () => {
                this.server = server;
                // Socket permissions: user-only. No one else on the box
                // should be able to spoof requests into this daemon.
                try {
                    statSync(this.config.socketPath);
                    require("node:fs").chmodSync(this.config.socketPath, 0o600);
                } catch {
                    /* noop */
                }
                this.log.log(`listening on ${this.config.socketPath}`);
                resolve();
            });
        });
    }

    private async handleConnection(socket: Socket): Promise<void> {
        socket.setEncoding("utf8");
        let buffer = "";
        try {
            const line = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("request timeout")), 10_000);
                socket.on("data", (chunk: string) => {
                    buffer += chunk;
                    const idx = buffer.indexOf("\n");
                    if (idx !== -1) {
                        clearTimeout(timeout);
                        resolve(buffer.slice(0, idx));
                    }
                });
                socket.on("error", (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
                socket.on("end", () => {
                    clearTimeout(timeout);
                    if (buffer) resolve(buffer);
                    else reject(new Error("connection closed before request"));
                });
            });

            let msg: proto.Message;
            try {
                msg = proto.fromLine(line);
            } catch (err) {
                this.log.log(`malformed request: ${String(err)}`);
                socket.end();
                return;
            }

            const response = await this.dispatch(msg);
            if (response) {
                socket.write(proto.toLine(response));
            }
            socket.end();
        } catch (err) {
            this.log.log(`connection error: ${String(err)}`);
            try {
                socket.destroy();
            } catch {
                /* noop */
            }
        }
    }

    private async dispatch(msg: proto.Message): Promise<proto.Message | null> {
        const handler = handlers[msg.type];
        if (!handler) {
            this.log.log(`unknown message type: ${msg.type}`);
            return msg.ref ? proto.error(msg.ref, `unknown message type: ${msg.type}`) : null;
        }
        try {
            return await handler(msg, this);
        } catch (err) {
            this.log.log(`handler error for ${msg.type}: ${String(err)}`);
            return msg.ref ? proto.error(msg.ref, String(err)) : null;
        }
    }

    private runReconcile(): void {
        const result = reconcile(this.state);
        if (result.pruned.length > 0) {
            this.log.log(`reconcile pruned ${result.pruned.length} dead sessions: ${result.pruned.join(", ")}`);
            this.maybeScheduleShutdown();
        }
    }

    // -----------------------------------------------------------------------
    // Auto-shutdown lifecycle
    // -----------------------------------------------------------------------

    /** Called by handlers when a session registers. Cancels pending shutdown. */
    cancelShutdown(): void {
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
            this.log.log("shutdown cancelled — session registered");
        }
    }

    /** Called when a session deregisters or is reconciled away. */
    maybeScheduleShutdown(): void {
        if (this.state.presence.size() > 0) return;
        if (this.shutdownTimer) return;
        this.log.log(`no live sessions — scheduling shutdown in ${this.config.shutdownGraceMs}ms`);
        this.shutdownTimer = setTimeout(
            () => void this.shutdown("idle"),
            this.config.shutdownGraceMs,
        );
        this.shutdownTimer.unref();
    }

    async shutdown(reason: string): Promise<void> {
        if (this.shuttingDown) return;
        // Idle shutdown is cheap to cancel at the last second — if the
        // presence registry is non-empty (a session registered while the
        // timer was armed), abort. Non-idle shutdowns (SIGINT/SIGTERM) still
        // proceed so users retain the ability to kill the daemon.
        if (reason === "idle" && this.state.presence.size() > 0) {
            this.log.log("idle shutdown aborted — sessions present");
            this.shutdownTimer = null;
            return;
        }
        this.shuttingDown = true;
        this.log.log(`shutting down: ${reason}`);

        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
        }
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }

        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server!.close(() => resolve());
            });
        }

        // Wait for in-flight requests to finish, up to 2 seconds.
        if (this.inFlight.size > 0) {
            await Promise.race([
                Promise.all(Array.from(this.inFlight)),
                delay(2000),
            ]);
        }

        try {
            rmSync(this.config.socketPath, { force: true });
        } catch {
            /* noop */
        }
        try {
            rmSync(this.config.pidfilePath, { force: true });
        } catch {
            /* noop */
        }

        this.log.log("shutdown complete");
        this.log.close();
        process.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
    overrides: Partial<DaemonConfig>;
    foreground: boolean;
} {
    const overrides: Partial<DaemonConfig> = {};
    let foreground = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--socket":
                overrides.socketPath = argv[++i];
                break;
            case "--state-dir":
                overrides.stateDir = argv[++i];
                break;
            case "--foreground":
                foreground = true;
                break;
            case "-h":
            case "--help":
                printUsage();
                process.exit(0);
                break;
            default:
                process.stderr.write(`unknown flag: ${arg}\n`);
                process.exit(1);
        }
    }
    return { overrides, foreground };
}

function printUsage(): void {
    process.stdout.write(
        [
            "kiln-lite daemon",
            "",
            "Usage: node --import tsx src/daemon/index.ts [options]",
            "",
            "Options:",
            "  --socket PATH      Unix socket path (default: $XDG_RUNTIME_DIR/kiln-lite.sock",
            "                                       or /tmp/kiln-lite-<uid>.sock)",
            "  --state-dir DIR    State directory (default: ~/.kl/daemon)",
            "  --foreground       Log to stdout as well as daemon.log",
            "  -h, --help         Show this help",
            "",
        ].join("\n"),
    );
}

// Check if this module is being run directly (top-level entry point).
// Under `tsx src/daemon/index.ts` argv[1] resolves to the .ts file.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("/daemon/index.ts") || invokedPath.endsWith("\\daemon\\index.ts")) {
    const { overrides, foreground } = parseArgs(process.argv.slice(2));
    const daemon = new Daemon(overrides, foreground);
    daemon.start().catch((err) => {
        process.stderr.write(`daemon failed to start: ${String(err)}\n`);
        process.exit(1);
    });
}

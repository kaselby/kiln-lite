/**
 * Autostart the kiln-lite daemon when the socket isn't up.
 *
 * Flow:
 *   1. If the socket file exists and accepts a connection, the daemon is
 *      already running — return immediately.
 *   2. Spawn the daemon as a detached background process (via `tsx`).
 *   3. Poll the socket path until it accepts connections or we time out.
 *
 * The caller (DaemonClient.call) only invokes this after a failed connect,
 * so the fast path (daemon already up) doesn't pay any cost here.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, openSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = resolve(here, "..", "daemon", "index.ts");

export interface AutostartOptions {
    socketPath: string;
    stateDir: string;
    /** Total time (ms) to wait for the daemon to come up. Default 5000. */
    readyTimeoutMs?: number;
    /** Path to the tsx binary. Resolved from the package's node_modules by default. */
    tsxBin?: string;
}

function resolveTsxBin(): string {
    // Walk up from this file looking for a node_modules/.bin/tsx. That
    // covers `npm link`-style installs where we sit inside the package.
    let dir = here;
    for (let i = 0; i < 8; i++) {
        const candidate = resolve(dir, "node_modules", ".bin", "tsx");
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Fall back to expecting tsx on PATH. Callers can override.
    return "tsx";
}

export async function autostartDaemon(opts: AutostartOptions): Promise<void> {
    if (await socketAlive(opts.socketPath)) return;

    const tsxBin = opts.tsxBin ?? resolveTsxBin();
    const readyTimeout = opts.readyTimeoutMs ?? 5000;

    // Make sure log dir exists so the daemon's log file writes don't fail.
    mkdirSync(opts.stateDir, { recursive: true });

    // Open log fds so the child's stdio can inherit them without a tty.
    // Any startup chatter (errors before log file opens) goes here.
    const logPath = resolve(opts.stateDir, "daemon.log");
    const out = openSync(logPath, "a");
    const err = openSync(logPath, "a");

    const args = [
        DAEMON_ENTRY,
        "--socket",
        opts.socketPath,
        "--state-dir",
        opts.stateDir,
    ];
    const child = spawn(tsxBin, args, {
        detached: true,
        stdio: ["ignore", out, err],
    });
    child.unref();

    // Poll for readiness
    const start = Date.now();
    while (Date.now() - start < readyTimeout) {
        if (await socketAlive(opts.socketPath)) return;
        await delay(100);
    }
    throw new Error(
        `daemon did not come up within ${readyTimeout}ms (socket: ${opts.socketPath}, log: ${logPath})`,
    );
}

function socketAlive(path: string): Promise<boolean> {
    return new Promise((resolveFn) => {
        const sock = connect(path);
        const done = (alive: boolean) => {
            try {
                sock.destroy();
            } catch {
                /* noop */
            }
            resolveFn(alive);
        };
        sock.on("connect", () => done(true));
        sock.on("error", () => done(false));
    });
}

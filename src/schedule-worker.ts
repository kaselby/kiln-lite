/**
 * Detached worker for one scheduled wake (see src/schedule.ts).
 *
 *   tsx src/schedule-worker.ts <schedule dir> <wake id> <creator pid>
 *
 * Delivers through the daemon's deliver_self as the session that created
 * the wake (the requester stored in the record).
 */

import { DaemonClient } from "./client/index.ts";
import { runWorker } from "./schedule.ts";

const [dir, id, creator] = process.argv.slice(2);
if (!dir || !id || !creator) {
	process.stderr.write("usage: schedule-worker.ts <dir> <wake id> <creator pid>\n");
	process.exit(2);
}
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

void runWorker({
	dir,
	id,
	creatorPid: Number(creator),
	deliver: (requester, summary, body) => new DaemonClient({ requester }).deliverSelf(summary, body),
}).then((code) => process.exit(code));

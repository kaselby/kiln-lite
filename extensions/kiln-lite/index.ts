/**
 * kiln-lite — default extension entry point.
 *
 * Composes the stock kiln-lite behavior by calling installDefaultHarness
 * from ./lib/, which wires every building block (config, env, prompt
 * assembly, snapshot, inbox watcher, cleanup, gates, tools, daemon) in
 * the order the pre-refactor monolithic index.ts did.
 *
 * To customize without forking this repo, write a harness at
 * $AGENT_HOME/harness/index.ts. `kl` will load it in preference to this
 * file when present. A harness can either:
 *
 *   1. Call installDefaultHarness(pi) and then add its own handlers /
 *      tools / commands on top — Pi composes handlers across all
 *      registrations.
 *   2. Skip installDefaultHarness entirely and compose the building
 *      blocks from `./lib/index.ts` to its own taste — useful when the
 *      harness needs to REPLACE behavior (custom prompt assembly,
 *      different agent-id policy, etc.) rather than just extend.
 *
 * See docs/extension.md for the override patterns and the stable lib
 * surface contract.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { installDefaultHarness } from "./lib/index.ts";

export default function (pi: ExtensionAPI): void {
	installDefaultHarness(pi);
}

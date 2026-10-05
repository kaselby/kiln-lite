/**
 * kiln-lite core entry point.
 *
 * `kl` loads this with `pi -e` for every agent. Persistent-agent behaviour
 * (cleanup turn, exit_session, continuation) is a separate entry,
 * ./persistence.ts, loaded only for agents that use it.
 *
 * Agents extend kl with ordinary Pi extensions in <agent>/extensions/*.ts
 * (kl passes each with -e); there is no harness override.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCore } from "./lib/core.ts";

export default function (pi: ExtensionAPI): void {
	installCore(pi);
}

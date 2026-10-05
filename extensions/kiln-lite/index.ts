/**
 * kiln-lite core entry point.
 *
 * `kl` loads this with `pi -e` for every agent. It is the only kl entry
 * point: the lifecycle (cleanup turn, exit_session, reset) is core too.
 *
 * Agents extend kl with ordinary Pi extensions in <agent>/extensions/*.ts
 * (kl passes each with -e); there is no harness override.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installCore } from "./lib/core.ts";

export default function (pi: ExtensionAPI): void {
	installCore(pi);
}

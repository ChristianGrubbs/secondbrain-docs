/**
 * Fork-local CLI surface for the `sb-docs` vault capture command.
 *
 * This is deliberately NOT the upstream `createCli`: it registers no default
 * action and no MCP, web or worker command, so invoking it can never start a
 * resident service. Capture, search, read and reindex handlers are registered
 * by later migration tasks; this module owns the shared program shape and the
 * `doctor` command.
 */

import yargs, { type Argv } from "yargs";
import { createDoctorCommand, type DoctorDeps } from "./commands/doctor";

/** Injected dependencies for the commands this program registers. */
export interface VaultCliDeps {
  doctor?: DoctorDeps;
}

/**
 * Creates the restricted vault CLI program.
 *
 * @param argv Argument list with the node/script prefix already removed
 *   (callers pass `hideBin(process.argv)`).
 * @param deps Per-command dependency overrides; the defaults reach the real
 *   host, so tests pass a fake vault CLI and a temporary state directory.
 * @returns The configured yargs program, unparsed.
 */
export function createVaultCli(argv: string[], deps: VaultCliDeps = {}): Argv {
  return yargs(argv)
    .scriptName("sb-docs")
    .usage("Usage: $0 <command> [options]")
    .version(__APP_VERSION__)
    .command(createDoctorCommand(deps.doctor))
    .strict()
    .help()
    .alias("help", "h")
    .demandCommand(1, "Choose capture, search, read, reindex, or doctor");
}

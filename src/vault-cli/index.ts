/**
 * Fork-local CLI surface for the `sb-docs` vault capture command.
 *
 * This is deliberately NOT the upstream `createCli`: it registers no default
 * action and no MCP, web or worker command, so invoking it can never start a
 * resident service. It owns the shared program shape and the five commands the
 * product contract names: capture, search, read, reindex and doctor.
 */

import yargs, { type Argv } from "yargs";
import { type CaptureDeps, createCaptureCommand } from "./commands/capture";
import { createDoctorCommand, type DoctorDeps } from "./commands/doctor";
import { createReadCommand, type ReadDeps } from "./commands/read";
import { createReindexCommand, type ReindexDeps } from "./commands/reindex";
import { createSearchCommand, type SearchDeps } from "./commands/search";

/** Injected dependencies for the commands this program registers. */
export interface VaultCliDeps {
  doctor?: DoctorDeps;
  capture?: CaptureDeps;
  search?: SearchDeps;
  read?: ReadDeps;
  reindex?: ReindexDeps;
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
  return (
    yargs(argv)
      .scriptName("sb-docs")
      // `capture --no-index` is a declared flag, not the negation of an `index`
      // option; with yargs' default boolean negation the strict parser rejected
      // it as "Unknown argument: index" (Task 7 review, 2026-09-15). No vault
      // command relies on `--no-<flag>` negation.
      .parserConfiguration({ "boolean-negation": false })
      .usage("Usage: $0 <command> [options]")
      .version(__APP_VERSION__)
      .command(createCaptureCommand(deps.capture))
      .command(createSearchCommand(deps.search))
      .command(createReadCommand(deps.read))
      .command(createReindexCommand(deps.reindex))
      .command(createDoctorCommand(deps.doctor))
      .strict()
      .help()
      .alias("help", "h")
      .demandCommand(1, "Choose capture, search, read, reindex, or doctor")
  );
}

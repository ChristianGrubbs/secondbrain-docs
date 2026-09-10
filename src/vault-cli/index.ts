/**
 * Fork-local CLI surface for the `sb-docs` vault capture command.
 *
 * This is deliberately NOT the upstream `createCli`: it registers no default
 * action and no MCP, web or worker command, so invoking it can never start a
 * resident service. Capture, search, read, reindex and doctor handlers are
 * registered by later migration tasks; this module owns only the shared
 * program shape.
 *
 * TODO 2026-09-10: `.strict()` only rejects an unknown command once at least
 * one command is registered, so until Task 2 lands `capture` a stray positional
 * such as `sb-docs bogus` satisfies `demandCommand` and exits 0 doing nothing.
 * Add the unknown-command assertion to index.test.ts with that first command.
 */

import yargs, { type Argv } from "yargs";

/**
 * Creates the restricted vault CLI program.
 *
 * @param argv Argument list with the node/script prefix already removed
 *   (callers pass `hideBin(process.argv)`).
 * @returns The configured yargs program, unparsed.
 */
export function createVaultCli(argv: string[]): Argv {
  return yargs(argv)
    .scriptName("sb-docs")
    .usage("Usage: $0 <command> [options]")
    .version(__APP_VERSION__)
    .strict()
    .help()
    .alias("help", "h")
    .demandCommand(1, "Choose capture, search, read, reindex, or doctor");
}

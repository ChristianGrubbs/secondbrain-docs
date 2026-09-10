/**
 * Executable entry point for the CLI-only `sb-docs` command, built to
 * `dist/vault-cli.js`.
 *
 * Its import surface is intentionally minimal: nothing here reaches the
 * upstream server entry points, telemetry bootstrap or pipeline worker, so the
 * process opens no listening socket and exits once the command finishes.
 */

import { hideBin } from "yargs/helpers";
import { createVaultCli } from "./index";

process.setSourceMapsEnabled(true);

try {
  await createVaultCli(hideBin(process.argv)).parseAsync();
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

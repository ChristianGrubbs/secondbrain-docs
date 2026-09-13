/**
 * `sb-docs read <note-path>` — prints one saved note in full.
 *
 * The note always comes back through `obsidian-cli read --all`, never by
 * reassembling index chunks: chunks are a derived, lossy projection built for
 * retrieval, and a note reconstructed from them would silently differ from the
 * document the vault actually holds.
 */

import type { CommandModule } from "yargs";
import { createObsidianCliRunner, ObsidianCli } from "../../vault/ObsidianCli";

/** Everything the command needs from the outside world. */
export interface ReadDeps {
  /** Vault the CLI operates on; defaults to `OBSIDIAN_VAULT`. */
  vaultPath?: string;
  /** Vault CLI wrapper; defaults to a real `obsidian-cli` subprocess. */
  cli?: ObsidianCli;
  /** Note sink; defaults to stdout. */
  stdout?: (line: string) => void;
  /** Diagnostics sink; defaults to stderr. */
  stderr?: (line: string) => void;
}

/** Builds the `read` command. */
export function createReadCommand(deps: ReadDeps = {}): CommandModule {
  return {
    command: "read <note-path>",
    describe: "Print one saved vault note in full",
    builder: (argv) =>
      argv
        .positional("note-path", {
          type: "string",
          demandOption: true,
          describe: "Vault-relative path of the note to print",
        })
        .strict(),

    handler: async (args) => {
      const stdout = deps.stdout ?? ((line: string) => console.log(line));
      const stderr = deps.stderr ?? ((line: string) => console.error(line));

      const vaultPath = deps.vaultPath ?? process.env.OBSIDIAN_VAULT ?? null;
      const cli =
        deps.cli ??
        new ObsidianCli(createObsidianCliRunner(vaultPath === null ? {} : { vaultPath }));

      const notePath = String(args["note-path"]);
      const markdown = await cli.readNote(notePath);

      if (markdown === null) {
        stderr(`❌ no such note: ${notePath}`);
        process.exitCode = 1;
        return;
      }

      stdout(markdown);
    },
  };
}

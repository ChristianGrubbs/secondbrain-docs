/**
 * `sb-docs doctor` — reports the durable capture state and, on an explicit
 * operator instruction, adopts a note's current bytes as the new baseline.
 *
 * It is deliberately read-only apart from `--adopt`: it never deletes journal
 * entries or ownership records, and it never rewrites a note. Adoption is the
 * one sanctioned way a human-edited note becomes ours again, and it prints the
 * digest it is accepting so the operator can see exactly what they approved.
 */

import type { CommandModule } from "yargs";
import { sha256 } from "../../vault/identity";
import { createObsidianCliRunner, ObsidianCli } from "../../vault/ObsidianCli";
import { type LockRecord, PublicationJournal } from "../../vault/PublicationJournal";
import { parseNoteFrontmatter } from "../../vault/render";
import { VaultPublisher } from "../../vault/VaultPublisher";

/** Everything the command needs from the outside world. */
export interface DoctorDeps {
  /** Runtime state directory; defaults to the platform location. */
  stateDir?: string;
  /** Vault the CLI operates on; defaults to `OBSIDIAN_VAULT`. */
  vaultPath?: string;
  /** Vault CLI wrapper; defaults to a real `obsidian-cli` subprocess. */
  cli?: ObsidianCli;
  /** Report sink; defaults to stdout. */
  stdout?: (line: string) => void;
  /** Diagnostics sink; defaults to stderr. */
  stderr?: (line: string) => void;
}

/** One pending publication as the report describes it. */
interface PendingReport {
  sourceId: string;
  path: string;
  phase: string;
  classification: string;
}

/** The single JSON envelope a `--json` run prints. */
interface DoctorReport {
  stateDir: string;
  vaultPath: string | null;
  pending: PendingReport[];
  ownershipCount: number;
  /** Per-source locks, including any a capture is inside right now. */
  locks: LockRecord[];
  adopted?: { path: string; sourceId: string; digest: string };
}

/** Renders the report as lines a human reads. */
function formatReport(report: DoctorReport): string[] {
  const lines = [
    `state dir: ${report.stateDir}`,
    `vault: ${report.vaultPath ?? "(obsidian-cli default)"}`,
    `ownership records: ${report.ownershipCount}`,
    `pending journal entries: ${report.pending.length}`,
  ];

  for (const entry of report.pending) {
    lines.push(`  - ${entry.classification} [${entry.phase}] ${entry.path}`);
  }

  lines.push(`locks: ${report.locks.length}`);
  for (const lock of report.locks) {
    // A busy lock is a capture in flight, which is the one lock state an
    // operator staring at a stuck run actually wants to see.
    lines.push(`  - ${lock.source} ${lock.busy ? "HELD NOW" : "free"}`);
  }

  if (report.adopted !== undefined) {
    lines.push(`adopted ${report.adopted.path}`);
    lines.push(`  source_id: ${report.adopted.sourceId}`);
    lines.push(`  digest: sha256:${report.adopted.digest}`);
  }

  return lines;
}

/**
 * Builds the `doctor` command.
 *
 * @param deps Injected state directory, vault CLI and output sinks; every
 *   default reaches the real host, so tests supply all of them.
 * @returns A yargs command module.
 */
export function createDoctorCommand(deps: DoctorDeps = {}): CommandModule {
  return {
    command: "doctor",
    describe: "Report capture state, pending recoveries and ownership records",
    builder: (argv) =>
      argv
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Print one JSON envelope on stdout",
        })
        .option("adopt", {
          type: "string",
          requiresArg: true,
          describe: "Accept an exact note path's current bytes as the new baseline",
        })
        .option("state-dir", {
          type: "string",
          requiresArg: true,
          describe: "Runtime state directory; defaults to the platform location",
        })
        .strict(),

    handler: async (args) => {
      const stdout = deps.stdout ?? ((line: string) => console.log(line));
      const stderr = deps.stderr ?? ((line: string) => console.error(line));
      const vaultPath = deps.vaultPath ?? process.env.OBSIDIAN_VAULT ?? null;
      const cli =
        deps.cli ??
        new ObsidianCli(createObsidianCliRunner(vaultPath === null ? {} : { vaultPath }));

      // The flag is what makes this command testable against a throwaway state
      // directory; injected dependencies still win, so tests need neither.
      const stateDir =
        deps.stateDir ??
        (typeof args["state-dir"] === "string" ? args["state-dir"] : undefined);

      const journal = new PublicationJournal({
        stateDir,
        vaultPath: vaultPath ?? undefined,
      });
      const publisher = new VaultPublisher(cli, { journal });

      const adoptPath = typeof args.adopt === "string" ? args.adopt : null;
      let adopted: DoctorReport["adopted"];

      if (adoptPath !== null) {
        const markdown = await cli.readNote(adoptPath);
        if (markdown === null) {
          throw new Error(`cannot adopt a note that is not there: ${adoptPath}`);
        }

        const raw = parseNoteFrontmatter(markdown)?.data.source_id;
        if (raw === undefined || raw === null) {
          throw new Error(`cannot adopt ${adoptPath}: it carries no source_id`);
        }

        const sourceId = String(raw);
        const digest = sha256(markdown);
        stderr(`adopting sha256:${digest} as the baseline for ${sourceId}`);
        journal.writeOwnership({ sourceId, path: adoptPath, digest });
        adopted = { path: adoptPath, sourceId, digest };
      }

      const pending = await publisher.classifyPending();
      const report: DoctorReport = {
        stateDir: journal.stateDir,
        vaultPath,
        pending: pending.map((entry) => ({
          sourceId: entry.sourceId,
          path: entry.path,
          phase: entry.phase,
          classification: entry.classification,
        })),
        ownershipCount: journal.ownershipCount(),
        locks: journal.lockRecords(),
        ...(adopted === undefined ? {} : { adopted }),
      };

      if (args.json === true) stdout(JSON.stringify(report));
      else for (const line of formatReport(report)) stdout(line);
    },
  };
}

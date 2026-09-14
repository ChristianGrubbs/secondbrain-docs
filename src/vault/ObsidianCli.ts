/**
 * Typed wrapper around the `obsidian-cli` process.
 *
 * Every call passes an argument array with no shell, and note bytes travel on
 * stdin, so Markdown containing backticks or `$(...)` can never be expanded.
 *
 * Failures are classified by the CLI's *observed* behaviour rather than by its
 * help text: exit 3 is a compare-and-swap conflict, including a create-only
 * collision, while a missing note, a missing heading and a setext refusal all
 * arrive as exit 1 and are told apart by their diagnostics.
 */

import { spawn } from "node:child_process";
import { createJsonlLogger, type VaultLogger } from "./PublicationJournal";
import type { CliResult, CliRunner } from "./types";

/** Default location of the vault CLI. */
export const OBSIDIAN_CLI_PATH = `${process.env.HOME ?? ""}/ai-stack/bin/obsidian-cli`;

/**
 * Buckets an `obsidian-cli` subcommand into the coarse category
 * MINOR 7 (2026-09-13 Codex frontier review) measurements report on:
 * `list`/`read` are non-mutating vault-access, everything else that reaches
 * the vault is `write`, and `store-key` is neither (`other`).
 */
export function classifyObsidianCliSubcommand(
  subcommand: string,
): "list" | "read" | "write" | "other" {
  if (subcommand === "list") return "list";
  if (subcommand === "read") return "read";
  if (
    [
      "create",
      "write",
      "append",
      "section-insert",
      "move",
      "attach",
      "redirect-sweep",
    ].includes(subcommand)
  ) {
    return "write";
  }
  return "other";
}

/** Any nonzero exit from `obsidian-cli`. */
export class ObsidianCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ObsidianCliError";
  }
}

/** Exit 3: the note changed under us, or a create-only note already exists. */
export class CasConflictError extends ObsidianCliError {
  constructor(message: string, stderr: string) {
    super(message, 3, stderr);
    this.name = "CasConflictError";
  }
}

/**
 * The note uses setext headings and was left untouched.
 *
 * The exit code is carried rather than assumed: the installed CLI reports this
 * as exit 1 even though its help text documents exit 4.
 */
export class HeadingFormatError extends ObsidianCliError {
  constructor(message: string, exitCode: number, stderr: string) {
    super(message, exitCode, stderr);
    this.name = "HeadingFormatError";
  }
}

/** The target heading is absent from an otherwise editable note. */
export class HeadingNotFoundError extends ObsidianCliError {
  constructor(message: string, exitCode: number, stderr: string) {
    super(message, exitCode, stderr);
    this.name = "HeadingNotFoundError";
  }
}

/**
 * Recognizes the CLI's missing-note diagnostics.
 *
 * There are two, and both mean "no such note": a note missing from a folder
 * that exists reports `not a file:`, while a note whose folder does not exist
 * yet reports `no such directory for:`. Reading before the first write in a
 * collection hits the second one, so treating it as a hard failure would break
 * every first capture into a new collection.
 */
const isNotFound = (stderr: string): boolean =>
  /not a file:|no such directory for:/.test(stderr);

/**
 * Recognizes the CLI's missing-directory diagnostics.
 *
 * `list` has the same two-phrasing problem as `read`, and for the same reason:
 * a path that exists as a file reports `not a directory`, while a path with no
 * entry at all reports `no such directory for:`. Only the first was recognized
 * once, so listing a documentation collection's parent folder before it existed
 * threw instead of reporting "nothing here" — which made the first capture into
 * any collection outside the inbox fail against a real vault.
 */
const isMissingDirectory = (stderr: string): boolean =>
  /not a directory|no such directory for:/.test(stderr);

/** Recognizes the CLI's missing-heading diagnostic. */
const isHeadingNotFound = (stderr: string): boolean => /heading not found/.test(stderr);

/**
 * Recognizes the CLI's setext-heading refusal.
 *
 * The installed CLI reports this as exit 1 even though its help text implies
 * exit 4, so the diagnostic — not the exit code alone — is authoritative.
 */
const isSetextRefusal = (stderr: string): boolean => /setext heading/.test(stderr);

/**
 * Builds a runner that executes `obsidian-cli` as a real subprocess.
 *
 * @param options.vaultPath Vault to operate on. Passed as `OBSIDIAN_VAULT`,
 *   which the CLI reads for every path it resolves, locks, reads and mutates.
 *   Omit to use the CLI's own default vault.
 * @param options.cliPath Executable to run; defaults to the stack location.
 * @returns A runner suitable for {@link ObsidianCli}.
 */
export function createObsidianCliRunner(
  options: { vaultPath?: string; cliPath?: string; logger?: VaultLogger } = {},
): CliRunner {
  const cliPath = options.cliPath ?? OBSIDIAN_CLI_PATH;
  const env = options.vaultPath
    ? { ...process.env, OBSIDIAN_VAULT: options.vaultPath }
    : process.env;
  // MINOR 7 (2026-09-13 Codex frontier review): one JSONL event per
  // spawned obsidian-cli invocation, gated by the same SB_DOCS_LOG env var
  // every other vault event uses, so M-row measurements can report actual
  // subprocess/list/read/write counts instead of only lock/upsert counts.
  const logger: VaultLogger = options.logger ?? createJsonlLogger();

  return (args, stdin) =>
    new Promise<CliResult>((resolve, reject) => {
      const subcommand = args[0] ?? "";
      logger({
        level: "debug",
        event: "vault.cli_invoked",
        loc: "createObsidianCliRunner",
        ctx: { subcommand, category: classifyObsidianCliSubcommand(subcommand) },
      });

      const child = spawn(cliPath, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      // setEncoding decodes through a StringDecoder, which holds back the tail
      // of a multibyte character split across chunks. Decoding each chunk
      // independently would corrupt any note containing non-ASCII text.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        outcome();
      };

      child.on("error", (error) => settle(() => reject(error)));
      child.on("close", (code) =>
        settle(() => resolve({ code: code ?? 1, stdout, stderr })),
      );

      // A child that refuses input and exits leaves stdin broken. That is the
      // CLI reporting a failure, not a host crash: swallow the write error and
      // let the close handler settle with the real exit code and diagnostic.
      child.stdin.on("error", () => undefined);

      if (stdin !== null) child.stdin.end(stdin);
      else child.stdin.end();
    });
}

/** Rejects paths that are absolute or climb out of the vault. */
function assertVaultRelative(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`vault path must be relative and contained: ${path}`);
  }
}

/**
 * Converts a nonzero CLI result into the matching typed error.
 */
function toError(action: string, path: string, result: CliResult): ObsidianCliError {
  const message = `${action} failed for ${path} (exit ${result.code}): ${result.stderr.trim()}`;
  if (result.code === 3) return new CasConflictError(message, result.stderr);
  if (result.code === 4 || isSetextRefusal(result.stderr)) {
    return new HeadingFormatError(message, result.code, result.stderr);
  }
  if (isHeadingNotFound(result.stderr)) {
    return new HeadingNotFoundError(message, result.code, result.stderr);
  }
  return new ObsidianCliError(message, result.code, result.stderr);
}

export class ObsidianCli {
  constructor(private readonly run: CliRunner) {}

  /**
   * Creates a note only if it does not already exist.
   *
   * @throws CasConflictError when the note is already present.
   */
  async createNote(path: string, markdown: string): Promise<void> {
    assertVaultRelative(path);
    if (markdown.trim().length === 0) {
      throw new Error(`refusing to create an empty note: ${path}`);
    }
    const result = await this.run(["create", path], markdown);
    if (result.code !== 0) throw toError("create", path, result);
  }

  /**
   * Reads a note in full.
   *
   * @returns The note's bytes, or null when it does not exist.
   */
  async readNote(path: string): Promise<string | null> {
    assertVaultRelative(path);
    const result = await this.run(["read", path, "--all"], null);
    if (result.code === 0) return result.stdout;
    if (result.code === 1 && isNotFound(result.stderr)) return null;
    throw toError("read", path, result);
  }

  /**
   * Reads a note in full together with the anchor a later write must match.
   *
   * The anchor is the CLI's compare-and-swap token: it is printed on stderr,
   * not stdout, so it can never be mistaken for note bytes.
   *
   * @returns The note's bytes and its anchor, or null when it does not exist.
   * @throws ObsidianCliError when the CLI printed no anchor, because writing
   *   without one would silently become an unconditional overwrite.
   */
  async readNoteWithAnchor(
    path: string,
  ): Promise<{ markdown: string; anchor: string } | null> {
    assertVaultRelative(path);
    const result = await this.run(["read", path, "--all", "--with-anchor"], null);
    if (result.code === 1 && isNotFound(result.stderr)) return null;
    if (result.code !== 0) throw toError("read", path, result);

    const anchor = result.stderr.match(/^anchor:\s*(sha256:[0-9a-f]+)\s*$/m)?.[1];
    if (anchor === undefined) {
      throw new ObsidianCliError(
        `read did not report an anchor for ${path}`,
        result.code,
        result.stderr,
      );
    }
    return { markdown: result.stdout, anchor };
  }

  /**
   * Replaces a note's bytes only if it still matches `anchor`.
   *
   * @param anchor Anchor from {@link readNoteWithAnchor}; an anchor is never
   *   reused after a failed write.
   * @throws CasConflictError when the note changed since that read.
   */
  async replaceNote(path: string, markdown: string, anchor: string): Promise<void> {
    assertVaultRelative(path);
    if (markdown.trim().length === 0) {
      throw new Error(`refusing to blank a note: ${path}`);
    }
    if (!/^sha256:[0-9a-f]+$/.test(anchor)) {
      throw new Error(`refusing to write ${path} without a usable anchor`);
    }

    const result = await this.run(
      ["write", path, "--force", "--if-match", anchor],
      markdown,
    );
    if (result.code !== 0) throw toError("write", path, result);
  }

  /**
   * Lists one directory level.
   *
   * @returns Vault-relative entry paths, or null when the directory is absent.
   */
  async listDirectory(path: string): Promise<string[] | null> {
    assertVaultRelative(path);
    const result = await this.run(["list", path], null);
    if (result.code === 0) return result.stdout.split("\n").filter(Boolean);
    if (isMissingDirectory(result.stderr)) return null;
    throw toError("list", path, result);
  }

  /**
   * Inserts one line directly under an existing heading.
   *
   * @throws HeadingNotFoundError when the heading is absent.
   * @throws HeadingFormatError when the note uses setext headings.
   */
  async insertUnderHeading(
    path: string,
    heading: string,
    content: string,
  ): Promise<void> {
    assertVaultRelative(path);
    const result = await this.run(["section-insert", path, heading], content);
    if (result.code !== 0) throw toError("section-insert", path, result);
  }

  /**
   * Copies a non-Markdown asset from a local path into the vault.
   *
   * `attach` is the CLI's one sanctioned binary write: it runs under the
   * vault mutation lock, byte-verifies the copy and lands it atomically.
   * `--force` is passed because every target this publisher chooses lives
   * under its own deterministic `_attachments/...` namespace, so replacing
   * an earlier copy of the same source asset is the intended outcome.
   *
   * @param localPath Absolute path of the asset on the local filesystem.
   * @param vaultPath Vault-relative destination; never a `.md` note.
   * @throws ObsidianCliError when the CLI refuses or fails the copy.
   */
  async attachFile(localPath: string, vaultPath: string): Promise<void> {
    assertVaultRelative(vaultPath);
    if (/\.(md|markdown)$/i.test(vaultPath)) {
      throw new Error(`refusing to attach a Markdown note as an asset: ${vaultPath}`);
    }
    const result = await this.run(["attach", localPath, vaultPath, "--force"], null);
    if (result.code !== 0) throw toError("attach", vaultPath, result);
  }
}

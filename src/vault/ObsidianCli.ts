/**
 * Typed wrapper around the `obsidian-cli` process.
 *
 * Every call passes an argument array with no shell, and note bytes travel on
 * stdin, so Markdown containing backticks or `$(...)` can never be expanded.
 * Exit codes follow the CLI's documented contract: 3 is a compare-and-swap
 * conflict (including a create-only collision) and 4 is a fail-closed refusal
 * to touch a note that uses setext headings.
 */

import { spawn } from "node:child_process";
import type { CliResult, CliRunner } from "./types";

/** Default location of the vault CLI. */
export const OBSIDIAN_CLI_PATH = `${process.env.HOME ?? ""}/ai-stack/bin/obsidian-cli`;

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

/** Exit 4: the note uses setext headings and was left untouched. */
export class HeadingFormatError extends ObsidianCliError {
  constructor(message: string, stderr: string) {
    super(message, 4, stderr);
    this.name = "HeadingFormatError";
  }
}

/** Exit 1 with a "heading not found" diagnostic. */
export class HeadingNotFoundError extends ObsidianCliError {
  constructor(message: string, stderr: string) {
    super(message, 1, stderr);
    this.name = "HeadingNotFoundError";
  }
}

/** Recognizes the CLI's missing-note diagnostic. */
const isNotFound = (stderr: string): boolean => /not a file:/.test(stderr);

/** Recognizes the CLI's missing-heading diagnostic. */
const isHeadingNotFound = (stderr: string): boolean => /heading not found/.test(stderr);

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
  options: { vaultPath?: string; cliPath?: string } = {},
): CliRunner {
  const cliPath = options.cliPath ?? OBSIDIAN_CLI_PATH;
  const env = options.vaultPath
    ? { ...process.env, OBSIDIAN_VAULT: options.vaultPath }
    : process.env;

  return (args, stdin) =>
    new Promise<CliResult>((resolve, reject) => {
      const child = spawn(cliPath, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

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
  if (result.code === 4) return new HeadingFormatError(message, result.stderr);
  if (result.code === 1 && isHeadingNotFound(result.stderr)) {
    return new HeadingNotFoundError(message, result.stderr);
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
}

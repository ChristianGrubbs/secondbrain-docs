/**
 * End-to-end checks for the fork's CLI-only `sb-docs` executable.
 *
 * These spawn the built `dist/vault-cli.js` DIRECTLY rather than through
 * `node`, so a missing shebang, a missing executable bit, a missing package bin
 * mapping or an undefined build-time global fails here instead of at install
 * time. They also assert that a plain CLI invocation opens no listening socket:
 * the vault CLI must never start the upstream MCP, HTTP or worker servers.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const vaultCliEntry = path.join(projectRoot, "dist", "vault-cli.js");
const listenGuard = path.join(projectRoot, "test", "fixtures", "vault-cli", "no-listen-guard.mjs");

interface VaultCliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** One entry per `net.Server.prototype.listen` call made by the child. */
  listenCalls: string[];
}

/**
 * Runs the built vault CLI executable directly and captures its output plus any
 * listening-socket attempts.
 *
 * @param args Arguments passed to the executable.
 * @returns Exit status, captured streams, and recorded listen calls.
 */
async function runVaultCli(args: string[]): Promise<VaultCliRun> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-listen-"));
  const logPath = path.join(logDir, "listen.log");

  try {
    return await new Promise<VaultCliRun>((resolve, reject) => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        `--import ${pathToFileURL(listenGuard).href}`,
      ]
        .filter(Boolean)
        .join(" ");

      // Deliberately NOT `spawn("node", [vaultCliEntry, ...])`.
      const proc = spawn(vaultCliEntry, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITEST_WORKER_ID: undefined,
          NODE_OPTIONS: nodeOptions,
          SB_DOCS_LISTEN_LOG: logPath,
        },
        timeout: 20_000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("error", (err) => {
        reject(
          new Error(
            `Failed to execute ${vaultCliEntry} directly: ${err.message}. ` +
              "Build the fork with `npm run build` before running this suite.",
          ),
        );
      });

      proc.on("close", (code, signal) => {
        const listenCalls = fs.existsSync(logPath)
          ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
          : [];
        resolve({ code, signal, stdout, stderr, listenCalls });
      });
    });
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

describe("sb-docs CLI E2E", () => {
  it("shows help with --help and exits 0", async () => {
    const { code, stdout } = await runVaultCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("sb-docs");
    expect(stdout).toContain("Usage:");
  });

  it("opens no listening socket when showing help", async () => {
    const { listenCalls } = await runVaultCli(["--help"]);
    expect(listenCalls).toEqual([]);
  });

  it("prints help naming every planned command when given no arguments", async () => {
    const { code, stdout, stderr } = await runVaultCli([]);
    const output = `${stdout}${stderr}`;

    // No arguments must reach the help/usage path, never a resident service.
    expect(code).not.toBeNull();
    expect(output).toContain("Usage:");
    for (const command of ["capture", "search", "read", "reindex", "doctor"]) {
      expect(output).toContain(command);
    }
  });

  it("opens no listening socket when given no arguments", async () => {
    const { listenCalls } = await runVaultCli([]);
    expect(listenCalls).toEqual([]);
  });

  it("reports its version from the injected build global", async () => {
    const { code, stdout } = await runVaultCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
});

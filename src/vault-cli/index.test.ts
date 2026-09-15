import { describe, expect, it } from "vitest";
import { createVaultCli } from "./index";

/**
 * Builds a vault CLI that throws instead of printing and exiting, so parse
 * failures are observable as rejected promises inside the test process.
 */
async function parseVaultCli(args: string[]) {
  // `async` so yargs' synchronous validation throw surfaces as a rejection.
  return await createVaultCli(args).exitProcess(false).fail(false).parseAsync();
}

describe("createVaultCli", () => {
  it("uses sb-docs as the script name", async () => {
    const help = await createVaultCli([]).getHelp();
    expect(help).toContain("sb-docs");
  });

  it("demands a command and names the planned command set", async () => {
    await expect(parseVaultCli([])).rejects.toThrow(
      "Choose capture, search, read, reindex, or doctor",
    );
  });

  it("does not register any upstream server command", async () => {
    const help = await createVaultCli([]).getHelp();
    for (const serverCommand of ["mcp", "web", "worker"]) {
      expect(help).not.toContain(`sb-docs ${serverCommand}`);
    }
  });

  it("registers the doctor command", async () => {
    const help = await createVaultCli([]).getHelp();
    expect(help).toContain("doctor");
  });

  it("registers the capture command", async () => {
    const help = await createVaultCli([]).getHelp();
    expect(help).toContain("capture");
  });

  it("rejects an unknown command instead of exiting zero doing nothing", async () => {
    // `.strict()` can only reject a stray positional once a real command is
    // registered, which `doctor` now is.
    await expect(parseVaultCli(["bogus"])).rejects.toThrow(/Unknown argument: bogus/);
  });

  // Boolean negation is disabled program-wide so that the declared
  // `capture --no-index` flag parses (2026-09-15). The deliberate consequence
  // is that the never-documented `--no-<flag>` forms are unknown arguments on
  // every command; `--json` itself defaults to false, so nothing is lost.
  it.each([
    ["capture", ["capture", "https://example.com/"]],
    ["search", ["search", "phrase"]],
    ["reindex", ["reindex"]],
    ["doctor", ["doctor"]],
  ])(
    "%s still lists --json but rejects the negated --no-json form",
    async (_name, argv) => {
      const help = await createVaultCli(argv).getHelp();
      expect(help).toContain("--json");
      await expect(parseVaultCli([...argv, "--no-json"])).rejects.toThrow(
        /Unknown arguments?: no-json/,
      );
    },
  );
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotLiveVault, isInsideLiveVault } from "./vault-guard.mjs";

describe("vault-guard", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vault-guard-test-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("reports false for an unrelated throwaway path", () => {
    const liveVault = path.join(scratch, "live-vault");
    fs.mkdirSync(liveVault);
    const throwaway = path.join(scratch, "throwaway-vault");

    expect(isInsideLiveVault(throwaway, liveVault)).toBe(false);
    expect(() => assertNotLiveVault(throwaway, liveVault)).not.toThrow();
  });

  it("reports true for the live vault path itself", () => {
    const liveVault = path.join(scratch, "live-vault");
    fs.mkdirSync(liveVault);

    expect(isInsideLiveVault(liveVault, liveVault)).toBe(true);
    expect(() => assertNotLiveVault(liveVault, liveVault)).toThrow(/live vault/);
  });

  it("reports true for a literal subdirectory of the live vault", () => {
    const liveVault = path.join(scratch, "live-vault");
    fs.mkdirSync(path.join(liveVault, "00 Inbox"), { recursive: true });
    const insideVault = path.join(liveVault, "00 Inbox", "sneaky-collection");

    expect(isInsideLiveVault(insideVault, liveVault)).toBe(true);
  });

  it(
    // MAJOR 6 (2026-09-13 Codex frontier review): a symlink whose target is
    // the live vault must be caught even though its own path string never
    // literally contains the live vault's path.
    "catches a symlink alias pointing into the live vault (not just a literal path match)",
    () => {
      const liveVault = path.join(scratch, "live-vault");
      fs.mkdirSync(liveVault);
      const alias = path.join(scratch, "alias-into-live-vault");
      fs.symlinkSync(liveVault, alias);

      expect(isInsideLiveVault(alias, liveVault)).toBe(true);
      expect(() => assertNotLiveVault(alias, liveVault)).toThrow(/live vault/);
    },
  );

  it(
    // A destination that does not exist yet (the common case: a throwaway
    // vault directory the caller is about to mkdir) is still checked
    // correctly when its *existing* ancestor is a symlink alias.
    "catches a symlink alias even when the exact destination hasn't been created yet",
    () => {
      const liveVault = path.join(scratch, "live-vault");
      fs.mkdirSync(liveVault);
      const alias = path.join(scratch, "alias-into-live-vault");
      fs.symlinkSync(liveVault, alias);
      const notYetCreated = path.join(alias, "some", "nested", "collection");

      expect(isInsideLiveVault(notYetCreated, liveVault)).toBe(true);
    },
  );

  it(
    // MAJOR 6: an absent live vault (e.g. a machine where it isn't mounted)
    // must not throw ENOENT out of the guard -- it should just mean nothing
    // can be an alias into it.
    "handles an absent live vault path without throwing",
    () => {
      const liveVault = path.join(scratch, "does-not-exist", "live-vault");
      const throwaway = path.join(scratch, "throwaway-vault");

      expect(() => isInsideLiveVault(throwaway, liveVault)).not.toThrow();
      expect(isInsideLiveVault(throwaway, liveVault)).toBe(false);
      expect(() => assertNotLiveVault(throwaway, liveVault)).not.toThrow();
    },
  );

  it("does not false-positive on a sibling directory with a similar name prefix", () => {
    const liveVault = path.join(scratch, "live-vault");
    fs.mkdirSync(liveVault);
    const sibling = path.join(scratch, "live-vault-backup");

    expect(isInsideLiveVault(sibling, liveVault)).toBe(false);
  });
});

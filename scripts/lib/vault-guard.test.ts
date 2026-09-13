import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNotLiveVault, assertNotSymlink, isInsideLiveVault, isSymlinkPath } from "./vault-guard.mjs";

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

  it(
    // MAJOR A (2026-09-13 Codex frontier review, round 2): a real *existing*
    // child of the live vault whose own name starts with ".." must still be
    // reported as inside. `path.relative(liveVault, liveVault/"..qualification-probe")`
    // returns the literal string "..qualification-probe", which the old
    // `!relative.startsWith("..")` check misclassified as parent traversal
    // (outside) -- exactly backwards, since this path is INSIDE the live
    // vault.
    "reports true for an existing child whose own name starts with '..'",
    () => {
      const liveVault = path.join(scratch, "live-vault");
      const dottedChild = path.join(liveVault, "..qualification-probe");
      fs.mkdirSync(dottedChild, { recursive: true });

      expect(isInsideLiveVault(dottedChild, liveVault)).toBe(true);
      expect(() => assertNotLiveVault(dottedChild, liveVault)).toThrow(/live vault/);
    },
  );

  it(
    "reports true for a NOT-YET-CREATED child whose own name starts with '..'",
    () => {
      const liveVault = path.join(scratch, "live-vault");
      fs.mkdirSync(liveVault);
      const dottedChild = path.join(liveVault, "..qualification-probe");

      expect(isInsideLiveVault(dottedChild, liveVault)).toBe(true);
    },
  );

  it(
    // Negative control: proves the finding is real by reproducing the old,
    // buggy string-prefix check side by side with the fixed one on the same
    // fixture. The old logic reports this dangerous case as OUTSIDE
    // (false); the fixed `isInsideLiveVault` reports it correctly as
    // INSIDE (true).
    "the old startsWith('..') string-prefix check would have missed this (regression demonstration)",
    () => {
      const liveVault = path.join(scratch, "live-vault");
      const dottedChild = path.join(liveVault, "..qualification-probe");
      fs.mkdirSync(dottedChild, { recursive: true });

      const relative = path.relative(fs.realpathSync(liveVault), fs.realpathSync(dottedChild));
      const oldBuggyIsInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

      expect(oldBuggyIsInside).toBe(false);
      expect(isInsideLiveVault(dottedChild, liveVault)).toBe(true);
    },
  );

  it("catches a symlink alias whose own name starts with '..'", () => {
    const liveVault = path.join(scratch, "live-vault");
    fs.mkdirSync(liveVault);
    const dottedAlias = path.join(scratch, "..alias-into-live-vault");
    fs.symlinkSync(liveVault, dottedAlias);

    expect(isInsideLiveVault(dottedAlias, liveVault)).toBe(true);
  });

  it("does not misclassify a genuine parent-traversal path as inside", () => {
    const liveVault = path.join(scratch, "nested", "live-vault");
    fs.mkdirSync(liveVault, { recursive: true });
    const outsideViaTraversal = path.join(scratch, "sibling-of-nested");
    fs.mkdirSync(outsideViaTraversal, { recursive: true });

    expect(isInsideLiveVault(outsideViaTraversal, liveVault)).toBe(false);
  });

  describe(
    // MAJOR 1 (2026-09-13 Codex frontier review, round 5): a DANGLING
    // symlink's target cannot be `realpathSync`-resolved, so
    // `isInsideLiveVault`/`resolveNearestExistingAncestor` cannot see
    // through it at all. `isSymlinkPath`/`assertNotSymlink` catch the
    // symlink itself, independent of whether its target exists.
    "isSymlinkPath / assertNotSymlink",
    () => {
      it("reports false for a plain file", () => {
        const plainFile = path.join(scratch, "plain-file.txt");
        fs.writeFileSync(plainFile, "hello\n");
        expect(isSymlinkPath(plainFile)).toBe(false);
      });

      it("reports false for a path that does not exist at all", () => {
        expect(isSymlinkPath(path.join(scratch, "does-not-exist"))).toBe(false);
      });

      it("reports true for a symlink whose target exists", () => {
        const target = path.join(scratch, "target-file.txt");
        fs.writeFileSync(target, "hello\n");
        const link = path.join(scratch, "link-to-target");
        fs.symlinkSync(target, link);
        expect(isSymlinkPath(link)).toBe(true);
      });

      it("reports true for a DANGLING symlink whose target does not exist", () => {
        const link = path.join(scratch, "dangling-link");
        fs.symlinkSync(path.join(scratch, "nonexistent-target"), link);
        expect(isSymlinkPath(link)).toBe(true);
      });

      it("assertNotSymlink throws for a symlink and is silent for a plain path", () => {
        const plainFile = path.join(scratch, "plain-file-2.txt");
        fs.writeFileSync(plainFile, "hello\n");
        const link = path.join(scratch, "another-dangling-link");
        fs.symlinkSync(path.join(scratch, "nonexistent-target-2"), link);

        expect(() => assertNotSymlink(link, "config.yaml")).toThrow(/symlinked config\.yaml/);
        expect(() => assertNotSymlink(plainFile, "config.yaml")).not.toThrow();
      });
    },
  );
});

/**
 * The throwaway-vault guard `scripts/live-check-vault.mjs` uses before any
 * live capture. Extracted into its own importable module so it is unit
 * testable (Task 6 qualification, MAJOR 6, 2026-09-13 Codex frontier
 * review): the guard must canonicalize the *supplied* destination too, not
 * only the known live-vault path, so a symlink alias pointing into the live
 * vault cannot bypass it — and it must not crash when the live vault path
 * does not exist on the current machine (e.g. a CI box, or before the vault
 * is ever mounted).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Resolves the real (symlink-free) path of the nearest existing ancestor of
 * `targetPath`, then re-appends the non-existent tail segments unresolved.
 *
 * This lets a not-yet-created destination (e.g. a throwaway vault directory
 * that `mkdirSync` hasn't made yet) still be checked against a real,
 * symlink-resolved boundary: only the part of the path that already exists
 * can possibly be a symlink alias.
 *
 * @param {string} targetPath Absolute or relative path to canonicalize.
 * @returns {string} The canonical form: real ancestor + literal tail.
 */
export function resolveNearestExistingAncestor(targetPath) {
  const absolute = path.resolve(targetPath);
  let existing = absolute;
  const tail = [];
  // Walk up until an existing ancestor is found. `path.dirname` of the
  // filesystem root returns itself, which bounds the loop.
  while (true) {
    try {
      const real = fs.realpathSync(existing);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        // Reached the root and nothing on the path exists; nothing to
        // resolve further than the literal absolute path itself.
        return absolute;
      }
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Reports whether `candidatePath` is the live vault itself or somewhere
 * inside it, after resolving both through symlinks (so a symlink alias
 * pointing into the live vault is caught, not just a direct path match).
 *
 * A live-vault path that does not exist on this machine is handled
 * explicitly: nothing can be a real symlink alias into a path that isn't
 * there, so the check safely reports `false` for every candidate rather than
 * throwing `ENOENT` out of `realpathSync`.
 *
 * @param {string} candidatePath The destination a caller wants to use.
 * @param {string} liveVaultPath The operator's real vault path.
 * @returns {boolean} True if `candidatePath` resolves inside `liveVaultPath`.
 */
export function isInsideLiveVault(candidatePath, liveVaultPath) {
  let liveVaultReal;
  try {
    liveVaultReal = fs.realpathSync(liveVaultPath);
  } catch {
    // The live vault does not exist on this machine at all: no path can be
    // a symlink alias into something that isn't there.
    return false;
  }

  const candidateReal = resolveNearestExistingAncestor(candidatePath);
  const relative = path.relative(liveVaultReal, candidateReal);
  // MAJOR A (2026-09-13 Codex frontier review, round 2): a real *child* of
  // the live vault whose own name happens to start with ".." (e.g.
  // "..qualification-probe") produces a `path.relative` result like
  // "..qualification-probe" — a literal string prefix match on ".." was
  // wrongly treating that as parent traversal (outside) when it is actually
  // inside. Only `".."` exactly, or a value starting with `".." + path.sep`
  // (an actual "up a level, then into X" traversal), means outside. An
  // empty string means an exact match (the live vault itself); an absolute
  // `relative` (Windows drive-mismatch shape, not reachable on POSIX) is
  // never treated as inside.
  const isParentTraversal = relative === ".." || relative.startsWith(`..${path.sep}`);
  return relative === "" || (!isParentTraversal && !path.isAbsolute(relative));
}

/**
 * Throws if `candidatePath` is the live vault or a symlink alias into it.
 *
 * @param {string} candidatePath The destination a caller wants to use.
 * @param {string} liveVaultPath The operator's real vault path.
 */
export function assertNotLiveVault(candidatePath, liveVaultPath) {
  if (isInsideLiveVault(candidatePath, liveVaultPath)) {
    throw new Error(
      `refusing to run against the operator's live vault (or a symlink alias into it): ${liveVaultPath}`,
    );
  }
}

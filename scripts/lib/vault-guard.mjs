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
/**
 * Reports whether `candidatePath` itself is a symlink (dangling or not),
 * without following it.
 *
 * `lstatSync` (unlike `realpathSync`/`existsSync`) inspects the path entry
 * itself rather than its resolved target, so this correctly reports `true`
 * for a symlink whose target does not exist (a "dangling" symlink) — the
 * exact shape `resolveNearestExistingAncestor` cannot see, because
 * `realpathSync` throws on a dangling symlink and the caller falls back to
 * treating the symlink's own (non-live-vault) parent directory as the
 * canonical location (MAJOR 1, 2026-09-13 Codex frontier review, round 5).
 *
 * @param {string} candidatePath
 * @returns {boolean}
 */
export function isSymlinkPath(candidatePath) {
  try {
    return fs.lstatSync(candidatePath).isSymbolicLink();
  } catch {
    return false;
  }
}

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

/**
 * Throws if `candidatePath` is itself a symlink, dangling or not.
 *
 * Chosen deliberately over "resolve the symlink's target and containment-
 * check that instead": a dangling symlink's target cannot be
 * `realpathSync`-resolved at all (nothing exists there yet to canonicalize
 * through), so any resolution scheme for it is itself unverifiable. A flat
 * "no symlinks here" rule for a live-write-sensitive path (a state
 * directory or its config file) is simpler, is unconditionally safe against
 * both an existing-target and a dangling-target alias into the live vault,
 * and never allows a case this guard cannot fully verify.
 *
 * @param {string} candidatePath
 * @param {string} label Human-readable description used in the error message.
 */
export function assertNotSymlink(candidatePath, label) {
  if (isSymlinkPath(candidatePath)) {
    throw new Error(
      `refusing to use a symlinked ${label} -- symlinks are never permitted here because a dangling one can alias the live vault without being resolvable: ${candidatePath}`,
    );
  }
}

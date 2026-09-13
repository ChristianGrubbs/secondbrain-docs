import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGuardedState } from "./live-check-vault.mjs";

describe(
  // MAJOR 2 (2026-09-13 Codex frontier review, round 4): only `--vault`
  // went through the live-vault guard in this script -- a supplied
  // `--state-dir` inside the live vault (or a symlink alias into it) was
  // created and its config.yaml overwritten immediately, before any
  // capture ran. `resolveGuardedState` is the extracted, pure (no
  // filesystem writes) validation `live-check-vault.mjs` itself calls, so
  // this proves rejection happens before any write using a fake live-vault
  // path -- never the real one.
  "live-check-vault: resolveGuardedState",
  () => {
    let scratch: string;
    let fakeLiveVault: string;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "live-check-vault-test-"));
      fakeLiveVault = path.join(scratch, "fake-live-vault");
      fs.mkdirSync(fakeLiveVault, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    it("accepts a throwaway state dir outside the live vault, without writing anything", () => {
      const stateDirArg = path.join(scratch, "throwaway-state");
      const result = resolveGuardedState({
        stateDirArg,
        liveVaultPath: fakeLiveVault,
        overwriteConfig: false,
      });

      expect(result.stateDir).toBe(path.resolve(stateDirArg));
      expect(result.configPreexisted).toBe(false);
      // No filesystem write happened -- the directory was never created by
      // this function.
      expect(fs.existsSync(result.stateDir)).toBe(false);
    });

    it("rejects a state dir that IS the live vault, before any write", () => {
      expect(() =>
        resolveGuardedState({
          stateDirArg: fakeLiveVault,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: false,
        }),
      ).toThrow(/live vault/);
    });

    it("rejects a state dir literally inside the live vault, before any write", () => {
      const insideLiveVault = path.join(fakeLiveVault, "some-state-dir");
      expect(() =>
        resolveGuardedState({
          stateDirArg: insideLiveVault,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: false,
        }),
      ).toThrow(/live vault/);
      expect(fs.existsSync(insideLiveVault)).toBe(false);
      expect(fs.existsSync(path.join(insideLiveVault, "config.yaml"))).toBe(false);
    });

    it("rejects a symlink alias into the live vault, before any write", () => {
      const alias = path.join(scratch, "alias-into-live-vault");
      fs.symlinkSync(fakeLiveVault, alias);

      expect(() =>
        resolveGuardedState({
          stateDirArg: alias,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: false,
        }),
      ).toThrow(/live vault/);
      // Nothing was written into the real target through the alias.
      expect(fs.readdirSync(fakeLiveVault)).toEqual([]);
    });

    it("rejects a symlink alias to a not-yet-created child of the live vault, before any write", () => {
      const alias = path.join(scratch, "alias-into-live-vault-2");
      fs.symlinkSync(fakeLiveVault, alias);
      const notYetCreatedStateDir = path.join(alias, "nested", "state");

      expect(() =>
        resolveGuardedState({
          stateDirArg: notYetCreatedStateDir,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: false,
        }),
      ).toThrow(/live vault/);
      expect(fs.readdirSync(fakeLiveVault)).toEqual([]);
    });

    it("refuses to overwrite an existing config.yaml without --overwrite-config, and leaves its bytes untouched", () => {
      const stateDirArg = path.join(scratch, "existing-state");
      fs.mkdirSync(stateDirArg, { recursive: true });
      const configFile = path.join(stateDirArg, "config.yaml");
      const existingBytes = "# a pre-existing config\nfoo: bar\n";
      fs.writeFileSync(configFile, existingBytes, "utf8");

      expect(() =>
        resolveGuardedState({
          stateDirArg,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: false,
        }),
      ).toThrow(/refusing to overwrite/);
      expect(fs.readFileSync(configFile, "utf8")).toBe(existingBytes);
    });

    it("allows overwriting an existing config.yaml when --overwrite-config is set (validation only, still no write here)", () => {
      const stateDirArg = path.join(scratch, "existing-state-2");
      fs.mkdirSync(stateDirArg, { recursive: true });
      const configFile = path.join(stateDirArg, "config.yaml");
      const existingBytes = "# a pre-existing config\nfoo: bar\n";
      fs.writeFileSync(configFile, existingBytes, "utf8");

      const result = resolveGuardedState({
        stateDirArg,
        liveVaultPath: fakeLiveVault,
        overwriteConfig: true,
      });

      expect(result.configPreexisted).toBe(true);
      expect(result.configFile).toBe(configFile);
      // resolveGuardedState performs no writes itself; the existing bytes
      // are still there after validation succeeds.
      expect(fs.readFileSync(configFile, "utf8")).toBe(existingBytes);
    });

    it("still refuses an overwrite when --overwrite-config is set but the config path is inside the live vault", () => {
      const insideLiveVault = path.join(fakeLiveVault, "some-state-dir");
      fs.mkdirSync(insideLiveVault, { recursive: true });
      fs.writeFileSync(path.join(insideLiveVault, "config.yaml"), "should never be touched\n");

      expect(() =>
        resolveGuardedState({
          stateDirArg: insideLiveVault,
          liveVaultPath: fakeLiveVault,
          overwriteConfig: true,
        }),
      ).toThrow(/live vault/);
      expect(fs.readFileSync(path.join(insideLiveVault, "config.yaml"), "utf8")).toBe(
        "should never be touched\n",
      );
    });
  },
);

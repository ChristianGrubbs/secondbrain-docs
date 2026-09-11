/**
 * Durable-state tests: journal phases, ownership records, the interprocess
 * lock, and the refusal to keep runtime state inside the vault.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "./identity";
import {
  createJsonlLogger,
  LockTimeoutError,
  PublicationJournal,
  resolveStateDir,
  StatePathError,
} from "./PublicationJournal";

let stateDir: string;
let vaultDir: string;
const temporaries: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

beforeEach(() => {
  stateDir = makeTempDir("sb-docs-state-");
  vaultDir = makeTempDir("sb-docs-vault-");
});

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeJournal(overrides: Record<string, unknown> = {}): PublicationJournal {
  return new PublicationJournal({ stateDir, vaultPath: vaultDir, ...overrides });
}

const NOTE = "---\ntype: source\n---\nbody\n";

describe("resolveStateDir", () => {
  it("accepts a directory outside the vault", () => {
    expect(resolveStateDir({ stateDir, vaultPath: vaultDir })).toBe(
      fs.realpathSync(stateDir),
    );
  });

  it("rejects a state directory inside the vault", () => {
    expect(() =>
      resolveStateDir({ stateDir: path.join(vaultDir, "state"), vaultPath: vaultDir }),
    ).toThrow(StatePathError);
  });

  it("rejects the vault directory itself", () => {
    expect(() => resolveStateDir({ stateDir: vaultDir, vaultPath: vaultDir })).toThrow(
      StatePathError,
    );
  });

  it("rejects a state directory that reaches the vault through a symlink", () => {
    const aliasParent = makeTempDir("sb-docs-alias-");
    const alias = path.join(aliasParent, "vault-alias");
    fs.symlinkSync(vaultDir, alias);

    // The deepest EXISTING ancestor is the symlink itself, so a path that does
    // not exist yet still has to be canonicalized before comparison.
    expect(() =>
      resolveStateDir({ stateDir: path.join(alias, "state"), vaultPath: vaultDir }),
    ).toThrow(StatePathError);
  });

  it("canonicalizes the vault side of the comparison too", () => {
    const aliasParent = makeTempDir("sb-docs-alias2-");
    const alias = path.join(aliasParent, "vault-alias");
    fs.symlinkSync(vaultDir, alias);

    expect(() =>
      resolveStateDir({ stateDir: path.join(vaultDir, "state"), vaultPath: alias }),
    ).toThrow(StatePathError);
  });
});

describe("PublicationJournal phases", () => {
  it("starts with no pending entries", () => {
    expect(makeJournal().pending()).toEqual([]);
  });

  it("records a prepared entry with both digests and the proposed bytes", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "00 Inbox/Source Captures/note abc123.md",
      priorWholeNoteDigest: sha256("old"),
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    const [entry] = journal.pending();
    expect(entry.phase).toBe("prepared");
    expect(entry.sourceId).toBe("abc123");
    expect(entry.priorWholeNoteDigest).toBe(sha256("old"));
    expect(entry.proposedWholeNoteDigest).toBe(sha256(NOTE));
    expect(journal.proposedBytes("abc123")).toBe(NOTE);
  });

  it("advances through the documented phases", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    journal.advance("abc123", "note-written");
    expect(journal.entry("abc123")?.phase).toBe("note-written");

    journal.advance("abc123", "moc-linked");
    expect(journal.entry("abc123")?.phase).toBe("moc-linked");

    journal.complete("abc123");
    expect(journal.pending()).toEqual([]);
    expect(journal.proposedBytes("abc123")).toBeNull();
  });

  it("writes the entry through a temporary file and an atomic rename", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    // No half-written temporary survives a successful write.
    const files = fs.readdirSync(path.join(journal.stateDir, "journal"));
    expect(files.some((name) => name.includes(".tmp-"))).toBe(false);
    expect(files).toContain("abc123.json");
  });

  it("survives a new journal instance over the same state directory", () => {
    makeJournal().prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    expect(makeJournal().pending()).toHaveLength(1);
  });

  it("keys state by a sanitized identity so a hostile source id cannot escape", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "../../escaped",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    expect(fs.existsSync(path.join(stateDir, "..", "..", "escaped.json"))).toBe(false);
    expect(journal.entry("../../escaped")?.sourceId).toBe("../../escaped");
  });

  it("refuses a state directory inside the vault at construction", () => {
    expect(
      () => new PublicationJournal({ stateDir: vaultDir, vaultPath: vaultDir }),
    ).toThrow(StatePathError);
  });
});

describe("PublicationJournal ownership", () => {
  it("stores and reads back an ownership record outside the vault", () => {
    const journal = makeJournal();
    journal.writeOwnership({ sourceId: "abc123", path: "note.md", digest: sha256(NOTE) });

    const record = journal.readOwnership("abc123");
    expect(record?.digest).toBe(sha256(NOTE));
    expect(record?.path).toBe("note.md");
    expect(typeof record?.lastSeenAt).toBe("string");
    expect(fs.existsSync(path.join(vaultDir, "abc123.json"))).toBe(false);
  });

  it("counts ownership records for diagnostics", () => {
    const journal = makeJournal();
    expect(journal.ownershipCount()).toBe(0);
    journal.writeOwnership({ sourceId: "a", path: "a.md", digest: sha256("a") });
    journal.writeOwnership({ sourceId: "b", path: "b.md", digest: sha256("b") });
    expect(journal.ownershipCount()).toBe(2);
  });

  it("keeps last_seen_at in the record rather than in the note", () => {
    const journal = makeJournal();
    journal.writeOwnership({
      sourceId: "abc123",
      path: "note.md",
      digest: sha256(NOTE),
      lastSeenAt: "2026-09-11T00:00:00.000Z",
    });

    expect(journal.readOwnership("abc123")?.lastSeenAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("returns null for an unknown source", () => {
    expect(makeJournal().readOwnership("nope")).toBeNull();
  });
});

describe("PublicationJournal lock", () => {
  it("serializes two journals over one state directory", async () => {
    const first = makeJournal();
    const second = makeJournal({ lock: { pollMs: 5 } });
    const observed: string[] = [];

    await Promise.all([
      first.withLock("abc123", async () => {
        observed.push("first:enter");
        await new Promise((resolve) => setTimeout(resolve, 40));
        observed.push("first:exit");
      }),
      second.withLock("abc123", async () => {
        observed.push("second:enter");
        observed.push("second:exit");
      }),
    ]);

    // Whatever the order, neither critical section interleaves with the other.
    const firstEnter = observed.indexOf("first:enter");
    const firstExit = observed.indexOf("first:exit");
    expect(firstExit).toBe(firstEnter + 1);
  });

  it("does not serialize different sources", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 200, pollMs: 5 } });
    let inside = 0;
    let concurrent = 0;

    await Promise.all(
      ["a", "b"].map((id) =>
        journal.withLock(id, async () => {
          inside += 1;
          concurrent = Math.max(concurrent, inside);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inside -= 1;
        }),
      ),
    );

    expect(concurrent).toBe(2);
  });

  it("releases the lock when the critical section throws", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 200, pollMs: 5 } });

    await expect(
      journal.withLock("abc123", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(journal.withLock("abc123", async () => "ok")).resolves.toBe("ok");
  });

  it("times out rather than stealing a fresh lock held by a live process", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 60, pollMs: 5 } });
    const lockDir = path.join(stateDir, "locks", "abc123.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
      }),
    );

    await expect(journal.withLock("abc123", async () => "ok")).rejects.toThrow(
      LockTimeoutError,
    );
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("breaks a lock whose owning process is gone", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 500, pollMs: 5 } });
    const lockDir = path.join(stateDir, "locks", "abc123.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        // Chosen by the test, not observed: a pid that no live process holds.
        pid: 2_147_483_646,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
      }),
    );

    await expect(journal.withLock("abc123", async () => "ok")).resolves.toBe("ok");
  });

  it("breaks a lock older than the staleness window", async () => {
    const journal = makeJournal({
      lock: { timeoutMs: 500, pollMs: 5, staleAfterMs: 50 },
    });
    const lockDir = path.join(stateDir, "locks", "abc123.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        host: "some-other-host",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      }),
    );

    await expect(journal.withLock("abc123", async () => "ok")).resolves.toBe("ok");
  });
});

describe("createJsonlLogger", () => {
  it("writes nothing when logging is disabled", () => {
    const file = path.join(stateDir, "events.jsonl");
    const log = createJsonlLogger({ filePath: file, enabled: false });

    log({ level: "info", event: "capture.decision", loc: "test", ctx: { a: 1 } });

    expect(fs.existsSync(file)).toBe(false);
  });

  it("emits one JSON object per line with the required fields", () => {
    const file = path.join(stateDir, "logs", "events.jsonl");
    const log = createJsonlLogger({ filePath: file, enabled: true, runId: "run-1" });

    log({
      level: "info",
      event: "capture.decision",
      loc: "test",
      ctx: { decision: "x" },
    });

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.run_id).toBe("run-1");
    expect(record.event).toBe("capture.decision");
    expect(record.level).toBe("info");
    expect(record.loc).toBe("test");
    expect(record.ctx).toEqual({ decision: "x" });
    expect(typeof record.ts).toBe("string");
  });

  it("is enabled by the SB_DOCS_LOG environment variable", () => {
    const file = path.join(stateDir, "env.jsonl");
    const previous = process.env.SB_DOCS_LOG;
    process.env.SB_DOCS_LOG = "1";
    try {
      createJsonlLogger({ filePath: file })({
        level: "info",
        event: "e",
        loc: "l",
        ctx: {},
      });
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SB_DOCS_LOG;
      else process.env.SB_DOCS_LOG = previous;
    }
  });
});

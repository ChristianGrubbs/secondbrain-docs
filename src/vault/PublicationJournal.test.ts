/**
 * Durable-state tests: journal phases, ownership records, the interprocess
 * lock, and the refusal to keep runtime state inside the vault.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
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

// Regressions for the 2026-09-11 Codex review of commit ca3c3ad.
describe("PublicationJournal lock ownership", () => {
  const lockDirFor = (id: string) => path.join(stateDir, "locks", `${id}.lock`);

  /** Writes a lock directory owned by somebody else. */
  function plantLock(id: string, owner: Record<string, unknown>): string {
    const lockDir = lockDirFor(id);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner));
    return lockDir;
  }

  it("never expires a lock whose local owner is still alive, however old it looks", async () => {
    // The staleness window exists for crashed holders, not slow ones. A live
    // local pid is proof the holder is still working.
    const journal = makeJournal({
      lock: { timeoutMs: 60, pollMs: 5, staleAfterMs: 1 },
    });
    const lockDir = plantLock("abc123", {
      pid: process.pid,
      host: os.hostname(),
      token: "somebody-elses-token",
      acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    fs.utimesSync(
      lockDir,
      new Date(Date.now() - 3_600_000),
      new Date(Date.now() - 3_600_000),
    );

    await expect(journal.withLock("abc123", async () => "ok")).rejects.toThrow(
      LockTimeoutError,
    );
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).token,
    ).toBe("somebody-elses-token");
  });

  it("refreshes its own heartbeat while it holds the lock", async () => {
    const journal = makeJournal({
      lock: { timeoutMs: 500, pollMs: 5, staleAfterMs: 60, heartbeatMs: 15 },
    });

    const beats = await journal.withLock("abc123", async () => {
      const first = JSON.parse(
        fs.readFileSync(path.join(lockDirFor("abc123"), "owner.json"), "utf8"),
      ).heartbeatAt;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = JSON.parse(
        fs.readFileSync(path.join(lockDirFor("abc123"), "owner.json"), "utf8"),
      ).heartbeatAt;
      return { first, second };
    });

    expect(beats.second).not.toBe(beats.first);
  });

  it("does not delete a replacement holder's lock when it releases", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 200, pollMs: 5 } });

    await journal.withLock("abc123", async () => {
      // Somebody reclaimed this lock while we were working and is holding it
      // now. Our release must not touch their directory.
      fs.rmSync(lockDirFor("abc123"), { recursive: true, force: true });
      plantLock("abc123", {
        pid: process.pid,
        host: os.hostname(),
        token: "replacement-token",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      });
    });

    expect(fs.existsSync(lockDirFor("abc123"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(lockDirFor("abc123"), "owner.json"), "utf8"))
        .token,
    ).toBe("replacement-token");
  });

  it("lets exactly one of two simultaneous reclaimers win a dead owner's lock", async () => {
    plantLock("abc123", {
      // Chosen by the test, not observed: a pid no live process holds.
      pid: 2_147_483_646,
      host: os.hostname(),
      token: "dead-owners-token",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });

    const spans: { enter: number; exit: number }[] = [];
    const contend = (journal: PublicationJournal) =>
      journal.withLock("abc123", async () => {
        const enter = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 30));
        spans.push({ enter, exit: Date.now() });
      });

    await Promise.all([
      contend(makeJournal({ lock: { timeoutMs: 2000, pollMs: 5 } })),
      contend(makeJournal({ lock: { timeoutMs: 2000, pollMs: 5 } })),
    ]);

    expect(spans).toHaveLength(2);
    const [first, second] = spans.sort((a, b) => a.enter - b.enter);
    expect(second.enter).toBeGreaterThanOrEqual(first.exit);
  });
});

describe("PublicationJournal durability", () => {
  it("keeps proposal bytes immutable and content addressed", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    const proposals = fs.readdirSync(path.join(journal.stateDir, "journal", "proposals"));
    expect(proposals).toContain(`${sha256(NOTE)}.md`);
  });

  it("does not let a re-prepared proposal rewrite the bytes an older entry names", () => {
    const journal = makeJournal();
    const first = "---\ntype: source\n---\nfirst\n";
    const second = "---\ntype: source\n---\nsecond\n";

    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(first),
      bytes: first,
    });
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(second),
      bytes: second,
    });

    // Each generation's bytes live under their own digest, so a proposal file
    // can never hold bytes that disagree with the name an entry refers to.
    const proposals = path.join(journal.stateDir, "journal", "proposals");
    for (const name of fs.readdirSync(proposals)) {
      const bytes = fs.readFileSync(path.join(proposals, name), "utf8");
      expect(`${sha256(bytes)}.md`).toBe(name);
    }
    expect(journal.entry("abc123")?.proposedWholeNoteDigest).toBe(sha256(second));
    expect(journal.proposedBytes("abc123")).toBe(second);
  });

  it("reports proposal bytes as missing when they do not match their digest", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    // Corruption, however it happened, must never be served as a proposal.
    fs.writeFileSync(
      path.join(journal.stateDir, "journal", "proposals", `${sha256(NOTE)}.md`),
      "tampered\n",
    );

    expect(journal.proposedBytes("abc123")).toBeNull();
  });

  it("leaves the entry usable when the process dies between the two writes", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    // A death after the proposal write but before the entry write leaves an
    // orphan proposal, never an entry pointing at the wrong bytes.
    const orphan = "---\ntype: source\n---\norphan\n";
    fs.writeFileSync(
      path.join(journal.stateDir, "journal", "proposals", `${sha256(orphan)}.md`),
      orphan,
    );

    const reopened = makeJournal();
    expect(reopened.pending()).toHaveLength(1);
    expect(reopened.proposedBytes("abc123")).toBe(NOTE);
  });

  it("discards an entry and its proposal together", () => {
    const journal = makeJournal();
    journal.prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    journal.complete("abc123");

    expect(journal.pending()).toEqual([]);
    expect(
      fs.existsSync(
        path.join(journal.stateDir, "journal", "proposals", `${sha256(NOTE)}.md`),
      ),
    ).toBe(false);
  });

  it("keeps a proposal another entry still references", () => {
    const journal = makeJournal();
    for (const id of ["a", "b"]) {
      journal.prepare({
        sourceId: id,
        path: `${id}.md`,
        priorWholeNoteDigest: null,
        proposedWholeNoteDigest: sha256(NOTE),
        bytes: NOTE,
      });
    }

    journal.complete("a");

    expect(journal.proposedBytes("b")).toBe(NOTE);
  });

  it("records and reads back a candidate's whole-note digest", () => {
    const journal = makeJournal();
    journal.writeCandidate({ name: "cand.md", path: "x/cand.md", digest: sha256(NOTE) });

    expect(journal.readCandidate("cand.md")).toMatchObject({
      path: "x/cand.md",
      digest: sha256(NOTE),
    });
    expect(journal.readCandidate("missing.md")).toBeNull();
  });
});

describe("PublicationJournal multiprocess lock", () => {
  const viteNode = path.join(process.cwd(), "node_modules", ".bin", "vite-node");
  const fixture = path.join(process.cwd(), "test", "fixtures", "vault", "lock-holder.ts");

  /** A spawned lock holder: no stdin, both output streams piped. */
  type LockHolderProcess = ChildProcessByStdio<null, Readable, Readable>;

  /** Spawns a real child process that takes the lock. */
  function spawnHolder(env: Record<string, string>): LockHolderProcess {
    return spawn(viteNode, [fixture], {
      env: { ...process.env, STATE_DIR: stateDir, VAULT_PATH: vaultDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Resolves with every JSON line the child printed, once it exits. */
  function collect(child: LockHolderProcess): Promise<Record<string, unknown>[]> {
    return new Promise((resolve) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("close", () =>
        resolve(
          out
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line)),
        ),
      );
    });
  }

  /** Waits until the child reports it holds the lock. */
  function waitForAcquire(child: LockHolderProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes('"acquired"')) resolve();
      });
      child.on("close", () => reject(new Error(`child exited before acquiring: ${out}`)));
    });
  }

  it("serializes two real processes over one state directory", async () => {
    const [first, second] = await Promise.all([
      collect(spawnHolder({ SOURCE_ID: "shared", HOLD_MS: "300", TIMEOUT_MS: "20000" })),
      collect(spawnHolder({ SOURCE_ID: "shared", HOLD_MS: "300", TIMEOUT_MS: "20000" })),
    ]);

    const spanOf = (lines: Record<string, unknown>[]) => ({
      enter: Number(lines.find((line) => line.event === "acquired")?.at),
      exit: Number(lines.find((line) => line.event === "releasing")?.at),
    });
    const spans = [spanOf(first), spanOf(second)].sort((a, b) => a.enter - b.enter);

    expect(spans[0].enter).toBeGreaterThan(0);
    expect(spans[1].enter).toBeGreaterThanOrEqual(spans[0].exit);
  }, 60_000);

  it("does not reclaim a lock a live process is still holding", async () => {
    const holder = spawnHolder({
      SOURCE_ID: "held",
      MODE: "hang",
      TIMEOUT_MS: "20000",
    });
    await waitForAcquire(holder);

    try {
      // A staleness window of 1 ms would expire this lock instantly if age
      // were the only test; the holder is alive, so it must not be broken.
      const journal = makeJournal({
        lock: { timeoutMs: 150, pollMs: 5, staleAfterMs: 1 },
      });
      await expect(journal.withLock("held", async () => "ok")).rejects.toThrow(
        LockTimeoutError,
      );
    } finally {
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.on("close", resolve));
    }
  }, 60_000);

  it("reclaims the lock of a process that was killed while holding it", async () => {
    const holder = spawnHolder({
      SOURCE_ID: "killed",
      MODE: "hang",
      TIMEOUT_MS: "20000",
    });
    await waitForAcquire(holder);
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.on("close", resolve));

    // The lock directory outlived its owner; the pid is what proves it is dead.
    expect(fs.existsSync(path.join(stateDir, "locks", "killed.lock"))).toBe(true);

    const journal = makeJournal({ lock: { timeoutMs: 5000, pollMs: 10 } });
    await expect(journal.withLock("killed", async () => "ok")).resolves.toBe("ok");
  }, 60_000);
});

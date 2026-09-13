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
  STATE_LAYOUT_VERSION,
  StateLayoutError,
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

  it("keeps its lock file out of the vault", async () => {
    const journal = makeJournal();
    await journal.withLock("abc123", async () => "ok");

    expect(fs.existsSync(path.join(journal.stateDir, "locks", "abc123.db"))).toBe(true);
    expect(fs.readdirSync(vaultDir)).toEqual([]);
  });

  it("records the holder for diagnostics without deciding anything with it", async () => {
    const journal = makeJournal();

    await journal.withLock("abc123", async () => "ok");

    const owner = journal.lockDiagnostics("abc123");
    expect(typeof owner?.ownerToken).toBe("string");
    expect(typeof owner?.acquiredAt).toBe("string");
  });

  it("times out rather than waiting forever on a lock it cannot get", async () => {
    const holder = makeJournal();
    const contender = makeJournal({ lock: { timeoutMs: 80, pollMs: 5 } });

    await holder.withLock("abc123", async () => {
      await expect(contender.withLock("abc123", async () => "ok")).rejects.toThrow(
        LockTimeoutError,
      );
    });
  });

  it("releases the lock when the logger itself throws", async () => {
    const journal = makeJournal({
      lock: { timeoutMs: 200, pollMs: 5 },
      logger: () => {
        throw new Error("the logger failed");
      },
    });

    await expect(journal.withLock("abc123", async () => "ok")).rejects.toThrow(
      "the logger failed",
    );

    // Anything that can throw between taking the lock and the cleanup block
    // leaks the connection, and the next acquirer waits out its whole timeout.
    const next = makeJournal({ lock: { timeoutMs: 200, pollMs: 5 } });
    await expect(next.withLock("abc123", async () => "ok")).resolves.toBe("ok");
  });

  it("leaves no timer behind that would keep a process alive", async () => {
    const journal = makeJournal({ lock: { timeoutMs: 200, pollMs: 5 } });
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;

    await journal.withLock("abc123", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const after = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    expect(after).toBeLessThanOrEqual(before);
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

  it("writes to the sink SB_DOCS_LOG_FILE names", () => {
    // Redirecting the sink is what makes a run's own events assertable from
    // outside it, without writing into the operator's log.
    const file = path.join(stateDir, "redirected.jsonl");
    const enabled = process.env.SB_DOCS_LOG;
    const sink = process.env.SB_DOCS_LOG_FILE;
    process.env.SB_DOCS_LOG = "1";
    process.env.SB_DOCS_LOG_FILE = file;
    try {
      createJsonlLogger()({ level: "info", event: "redirected", loc: "l", ctx: {} });

      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).event).toBe("redirected");
    } finally {
      if (enabled === undefined) delete process.env.SB_DOCS_LOG;
      else process.env.SB_DOCS_LOG = enabled;
      if (sink === undefined) delete process.env.SB_DOCS_LOG_FILE;
      else process.env.SB_DOCS_LOG_FILE = sink;
    }
  });

  it("prefers an explicit sink over the environment override", () => {
    const explicit = path.join(stateDir, "explicit.jsonl");
    const overridden = path.join(stateDir, "overridden.jsonl");
    const enabled = process.env.SB_DOCS_LOG;
    const sink = process.env.SB_DOCS_LOG_FILE;
    process.env.SB_DOCS_LOG = "1";
    process.env.SB_DOCS_LOG_FILE = overridden;
    try {
      createJsonlLogger({ filePath: explicit })({
        level: "info",
        event: "e",
        loc: "l",
        ctx: {},
      });

      expect(fs.existsSync(explicit)).toBe(true);
      expect(fs.existsSync(overridden)).toBe(false);
    } finally {
      if (enabled === undefined) delete process.env.SB_DOCS_LOG;
      else process.env.SB_DOCS_LOG = enabled;
      if (sink === undefined) delete process.env.SB_DOCS_LOG_FILE;
      else process.env.SB_DOCS_LOG_FILE = sink;
    }
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

    const proposals = fs.readdirSync(
      path.join(journal.stateDir, "journal", "proposals", "abc123"),
    );
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
    const proposals = path.join(journal.stateDir, "journal", "proposals", "abc123");
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
      path.join(journal.stateDir, "journal", "proposals", "abc123", `${sha256(NOTE)}.md`),
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
      path.join(
        journal.stateDir,
        "journal",
        "proposals",
        "abc123",
        `${sha256(orphan)}.md`,
      ),
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
        path.join(
          journal.stateDir,
          "journal",
          "proposals",
          "abc123",
          `${sha256(NOTE)}.md`,
        ),
      ),
    ).toBe(false);
  });

  it("keeps each source's proposal in its own namespace", () => {
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

    // Identical bytes, two sources: the files must not be the same file, or one
    // source's cleanup would collect the other's proposal.
    const proposals = path.join(journal.stateDir, "journal", "proposals");
    expect(fs.existsSync(path.join(proposals, "a", `${sha256(NOTE)}.md`))).toBe(true);
    expect(fs.existsSync(path.join(proposals, "b", `${sha256(NOTE)}.md`))).toBe(true);
  });

  it("does not collect a proposal another source is preparing concurrently", () => {
    const journal = makeJournal();

    // B checks for its bytes, and is interrupted before writing its entry.
    journal.prepare({
      sourceId: "a",
      path: "a.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });
    const paused = makeJournal();

    // A completes its only referencing entry in the window.
    journal.complete("a");

    // B's prepare now lands. Its bytes must still be there afterwards: a
    // per-source namespace is what puts this lifecycle under B's own lock.
    paused.prepare({
      sourceId: "b",
      path: "b.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });

    expect(paused.proposedBytes("b")).toBe(NOTE);
    expect(makeJournal().proposedBytes("b")).toBe(NOTE);
  });

  it("records and reads back a candidate's whole-note digest", () => {
    const journal = makeJournal();
    journal.writeCandidate({
      name: "cand.md",
      path: "x/cand.md",
      digest: sha256(NOTE),
      verified: false,
    });

    // An intent, until the note is observed carrying exactly those bytes.
    expect(journal.readCandidate("cand.md")).toMatchObject({
      path: "x/cand.md",
      digest: sha256(NOTE),
      verified: false,
    });

    journal.writeCandidate({
      name: "cand.md",
      path: "x/cand.md",
      digest: sha256(NOTE),
      verified: true,
    });
    expect(journal.readCandidate("cand.md")?.verified).toBe(true);
    expect(journal.readCandidate("missing.md")).toBeNull();
  });
});

describe("PublicationJournal state layout", () => {
  it("stamps a fresh state directory with the current layout version", () => {
    const journal = makeJournal();

    const marker = JSON.parse(
      fs.readFileSync(path.join(journal.stateDir, "layout.json"), "utf8"),
    );
    expect(marker.version).toBe(STATE_LAYOUT_VERSION);
  });

  it("initializes a state directory that has a marker but no entries", () => {
    fs.rmSync(path.join(stateDir, "layout.json"), { force: true });

    expect(() => makeJournal()).not.toThrow();
    expect(fs.existsSync(path.join(stateDir, "layout.json"))).toBe(true);
  });

  it("refuses a state directory whose layout version does not match", () => {
    makeJournal().prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });
    fs.writeFileSync(
      path.join(stateDir, "layout.json"),
      JSON.stringify({ version: STATE_LAYOUT_VERSION + 1 }),
    );

    expect(() => makeJournal()).toThrow(StateLayoutError);
    // The diagnostic names the path and both versions, because the operator
    // has to be able to act on it.
    expect(() => makeJournal()).toThrow(new RegExp(String(STATE_LAYOUT_VERSION + 1)));
    expect(() => makeJournal()).toThrow(new RegExp(String(STATE_LAYOUT_VERSION)));
  });

  it("refuses an unmarked state directory that already holds entries", () => {
    makeJournal().prepare({
      sourceId: "abc123",
      path: "note.md",
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256(NOTE),
      bytes: NOTE,
    });
    fs.rmSync(path.join(stateDir, "layout.json"), { force: true });

    // Unmarked state with content predates the marker, so its layout is
    // unknown: refusing loudly beats reading it as if it were current.
    expect(() => makeJournal()).toThrow(StateLayoutError);
  });

  it("refuses an unmarked state directory that holds ownership records", () => {
    makeJournal().writeOwnership({
      sourceId: "abc123",
      path: "note.md",
      digest: sha256(NOTE),
    });
    fs.rmSync(path.join(stateDir, "layout.json"), { force: true });

    expect(() => makeJournal()).toThrow(StateLayoutError);
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

  /** Resolves with the child's JSON lines and how it exited. */
  function collect(child: LockHolderProcess): Promise<{
    lines: Record<string, unknown>[];
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return new Promise((resolve) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("close", (code, signal) =>
        resolve({
          lines: out
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line)),
          code,
          signal,
        }),
      );
    });
  }

  /** Waits for a barrier file the child writes, rather than for a duration. */
  async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
      if (Date.now() >= deadline) throw new Error(`barrier never appeared: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const fileIn = (name: string) => path.join(stateDir, name);

  it("makes a second process wait, and never lets the two overlap", async () => {
    const witness = fileIn("witness");
    const first = spawnHolder({
      SOURCE_ID: "shared",
      WITNESS_FILE: witness,
      ACQUIRED_FILE: fileIn("acquired-1"),
      RELEASE_FILE: fileIn("release-1"),
      ENTRIES_FILE: fileIn("entries"),
      TIMEOUT_MS: "20000",
    });
    const firstDone = collect(first);
    await waitForFile(fileIn("acquired-1"));

    const second = spawnHolder({
      SOURCE_ID: "shared",
      WITNESS_FILE: witness,
      ATTEMPTED_FILE: fileIn("attempted-2"),
      ACQUIRED_FILE: fileIn("acquired-2"),
      RELEASE_FILE: fileIn("release-2"),
      ENTRIES_FILE: fileIn("entries"),
      TIMEOUT_MS: "20000",
    });
    const secondDone = collect(second);

    // Wait until the contender has actually been refused the lock, rather than
    // sleeping and hoping it got that far. Only then is "it is still outside"
    // a statement about exclusion instead of about scheduling.
    await waitForFile(fileIn("attempted-2"));
    expect(fs.existsSync(fileIn("acquired-2"))).toBe(false);
    expect(fs.readFileSync(witness, "utf8")).toBe(String(first.pid));

    fs.writeFileSync(fileIn("release-1"), "go");
    await waitForFile(fileIn("acquired-2"));
    fs.writeFileSync(fileIn("release-2"), "go");

    const [one, two] = await Promise.all([firstDone, secondDone]);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(one.signal).toBeNull();
    expect(two.signal).toBeNull();
    expect([...one.lines, ...two.lines].some((line) => line.event === "overlap")).toBe(
      false,
    );
    expect(fs.readFileSync(fileIn("entries"), "utf8").trim().split("\n")).toHaveLength(2);
  }, 90_000);

  it("hands the lock straight to the next process when a holder is killed", async () => {
    const holder = spawnHolder({
      SOURCE_ID: "killed",
      MODE: "hang",
      ACQUIRED_FILE: fileIn("acquired-hang"),
      TIMEOUT_MS: "20000",
    });
    const holderDone = collect(holder);
    await waitForFile(fileIn("acquired-hang"));

    holder.kill("SIGKILL");
    const dead = await holderDone;
    expect(dead.signal).toBe("SIGKILL");

    // No cleanup step, no staleness window, no reclamation: the kernel
    // released the file lock when the process died.
    const started = Date.now();
    const journal = makeJournal({ lock: { timeoutMs: 5000, pollMs: 10 } });
    await expect(journal.withLock("killed", async () => "ok")).resolves.toBe("ok");
    expect(Date.now() - started).toBeLessThan(3000);
  }, 90_000);

  it("serializes three processes over one source", async () => {
    const witness = fileIn("witness-3");
    // The first holds behind a release barrier; the other two must both be
    // refused before it lets go, so all three genuinely contend.
    const holder = spawnHolder({
      SOURCE_ID: "three",
      WITNESS_FILE: witness,
      ACQUIRED_FILE: fileIn("acquired-3a"),
      RELEASE_FILE: fileIn("release-3a"),
      ENTRIES_FILE: fileIn("entries-3"),
      TIMEOUT_MS: "20000",
    });
    await waitForFile(fileIn("acquired-3a"));

    const contenders = ["b", "c"].map((name) =>
      spawnHolder({
        SOURCE_ID: "three",
        WITNESS_FILE: witness,
        ATTEMPTED_FILE: fileIn(`attempted-3${name}`),
        ENTRIES_FILE: fileIn("entries-3"),
        HOLD_MS: "20",
        TIMEOUT_MS: "20000",
      }),
    );
    await waitForFile(fileIn("attempted-3b"));
    await waitForFile(fileIn("attempted-3c"));
    expect(fs.readFileSync(witness, "utf8")).toBe(String(holder.pid));

    fs.writeFileSync(fileIn("release-3a"), "go");
    const results = await Promise.all([holder, ...contenders].map(collect));

    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.lines.some((line) => line.event === "acquired")).toBe(true);
      expect(result.lines.some((line) => line.event === "overlap")).toBe(false);
    }
    const entries = fs.readFileSync(fileIn("entries-3"), "utf8").trim().split("\n");
    expect(entries).toHaveLength(3);
    expect(new Set(entries).size).toBe(3);
  }, 90_000);

  it("does not make one source wait for another", async () => {
    const first = spawnHolder({
      SOURCE_ID: "alpha",
      WITNESS_FILE: fileIn("witness-alpha"),
      ACQUIRED_FILE: fileIn("acquired-alpha"),
      RELEASE_FILE: fileIn("release-alpha"),
      TIMEOUT_MS: "20000",
    });
    const firstDone = collect(first);
    await waitForFile(fileIn("acquired-alpha"));

    const second = spawnHolder({
      SOURCE_ID: "beta",
      WITNESS_FILE: fileIn("witness-beta"),
      ACQUIRED_FILE: fileIn("acquired-beta"),
      RELEASE_FILE: fileIn("release-beta"),
      TIMEOUT_MS: "20000",
    });
    const secondDone = collect(second);

    // Beta gets in while alpha is still holding: different sources are
    // genuinely independent.
    await waitForFile(fileIn("acquired-beta"));
    expect(fs.existsSync(fileIn("acquired-alpha"))).toBe(true);

    fs.writeFileSync(fileIn("release-alpha"), "go");
    fs.writeFileSync(fileIn("release-beta"), "go");
    const [one, two] = await Promise.all([firstDone, secondDone]);
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
  }, 90_000);

  it("reports lock diagnostics promptly instead of waiting on a live holder", async () => {
    const holder = spawnHolder({
      SOURCE_ID: "busy",
      ACQUIRED_FILE: fileIn("acquired-busy"),
      RELEASE_FILE: fileIn("release-busy"),
      TIMEOUT_MS: "20000",
    });
    const holderDone = collect(holder);
    await waitForFile(fileIn("acquired-busy"));

    const journal = makeJournal();
    const started = Date.now();
    const diagnostics = journal.lockDiagnostics("busy");
    const elapsed = Date.now() - started;

    // A diagnostic command must never block behind a capture. Reading into an
    // exclusive transaction is impossible, so the honest answer is "held".
    expect(elapsed).toBeLessThan(1000);
    expect(diagnostics).toBeNull();
    expect(journal.lockRecords()).toContainEqual(
      expect.objectContaining({ source: "busy", busy: true }),
    );

    // The holder still has it; nothing about reading disturbed the lock.
    expect(fs.existsSync(fileIn("release-busy"))).toBe(false);
    fs.writeFileSync(fileIn("release-busy"), "go");
    expect((await holderDone).code).toBe(0);

    // Once released, the recorded holder is readable.
    expect(typeof journal.lockDiagnostics("busy")?.ownerToken).toBe("string");
  }, 90_000);

  it("releases a lock whose holder failed inside its critical section", async () => {
    const failing = await collect(
      spawnHolder({
        SOURCE_ID: "throwing",
        MODE: "throw",
        ACQUIRED_FILE: fileIn("acquired-throw"),
        TIMEOUT_MS: "20000",
      }),
    );
    expect(failing.code).toBe(1);
    expect(failing.lines.some((line) => line.event === "failed")).toBe(true);

    const journal = makeJournal({ lock: { timeoutMs: 5000, pollMs: 10 } });
    await expect(journal.withLock("throwing", async () => "ok")).resolves.toBe("ok");
  }, 90_000);
});

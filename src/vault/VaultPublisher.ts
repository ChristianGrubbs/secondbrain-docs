/**
 * Publishes converted source documents into the Obsidian vault.
 *
 * The vault is authoritative and a human edit always wins. Ownership is proved
 * from outside the vault — the exact whole-note digest this publisher last
 * committed, kept in the state directory — never from publisher frontmatter,
 * which anybody can type. A note that still matches that digest may be replaced
 * under compare-and-swap; anything else is preserved, and the incoming version
 * is written beside it as an immutable candidate.
 *
 * Every capture runs inside a per-source interprocess lock and records its
 * phases in the journal, so an interrupted run is classified and finished
 * rather than replayed blindly over whatever is there now.
 */

import { scanSources } from "./discovery";
import {
  collectionIndexPath,
  DOC_SETS_ROOT,
  INBOX_COLLECTION,
  INBOX_COLLECTION_PATH,
  normalizeCollection,
  notePath,
  SOURCES_HEADING,
  sanitizeLinkAlias,
  sanitizeSegment,
  sha256,
} from "./identity";
import { hasLinkTo } from "./markdownLinks.mjs";
import {
  CasConflictError,
  HeadingFormatError,
  HeadingNotFoundError,
  type ObsidianCli,
} from "./ObsidianCli";
import {
  createJsonlLogger,
  type JournalEntry,
  type LockOptions,
  PublicationJournal,
  type VaultLogger,
} from "./PublicationJournal";
import {
  parseNoteFrontmatter,
  type RenderedNote,
  renderCollectionIndex,
  renderSourceNote,
  semanticDigestOfNote,
} from "./render";
import type { ConflictReason, Publication, Publisher, SourceDocument } from "./types";

/** Full identity length, used when a short filename is already taken. */
const FULL_HASH_LENGTH = 64;

/** Identity characters used in a candidate's content-addressed filename. */
const CANDIDATE_HASH_LENGTH = 12;

/** Collection that preserved incoming versions are written to. */
export const SOURCE_UPDATES_PATH = "00 Inbox/Source Capture Updates";

/** Index note listing every preserved incoming version. */
export const SOURCE_UPDATES_INDEX = `${SOURCE_UPDATES_PATH}/index.md`;

/** What a capture should do with the note it found. */
export type UpdateAction = "create" | "unchanged" | "replace" | "conflict";

/** How an interrupted publication can be finished. */
export type RecoveryClassification = "resumable" | "retryable" | "conflict";

/** One interrupted publication and what can be done about it. */
export interface RecoveryOutcome {
  sourceId: string;
  path: string;
  phase: JournalEntry["phase"];
  classification: RecoveryClassification;
  /** True when recovery finished the publication during this run. */
  completed: boolean;
}

/**
 * Decides what a capture may do to the note it found.
 *
 * @param input.currentDigest Whole-note digest in the vault now, or null when
 *   the note is absent.
 * @param input.ownedDigest Whole-note digest this publisher last committed, or
 *   null when it owns nothing at that path.
 * @param input.semanticChanged Whether the source content itself changed.
 * @returns The action the write protocol must take.
 */
export function updateDecision(input: {
  currentDigest: string | null;
  ownedDigest: string | null;
  semanticChanged: boolean;
}): UpdateAction {
  if (input.currentDigest === null) return "create";
  if (input.currentDigest !== input.ownedDigest) return "conflict";
  return input.semanticChanged ? "replace" : "unchanged";
}

/**
 * Reads a note's `source_id`, coercing a hand-edited numeric scalar.
 *
 * @returns The identity as a string, or null when the note carries none.
 */
function noteSourceId(markdown: string): string | null {
  const raw = parseNoteFrontmatter(markdown)?.data.source_id;
  return raw === undefined || raw === null ? null : String(raw);
}

/** A note's bytes plus the anchor a compare-and-swap write must match. */
type Snapshot = { markdown: string; anchor: string };

export class VaultPublisher implements Publisher {
  /** Serializes writes so concurrent crawl callbacks cannot duplicate a link. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Normalized collection identity to its one canonical vault folder. */
  private readonly folders = new Map<string, string>();

  /** Durable journal, ownership records and per-source locks. */
  readonly journal: PublicationJournal;

  private readonly logger: VaultLogger;

  constructor(
    private readonly cli: ObsidianCli,
    private readonly options: {
      publisherVersion?: string;
      /** Runtime state directory; must be outside the vault. */
      stateDir?: string;
      /** Vault the CLI operates on, used to validate `stateDir`. */
      vaultPath?: string;
      journal?: PublicationJournal;
      logger?: VaultLogger;
      lock?: LockOptions;
    } = {},
  ) {
    this.logger = options.logger ?? createJsonlLogger();
    this.journal =
      options.journal ??
      new PublicationJournal({
        stateDir: options.stateDir,
        vaultPath: options.vaultPath,
        logger: this.logger,
        lock: options.lock,
      });
  }

  /**
   * Publishes one source document as a vault note and links it from its
   * collection index.
   *
   * @param input The converted source document.
   * @returns The publication outcome, including the note's current bytes.
   */
  publish(input: SourceDocument): Promise<Publication> {
    const result = this.queue.then(
      () => this.publishSerially(input),
      () => this.publishSerially(input),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async publishSerially(input: SourceDocument): Promise<Publication> {
    if (input.markdown.trim().length === 0) {
      throw new Error(`refusing to publish empty markdown for ${input.sourceUrl}`);
    }

    const folder = await this.resolveCollectionFolder(input.collection);
    const rendered = renderSourceNote(input, this.options);

    // Everything from here to the ownership write is one critical section, so
    // another process cannot allocate a second path for this same source.
    return this.journal.withLock(rendered.sourceId, () =>
      this.capture(input, folder, rendered),
    );
  }

  /** Resolves the target path, then applies the update decision to it. */
  private async capture(
    input: SourceDocument,
    folder: string,
    rendered: RenderedNote,
  ): Promise<Publication> {
    const id = rendered.sourceId;
    const ownership = this.journal.readOwnership(id);

    let path: string | null = null;
    let snapshot: Snapshot | null = null;
    let computed = false;

    // The scan is refreshed inside the lock, every time, and an ownership
    // record never substitutes for it. A record only proves which bytes we
    // last wrote; it cannot prove that no second note has appeared claiming the
    // same identity, and allocating a path on that assumption is how duplicates
    // are born. The refresh re-lists the folder and re-reads our own note, and
    // reads nothing else it has already seen.
    const discovered = (await this.refreshIdentities(folder)).get(id) ?? [];
    if (discovered.length > 1) {
      return this.conflictAt(input, rendered, discovered[0], "identity-conflict");
    }
    if (discovered.length === 1) {
      path = discovered[0];
      snapshot = await this.cli.readNoteWithAnchor(path);
    }

    // A note we own whose frontmatter a human stripped is invisible to the
    // scan, but the ownership record still names where it lives.
    if (path === null && ownership !== null) {
      const recorded = await this.cli.readNoteWithAnchor(ownership.path);
      if (recorded !== null) {
        path = ownership.path;
        snapshot = recorded;
      }
    }

    if (path === null) {
      computed = true;
      path = notePath(input, { folder });
      snapshot = await this.cli.readNoteWithAnchor(path);
      const existingId = snapshot === null ? null : noteSourceId(snapshot.markdown);
      if (existingId !== null && existingId !== id) {
        // A different source already holds the short filename. Widen to the
        // full identity rather than touching a note that is not ours.
        path = notePath(input, { folder, hashLength: FULL_HASH_LENGTH });
        snapshot = await this.cli.readNoteWithAnchor(path);
      }
    }

    return this.settle({ input, folder, rendered, path, snapshot, computed, attempt: 0 });
  }

  /** Applies {@link updateDecision} at an already-resolved path. */
  private async settle(context: {
    input: SourceDocument;
    folder: string;
    rendered: RenderedNote;
    path: string;
    snapshot: Snapshot | null;
    computed: boolean;
    attempt: number;
  }): Promise<Publication> {
    const { input, folder, rendered, path, snapshot } = context;
    const id = rendered.sourceId;

    const currentDigest = snapshot === null ? null : sha256(snapshot.markdown);
    const ownedDigest = this.ownedDigest(id, path, currentDigest);
    const semanticChanged =
      snapshot === null ||
      semanticDigestOfNote(snapshot.markdown) !== rendered.semanticDigest;

    const decision = updateDecision({ currentDigest, ownedDigest, semanticChanged });
    this.logger({
      level: "info",
      event: "capture.decision",
      loc: "VaultPublisher.settle",
      ctx: { sourceId: id, path, decision, owned: ownedDigest !== null, semanticChanged },
    });

    if (decision === "create") return this.createNote(context);
    if (decision === "replace" && snapshot !== null) {
      return this.replaceNote(context, snapshot, currentDigest ?? "");
    }
    if (decision === "unchanged" && snapshot !== null && currentDigest !== null) {
      this.journal.writeOwnership({ sourceId: id, path, digest: currentDigest });
      const moc = await this.linkFromCollectionIndex(input.title, folder, path);
      return {
        status: "unchanged",
        path,
        markdown: snapshot.markdown,
        digest: currentDigest,
        moc,
      };
    }

    return this.conflictAt(
      input,
      rendered,
      path,
      ownedDigest === null ? "user-owned" : "manual-edit",
      snapshot?.markdown ?? null,
    );
  }

  /**
   * Reports the digest this publisher is accountable for at a path.
   *
   * The ownership file is the normal proof. When it is missing, the durable
   * journal can still prove that exactly these bytes were written by a capture
   * that was interrupted before it could record ownership — but nothing else
   * can, and in particular publisher frontmatter never can.
   */
  private ownedDigest(
    sourceId: string,
    path: string,
    currentDigest: string | null,
  ): string | null {
    const ownership = this.journal.readOwnership(sourceId);
    if (ownership !== null) {
      if (ownership.path === path || ownership.digest === currentDigest) {
        return ownership.digest;
      }
    }

    const entry = this.journal.entry(sourceId);
    const written = entry?.phase === "note-written" || entry?.phase === "moc-linked";
    if (
      entry !== null &&
      written &&
      entry.path === path &&
      currentDigest !== null &&
      entry.proposedWholeNoteDigest === currentDigest
    ) {
      this.logger({
        level: "warn",
        event: "ownership.restored_from_journal",
        loc: "VaultPublisher.ownedDigest",
        ctx: { sourceId, path, phase: entry.phase },
      });
      return currentDigest;
    }

    return null;
  }

  /** Create path of the write protocol. */
  private async createNote(context: {
    input: SourceDocument;
    folder: string;
    rendered: RenderedNote;
    path: string;
    computed: boolean;
    attempt: number;
  }): Promise<Publication> {
    const { input, folder, rendered, path } = context;
    const id = rendered.sourceId;

    this.journal.prepare({
      sourceId: id,
      path,
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: rendered.digest,
      bytes: rendered.markdown,
    });

    try {
      await this.cli.createNote(path, rendered.markdown);
    } catch (error) {
      if (!(error instanceof CasConflictError)) throw error;
      return this.afterLostRace(context, error);
    }

    this.journal.advance(id, "note-written");

    const verified = await this.verifyReadback(path, rendered.digest);
    if (verified === null) {
      return this.conflictAt(input, rendered, path, "manual-edit");
    }

    const moc = await this.finishPublication(
      id,
      input.title,
      folder,
      path,
      rendered.digest,
    );

    return {
      status: "published",
      path,
      markdown: rendered.markdown,
      digest: rendered.digest,
      moc,
    };
  }

  /**
   * Records ownership, links the note, and closes the journal entry.
   *
   * Ownership is recorded first, because the bytes are ours the moment the
   * readback confirms them. The entry is only closed once the link exists: an
   * unlinked note is unfinished work, and leaving the journal at `note-written`
   * is what keeps it visible to `doctor` and recoverable later.
   *
   * @returns Whether the note is linked from its collection index.
   */
  private async finishPublication(
    sourceId: string,
    title: string,
    folder: string,
    path: string,
    digest: string,
  ): Promise<"linked" | "pending"> {
    this.journal.writeOwnership({ sourceId, path, digest });

    const moc = await this.linkFromCollectionIndex(title, folder, path);
    if (moc === "pending") {
      this.logger({
        level: "warn",
        event: "capture.link_pending",
        loc: "VaultPublisher.finishPublication",
        ctx: { sourceId, path },
      });
      return moc;
    }

    this.journal.advance(sourceId, "moc-linked");
    this.journal.complete(sourceId);
    return moc;
  }

  /**
   * Re-decides once after another writer created the note between our read and
   * our create, so a lost race never becomes a second note.
   */
  private async afterLostRace(
    context: {
      input: SourceDocument;
      folder: string;
      rendered: RenderedNote;
      path: string;
      computed: boolean;
      attempt: number;
    },
    error: CasConflictError,
  ): Promise<Publication> {
    const { input, rendered, computed, attempt } = context;
    if (attempt > 0) {
      return this.conflictAt(input, rendered, context.path, "user-owned");
    }

    const fresh = await this.cli.readNoteWithAnchor(context.path);
    if (fresh === null) throw error;

    const freshId = noteSourceId(fresh.markdown);
    if (computed && freshId !== null && freshId !== rendered.sourceId) {
      const widened = notePath(input, {
        folder: context.folder,
        hashLength: FULL_HASH_LENGTH,
      });
      return this.settle({
        ...context,
        path: widened,
        snapshot: await this.cli.readNoteWithAnchor(widened),
        attempt: attempt + 1,
      });
    }

    this.logger({
      level: "warn",
      event: "capture.lost_create_race",
      loc: "VaultPublisher.afterLostRace",
      ctx: { sourceId: rendered.sourceId, path: context.path },
    });
    return this.settle({ ...context, snapshot: fresh, attempt: attempt + 1 });
  }

  /** Replace path of the write protocol, under compare-and-swap. */
  private async replaceNote(
    context: {
      input: SourceDocument;
      folder: string;
      rendered: RenderedNote;
      path: string;
      computed: boolean;
      attempt: number;
    },
    snapshot: Snapshot,
    priorDigest: string,
  ): Promise<Publication> {
    const { input, folder, rendered, path } = context;
    const id = rendered.sourceId;

    this.journal.prepare({
      sourceId: id,
      path,
      priorWholeNoteDigest: priorDigest,
      proposedWholeNoteDigest: rendered.digest,
      bytes: rendered.markdown,
    });

    let anchor = snapshot.anchor;
    let written = false;
    for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
      try {
        await this.cli.replaceNote(path, rendered.markdown, anchor);
        written = true;
      } catch (error) {
        if (!(error instanceof CasConflictError)) throw error;

        // The anchor is burnt; only a fresh snapshot may be written against.
        const fresh = await this.cli.readNoteWithAnchor(path);
        if (fresh === null) {
          return this.conflictAt(input, rendered, path, "manual-edit");
        }
        const freshDigest = sha256(fresh.markdown);
        if (freshDigest === rendered.digest) {
          written = true;
          break;
        }
        if (freshDigest !== priorDigest || attempt === 1) {
          this.logger({
            level: "warn",
            event: "capture.cas_conflict",
            loc: "VaultPublisher.replaceNote",
            ctx: { sourceId: id, path, attempt },
          });
          return this.conflictAt(input, rendered, path, "manual-edit", fresh.markdown);
        }
        anchor = fresh.anchor;
      }
    }

    this.journal.advance(id, "note-written");

    const verified = await this.verifyReadback(path, rendered.digest);
    if (verified === null) {
      return this.conflictAt(input, rendered, path, "manual-edit");
    }

    const moc = await this.finishPublication(
      id,
      input.title,
      folder,
      path,
      rendered.digest,
    );

    return {
      status: "replaced",
      path,
      markdown: rendered.markdown,
      digest: rendered.digest,
      moc,
    };
  }

  /**
   * Re-reads a note and confirms it holds exactly the proposed bytes.
   *
   * @returns The bytes, or null when the vault holds something else.
   */
  private async verifyReadback(path: string, expected: string): Promise<string | null> {
    const readBack = await this.cli.readNote(path);
    if (readBack !== null && sha256(readBack) === expected) return readBack;

    this.logger({
      level: "error",
      event: "capture.readback_mismatch",
      loc: "VaultPublisher.verifyReadback",
      ctx: { path, expected },
    });
    return null;
  }

  /**
   * Preserves the note that is there and records the incoming version beside
   * it as an immutable, content-addressed candidate.
   */
  private async conflictAt(
    input: SourceDocument,
    rendered: RenderedNote,
    path: string,
    reason: ConflictReason,
    knownMarkdown: string | null = null,
  ): Promise<Publication> {
    const existing = knownMarkdown ?? (await this.cli.readNote(path));
    const candidate = await this.writeCandidate(input, rendered);

    this.logger({
      level: "warn",
      event: "capture.conflict",
      loc: "VaultPublisher.conflictAt",
      ctx: {
        sourceId: rendered.sourceId,
        path,
        reason: candidate.modified ? "candidate-modified" : reason,
        candidatePath: candidate.path,
      },
    });

    return {
      status: "conflict",
      path,
      markdown: existing ?? "",
      digest: existing === null ? "" : sha256(existing),
      moc: candidate.moc,
      candidatePath: candidate.path,
      conflictReason: candidate.modified ? "candidate-modified" : reason,
    };
  }

  /**
   * Writes — or reuses — the preserved incoming version of a source.
   *
   * The filename is content addressed by source identity plus semantic content
   * digest, so recapturing the same unchanged conflict reuses one candidate
   * rather than accumulating one per run. A candidate whose content no longer
   * matches its own address was edited by a human and is never overwritten.
   */
  private async writeCandidate(
    input: SourceDocument,
    rendered: RenderedNote,
  ): Promise<{ path: string; moc: "linked" | "pending"; modified: boolean }> {
    const name = `${rendered.sourceId.slice(0, CANDIDATE_HASH_LENGTH)}-${rendered.semanticDigest.slice(0, CANDIDATE_HASH_LENGTH)}.md`;
    const path = `${SOURCE_UPDATES_PATH}/${name}`;

    /**
     * Reports whether an existing candidate can still be treated as ours.
     *
     * Only a recorded whole-note digest can answer this. Semantic addressing
     * deliberately ignores capture time and publisher release, so a
     * frontmatter-only edit is semantically identical and byte-wise not —
     * which means a semantic comparison would report an edited candidate as
     * untouched. With no record at all there is no baseline to trust, and the
     * conservative answer is the only safe one.
     */
    const wasEdited = (markdown: string): boolean => {
      const record = this.journal.readCandidate(name);
      if (record === null) {
        this.logger({
          level: "warn",
          event: "candidate.unverifiable",
          loc: "VaultPublisher.writeCandidate",
          ctx: { path },
        });
        return true;
      }

      const matchesBaseline = sha256(markdown) === record.digest;
      // An unconfirmed record is an intent from an interrupted run: it can
      // still recognise our own untouched bytes, and confirming them now is
      // what reconciles that interruption.
      if (matchesBaseline && !record.verified) {
        this.journal.writeCandidate({
          name,
          path,
          digest: record.digest,
          verified: true,
        });
      }
      return !matchesBaseline;
    };

    let modified = false;
    const existing = await this.cli.readNote(path);
    if (existing !== null) {
      modified = wasEdited(existing);
    } else {
      // The baseline is recorded BEFORE the note exists. A death in between
      // then leaves an intent rather than a candidate nobody can vouch for.
      this.journal.writeCandidate({
        name,
        path,
        digest: rendered.digest,
        verified: false,
      });
      try {
        await this.cli.createNote(path, rendered.markdown);
        this.journal.writeCandidate({
          name,
          path,
          digest: rendered.digest,
          verified: true,
        });
      } catch (error) {
        if (!(error instanceof CasConflictError)) throw error;
        const raced = await this.cli.readNote(path);
        if (raced === null) throw error;
        modified = wasEdited(raced);
      }
    }

    const moc = await this.linkFromIndex(
      SOURCE_UPDATES_INDEX,
      sanitizeSegment(SOURCE_UPDATES_PATH.split("/").pop() ?? "Source Capture Updates"),
      path,
      input.title,
    );
    return { path, moc, modified };
  }

  /**
   * Re-scans a collection folder for source identities.
   *
   * This runs on every capture, inside the source's lock, and it reads rather
   * than remembering. Identity lives in a note's frontmatter, and the only
   * evidence the vault CLI offers about a pathname is that it exists — so a
   * neighbour edited to claim this identity, or a note that has just been given
   * one, is invisible to anything cheaper. A path is allocated on the strength
   * of this answer, which makes a stale answer worse than a slow one.
   */
  private async refreshIdentities(folder: string): Promise<Map<string, string[]>> {
    return (
      await scanSources({
        cli: this.cli,
        collectionPath: folder,
        logger: this.logger,
      })
    ).map;
  }

  /**
   * Finishes every interrupted publication the journal still holds.
   *
   * @returns One outcome per pending entry, in journal order.
   */
  async recoverPending(): Promise<RecoveryOutcome[]> {
    // Only the identities are carried out of the unlocked scan. Everything the
    // recovery decides on is reread inside that identity's lock, because an
    // entry can be completed, pruned or replaced by another process while this
    // one waits for the lock — and acting on the snapshot would then either
    // advance an entry that no longer exists or discard a newer publication.
    const identities = [
      ...new Set(this.journal.pending().map((entry) => entry.sourceId)),
    ];

    const outcomes: RecoveryOutcome[] = [];
    for (const sourceId of identities) {
      const outcome = await this.journal.withLock(sourceId, async () => {
        const current = this.journal.entry(sourceId);
        if (current === null) {
          this.logger({
            level: "info",
            event: "recovery.entry_gone",
            loc: "VaultPublisher.recoverPending",
            ctx: { sourceId },
          });
          return null;
        }
        return this.recoverEntry(current);
      });
      if (outcome !== null) outcomes.push(outcome);
    }
    return outcomes;
  }

  /**
   * Classifies every interrupted publication without touching the vault.
   *
   * @returns One read-only outcome per pending entry.
   */
  async classifyPending(): Promise<RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const entry of this.journal.pending()) {
      const current = await this.cli.readNote(entry.path);
      outcomes.push({
        sourceId: entry.sourceId,
        path: entry.path,
        phase: entry.phase,
        classification: this.classify(entry, current),
        completed: false,
      });
    }
    return outcomes;
  }

  /**
   * Compares the note's actual bytes with both journal digests.
   *
   * Anything that matches neither is left exactly as it is: rolling an entry
   * back over an intervening manual edit would destroy the edit.
   */
  private classify(entry: JournalEntry, current: string | null): RecoveryClassification {
    const digest = current === null ? null : sha256(current);
    if (digest !== null && digest === entry.proposedWholeNoteDigest) return "resumable";
    if (digest === entry.priorWholeNoteDigest) return "retryable";
    return "conflict";
  }

  /** Finishes or reports on one pending entry. */
  private async recoverEntry(entry: JournalEntry): Promise<RecoveryOutcome> {
    if (entry.phase === "complete") {
      this.journal.discard(entry.sourceId);
      return {
        sourceId: entry.sourceId,
        path: entry.path,
        phase: entry.phase,
        classification: "resumable",
        completed: true,
      };
    }

    const current = await this.cli.readNote(entry.path);
    const classification = this.classify(entry, current);
    this.logger({
      level: "info",
      event: "recovery.classified",
      loc: "VaultPublisher.recoverEntry",
      ctx: {
        sourceId: entry.sourceId,
        path: entry.path,
        phase: entry.phase,
        classification,
      },
    });

    if (classification !== "resumable" || current === null) {
      return {
        sourceId: entry.sourceId,
        path: entry.path,
        phase: entry.phase,
        classification,
        completed: false,
      };
    }

    // The proposed bytes are in place, so only the link and the ownership
    // record can still be missing. Both are idempotent.
    const parsed = parseNoteFrontmatter(current);
    const collection = String(parsed?.data.collection ?? INBOX_COLLECTION);
    const title = String(parsed?.data.title ?? entry.path.split("/").pop() ?? "untitled");
    const folder = await this.resolveCollectionFolder(collection);

    const moc = await this.finishPublication(
      entry.sourceId,
      title,
      folder,
      entry.path,
      entry.proposedWholeNoteDigest,
    );

    return {
      sourceId: entry.sourceId,
      path: entry.path,
      phase: entry.phase,
      classification,
      // A note that still cannot be linked is still unfinished, and its entry
      // is still pending, so recovery must not claim it is done.
      completed: moc === "linked",
    };
  }

  /**
   * Resolves a collection to exactly one vault folder.
   *
   * Identity is case-insensitive, so two spellings of one collection must not
   * resolve to two folders. An existing folder's established spelling wins;
   * two folders claiming one identity is an error rather than a coin toss.
   *
   * @throws Error when the mapping is ambiguous.
   */
  private async resolveCollectionFolder(collection: string): Promise<string> {
    const normalized = normalizeCollection(collection);
    if (normalized === INBOX_COLLECTION) return INBOX_COLLECTION_PATH;

    const cached = this.folders.get(normalized);
    if (cached !== undefined) return cached;

    const entries = (await this.cli.listDirectory(DOC_SETS_ROOT)) ?? [];
    const matches = entries.filter(
      (entry) => normalizeCollection(entry.split("/").pop() ?? "") === normalized,
    );

    if (matches.length > 1) {
      throw new Error(
        `ambiguous collection folder for "${collection}": ${matches.join(", ")}`,
      );
    }

    const folder = matches[0] ?? `${DOC_SETS_ROOT}/${sanitizeSegment(collection)}`;
    this.folders.set(normalized, folder);
    return folder;
  }

  /** Ensures a collection index carries exactly one link to the note. */
  private linkFromCollectionIndex(
    title: string,
    folder: string,
    path: string,
  ): Promise<"linked" | "pending"> {
    return this.linkFromIndex(
      `${folder}/index.md`,
      folder.split("/").pop() ?? folder,
      path,
      title,
    );
  }

  /**
   * Ensures an index carries exactly one link to a note.
   *
   * The index is re-read immediately before the insertion, so a link another
   * writer — or an interrupted run of this one — already added is detected
   * rather than duplicated.
   *
   * @returns `linked` once the link is present, `pending` when the index exists
   *   but cannot be safely amended.
   */
  private async linkFromIndex(
    indexPath: string,
    indexTitle: string,
    path: string,
    title: string,
  ): Promise<"linked" | "pending"> {
    const target = path.replace(/\.md$/, "");
    const link = `- [[${target}|${sanitizeLinkAlias(title)}]]`;

    let index = await this.cli.readNote(indexPath);

    if (index === null) {
      try {
        await this.cli.createNote(indexPath, renderCollectionIndex(indexTitle));
        index = null;
      } catch (error) {
        if (!(error instanceof CasConflictError)) throw error;
        // Another writer created the index between our read and our create.
        index = await this.cli.readNote(indexPath);
        if (index === null) throw error;
      }
    }

    if (index !== null) {
      if (!index.split("\n").includes(SOURCES_HEADING)) return "pending";
      if (hasLinkTo(index, target)) return "linked";
    }

    try {
      await this.cli.insertUnderHeading(indexPath, SOURCES_HEADING, link);
      return "linked";
    } catch (error) {
      if (error instanceof HeadingFormatError || error instanceof HeadingNotFoundError) {
        return "pending";
      }
      throw error;
    }
  }
}

/** Re-exported so callers can build an index path without the publisher. */
export { collectionIndexPath };

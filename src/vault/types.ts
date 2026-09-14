/**
 * Shared types for vault publication.
 *
 * The vault is the authoritative store for captured sources; the SQLite index
 * added by a later task is derived, disposable state.
 */

/** One converted source document, ready to be published as a vault note. */
export type SourceDocument = {
  /** Final canonical URL the content was fetched from. */
  sourceUrl: string;
  /** URL or path the operator originally asked for, kept as provenance. */
  requestedUrl: string;
  /** Collection identifier; `inbox` is reserved for generic captures. */
  collection: string;
  /** Version label, empty when the source is unversioned. */
  version: string;
  title: string;
  /** Full converted Markdown, published unchanged. */
  markdown: string;
  sourceContentType: string;
  /** ISO 8601 capture timestamp. */
  capturedAt: string;
};

/**
 * What a capture did to the vault.
 *
 * `replaced` is only ever reached for a note whose current bytes match the
 * ownership record this publisher wrote, so a human edit downgrades it to
 * `conflict` rather than being overwritten.
 */
export type PublicationStatus = "published" | "unchanged" | "replaced" | "conflict";

/** Why a capture refused to touch the note it found. */
export type ConflictReason =
  /** The note exists but was never written by this publisher. */
  | "user-owned"
  /** The note's bytes changed since this publisher last wrote them. */
  | "manual-edit"
  /** The preserved incoming candidate no longer matches its own content address. */
  | "candidate-modified"
  /** Two notes claim one `source_id`. */
  | "identity-conflict";

/** Outcome of publishing one source document. */
export type Publication = {
  status: PublicationStatus;
  /** Vault-relative path of the note. */
  path: string;
  /** Exact bytes of the note as it now stands in the vault. */
  markdown: string;
  /** SHA-256 of those whole-note bytes. */
  digest: string;
  moc: "linked" | "pending";
  /**
   * Vault-relative paths of document-local assets copied for this note via
   * `obsidian-cli attach` (row F06). Absent when the source had none.
   */
  attachments?: string[];
  /** Preserved incoming note written beside a conflict, when one was written. */
  candidatePath?: string;
  /** Set whenever `status` is `conflict`. */
  conflictReason?: ConflictReason;
};

export interface Publisher {
  publish(input: SourceDocument): Promise<Publication>;
}

/** Result of one `obsidian-cli` process invocation. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one `obsidian-cli` invocation.
 *
 * Arguments are passed as an array and note bytes on stdin, never through a
 * shell, so Markdown containing backticks or `$(...)` is never expanded.
 */
export type CliRunner = (args: string[], stdin: string | null) => Promise<CliResult>;

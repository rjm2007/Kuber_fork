/**
 * Shared contract for the Excel/CSV lead import: the pure classifier
 * (lib/import-classify.ts), the route (app/api/v1/leads/import-excel), the
 * Zod schema (lib/validators/leads.ts) and the UI (components/app/lead-forms.tsx).
 * Types and limits only, no logic.
 *
 * Reconciliation (plan, before the DB look-up):
 *   totalRows = noEmail + duplicateInFile + skippedByChoice + skippedAmbiguous + importRows.length
 * Reconciliation (response):
 *   total_rows = inserted + skipped_no_email + skipped_duplicate_in_file + skipped_ambiguous
 *              + skipped_by_choice + skipped_duplicate_in_db + not_saved
 */

export type ImportRow = Record<string, unknown>;
/** platform field -> sheet column, e.g. { email: "E-mail", first_name: "Name" } */
export type ImportMapping = Record<string, string>;

export const IMPORT_LIMITS = {
  /** Hard cap on rows in one POST (Vercel body limit is ~4.5 MB; the client sends mapped columns only). */
  maxRows: 10000,
  /** Cells are cut to this many characters before any parsing. */
  maxCellChars: 1000,
  /** Candidate emails read from one cell. */
  maxEmailsPerCell: 10,
  /** Max entries in `choices`. */
  maxChoices: 5000,
} as const;

/**
 * What the user decided for one row, keyed by 0-based index into the POSTed `rows`.
 *  - "use_email": multi-email row -> use this one of the candidates;
 *                 ambiguous-group row -> use this edited email (becomes a different lead).
 *  - "skip":      multi-email row -> do not import it.
 *  - "keep":      ambiguous-group row -> this is the one to import (the others in the group are not).
 * The server honours a choice only for a row the classifier itself flagged for review;
 * anything else is ignored. A flagged row with no valid choice is NOT imported.
 */
export type RowChoice =
  | { action: "use_email"; email: string }
  | { action: "skip" }
  | { action: "keep" };
export type ImportChoices = Record<string, RowChoice>;

/** A row whose email cell holds more than one address. First candidate is the pre-selected one. */
export type ReviewMultiItem = {
  rowIndex: number;
  /** 1-based data-row number for display. */
  rowNumber: number;
  candidates: string[];
  name: string;
  company: string;
};

/** Rows that share one email but have different names. */
export type ReviewAmbiguousGroup = {
  email: string;
  rows: Array<{ rowIndex: number; rowNumber: number; name: string; company: string; title: string }>;
};

export type ImportPlan = {
  /** Non-empty rows. Fully blank rows are ignored and not counted anywhere. */
  totalRows: number;
  emptyRows: number;
  noEmail: number;
  duplicateInFile: number;
  skippedByChoice: number;
  skippedAmbiguous: number;
  /** Rows that pass every in-file rule, with their final cleaned email. The DB check (already in Kuber) is still pending. */
  importRows: Array<{ rowIndex: number; email: string }>;
  /** Among importRows: how many had an email auto-fixed by the typo dictionary. */
  emailsCorrected: number;
  /** Everything that needs a human decision, independent of `choices`. */
  review: { multi: ReviewMultiItem[]; ambiguous: ReviewAmbiguousGroup[] };
};

/** `name` is only ever set for members with leads:all. */
export type ImportOwnerCount = { assigned_to: string | null; count: number; name?: string };

/** Response of POST /api/v1/leads/import-excel (direct mode). */
export type ImportResult = {
  total_rows: number;
  inserted: number;
  skipped_no_email: number;
  skipped_duplicate_in_file: number;
  skipped_ambiguous: number;
  skipped_by_choice: number;
  /** Already in Kuber (non-deleted lead with that email in this company). */
  skipped_duplicate_in_db: number;
  /** Rows that passed every rule but could not be saved (insert error / lost race). Normally 0. */
  not_saved: number;
  emails_corrected: number;
  /**
   * Who owns the "already in Kuber" leads. Members with leads:all: real profile ids + `name`
   * (null id = unassigned). Everyone else: only null / "self" / "other", never a name or id,
   * enforced on the server.
   */
  duplicate_owner_counts: ImportOwnerCount[];
};

/** Sheets with data that the import did not read (client side, from the workbook). */
export type IgnoredSheet = { name: string; rows: number };

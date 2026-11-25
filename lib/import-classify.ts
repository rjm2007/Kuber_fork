/**
 * Pure classifier for the Excel/CSV lead import. No I/O, no node-only imports:
 * runs in the browser (review step, instant footer) and on the server
 * (authoritative re-check of the same rows + the user's choices).
 * Contract + limits: lib/import-review-types.ts.
 */
import { ensureSplitNames } from "./utils/person-name";
import {
  IMPORT_LIMITS,
  type ImportChoices, type ImportMapping, type ImportPlan, type ImportRow, type RowChoice,
} from "./import-review-types";

// ── Email cell cleaning ──────────────────────────────────────────────────────

const TRIM_CHARS = new Set(["<", ">", "(", ")", "[", "]", '"', "'", ".", ",", ";", ":"]);
function trimPunct(s: string): string {
  let a = 0, b = s.length;
  while (a < b && TRIM_CHARS.has(s[a]!)) a++;
  while (b > a && TRIM_CHARS.has(s[b - 1]!)) b--;
  return s.slice(a, b);
}

const LOCAL_OK = /^[\p{L}\p{N}._%+'-]+$/u;
const LABEL_OK = /^[a-z0-9-]+$/;
const TLD_OK = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

function isEmail(s: string): boolean {
  if (s.length > 254) return false;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_OK.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (!l || !LABEL_OK.test(l) || l.startsWith("-") || l.endsWith("-")) return false;
  }
  return TLD_OK.test(labels[labels.length - 1]!);
}

// Small, fixed, conservative dictionaries. Nothing fuzzy, unknown domains are never touched.
const DOMAIN_FIX: Record<string, string> = {
  "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmail.co": "gmail.com", "gmial.com": "gmail.com",
  "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmaill.com": "gmail.com", "gnail.com": "gmail.com",
  "gmail.coom": "gmail.com", "hotmial.com": "hotmail.com", "hotnail.com": "hotmail.com",
  "hotmail.con": "hotmail.com", "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com",
  "yhoo.com": "yahoo.com", "outlok.com": "outlook.com", "outlook.con": "outlook.com",
};
const BAD_TLDS = [".con", ".coom", ".comm", ".cmo", ".ocm"];

function fixTypo(email: string): string {
  const at = email.indexOf("@");
  const domain = email.slice(at + 1);
  const whole = DOMAIN_FIX[domain];
  if (whole) return email.slice(0, at + 1) + whole;
  for (const t of BAD_TLDS) {
    if (domain.endsWith(t) && domain.length > t.length + 1) return email.slice(0, at + 1) + domain.slice(0, -t.length) + ".com";
  }
  return email;
}

/** A cell as text. Only string/number/boolean count: a hostile nested array/object in the posted
 *  JSON made String() overflow the stack (500 + empty batch), so anything else is an empty cell. */
export const cellString = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";

const SEGMENT_SPLIT = /[;,/|\n]+|\s+(?:and|&)\s+/;

function cleanCell(raw: unknown): { candidates: string[]; fixed: boolean[] } {
  const candidates: string[] = [];
  const fixed: boolean[] = [];
  const s = cellString(raw)
    .slice(0, IMPORT_LIMITS.maxCellChars)
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ") // collapse runs: a 990-space cell made the \s*@\s* regex quadratic
    .toLowerCase();
  for (const seg of s.split(SEGMENT_SPLIT)) {
    if (candidates.length >= IMPORT_LIMITS.maxEmailsPerCell) break;
    // "a @x" -> "a@x" ; whitespace around "@" is never meaningful.
    const toks = seg.replace(/\s*@\s*/g, "@").split(/\s+/).filter(Boolean);
    const clean = (x: string) => { x = trimPunct(x); return x.startsWith("mailto:") ? trimPunct(x.slice(7)) : x; };
    for (let i = 0; i < toks.length && candidates.length < IMPORT_LIMITS.maxEmailsPerCell; i++) {
      let r = toks[i]!;
      let t = clean(r);
      // "a@x .com" / "a@x. com": glue the next piece while this one is not yet an email.
      while (t.includes("@") && !isEmail(t) && i + 1 < toks.length && (r.endsWith(".") || toks[i + 1]!.startsWith("."))) {
        r += toks[++i]!;
        t = clean(r);
      }
      if (!t.includes("@") || !isEmail(t)) continue;
      const fixedEmail = fixTypo(t);
      if (candidates.includes(fixedEmail)) continue;
      candidates.push(fixedEmail);
      fixed.push(fixedEmail !== t);
    }
  }
  return { candidates, fixed };
}

/** Clean one email cell into 0..n valid addresses. `corrected` = a typo-dictionary hit changed one. */
export function cleanEmailCell(raw: unknown): { candidates: string[]; corrected: boolean } {
  const { candidates, fixed } = cleanCell(raw);
  return { candidates, corrected: fixed.some(Boolean) };
}

// ── Names ────────────────────────────────────────────────────────────────────

const cellText = (row: ImportRow, col: string | undefined): string =>
  col ? cellString(row[col]).slice(0, IMPORT_LIMITS.maxCellChars).trim() : "";

/** Order-insensitive, accent/case/punctuation-insensitive key; "" = no name. */
function nameKey(first: string, last: string): string {
  const s = ensureSplitNames(first, last);
  const toks = `${s.firstName} ${s.lastName}`
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean);
  return [...new Set(toks)].sort().join(" ");
}

const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

// ── Classifier ───────────────────────────────────────────────────────────────

type Item = { rowIndex: number; email: string; fixed: boolean; key?: string };

export function classifyImport(rows: ImportRow[], mapping: ImportMapping, choices?: ImportChoices): ImportPlan {
  const emailCol = mapping["email"];
  const firstCol = mapping["first_name"], lastCol = mapping["last_name"];
  const orgCol = mapping["organization_name"], titleCol = mapping["title"];

  // Untrusted choices -> Map<rowIndex, RowChoice>, bounded.
  const chosen = new Map<number, RowChoice>();
  if (choices && typeof choices === "object") {
    let n = 0;
    for (const k of Object.keys(choices)) {
      if (++n > IMPORT_LIMITS.maxChoices) break;
      const idx = /^\d{1,9}$/.test(k) ? Number(k) : -1;
      const c = choices[k] as RowChoice | undefined;
      if (idx < 0 || idx >= rows.length || !c || typeof c !== "object") continue;
      if (c.action === "use_email" && typeof c.email === "string") chosen.set(idx, { action: "use_email", email: c.email.slice(0, 400) });
      else if (c.action === "skip" || c.action === "keep") chosen.set(idx, { action: c.action });
    }
  }

  const display = (row: ImportRow) => `${cellText(row, firstCol)} ${cellText(row, lastCol)}`.trim();
  const plan: ImportPlan = {
    totalRows: 0, emptyRows: 0, noEmail: 0, duplicateInFile: 0, skippedByChoice: 0, skippedAmbiguous: 0,
    importRows: [], emailsCorrected: 0, review: { multi: [], ambiguous: [] },
  };

  // 1. Rows -> resolved single-email items
  const items: Item[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (Object.values(row).every(isBlank)) { plan.emptyRows++; continue; }
    plan.totalRows++;
    const { candidates, fixed } = emailCol ? cleanCell(row[emailCol]) : { candidates: [], fixed: [] };
    if (candidates.length === 0) { plan.noEmail++; continue; }
    if (candidates.length === 1) { items.push({ rowIndex: i, email: candidates[0]!, fixed: fixed[0]! }); continue; }
    plan.review.multi.push({
      rowIndex: i, rowNumber: i + 1, candidates, name: display(row), company: cellText(row, orgCol),
    });
    const c = chosen.get(i);
    const at = c?.action === "use_email" ? candidates.indexOf(c.email.trim().toLowerCase()) : -1;
    if (at >= 0) items.push({ rowIndex: i, email: candidates[at]!, fixed: fixed[at]! });
    else plan.skippedByChoice++; // "skip", or no valid choice: never imported
  }

  const keyOf = (it: Item) => (it.key ??= nameKey(cellText(rows[it.rowIndex]!, firstCol), cellText(rows[it.rowIndex]!, lastCol)));
  const groupBy = (list: Item[]) => {
    const g = new Map<string, Item[]>();
    for (const it of list) { const a = g.get(it.email); if (a) a.push(it); else g.set(it.email, [it]); }
    return g;
  };
  const distinctNames = (g: Item[]) => new Set(g.map(keyOf).filter(Boolean)).size;

  // 2. First grouping = what is flagged for review (independent of edit/keep choices)
  const flagged = new Set<number>();
  for (const [email, g] of groupBy(items)) {
    if (g.length < 2 || distinctNames(g) < 2) continue;
    g.forEach((it) => flagged.add(it.rowIndex));
    plan.review.ambiguous.push({
      email,
      rows: g.map((it) => {
        const r = rows[it.rowIndex]!;
        return { rowIndex: it.rowIndex, rowNumber: it.rowIndex + 1, name: display(r), company: cellText(r, orgCol), title: cellText(r, titleCol) };
      }),
    });
  }

  // 3. Apply edits (flagged rows only): the row leaves its group and is regrouped.
  const keeps = new Set<number>();
  for (const it of items) {
    if (!flagged.has(it.rowIndex)) continue;
    const c = chosen.get(it.rowIndex);
    if (c?.action === "keep") keeps.add(it.rowIndex);
    else if (c?.action === "use_email") {
      const e = cleanCell(c.email);
      if (e.candidates.length === 1 && e.candidates[0] !== it.email) { it.email = e.candidates[0]!; it.fixed = e.fixed[0]!; }
    }
  }

  // 4. Final groups
  const keep: Item[] = [];
  for (const g of groupBy(items).values()) {
    if (g.length === 1) { keep.push(g[0]!); continue; }
    if (distinctNames(g) <= 1) {
      keep.push(g.find((it) => keyOf(it)) ?? g[0]!);
      plan.duplicateInFile += g.length - 1;
      continue;
    }
    const k = g.filter((it) => keeps.has(it.rowIndex));
    if (k.length === 1) { keep.push(k[0]!); plan.skippedAmbiguous += g.length - 1; }
    else plan.skippedAmbiguous += g.length;
  }

  keep.sort((a, b) => a.rowIndex - b.rowIndex);
  for (const it of keep) {
    plan.importRows.push({ rowIndex: it.rowIndex, email: it.email });
    if (it.fixed) plan.emailsCorrected++;
  }
  return plan;
}

import { NextRequest, after } from "next/server";
import crypto from "crypto";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { importAssignment } from "@/lib/auth/scope";
import { ok, fail } from "@/lib/api-response";
import { ExcelImportSchema } from "@/lib/validators/leads";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { normalizeDomain } from "@/lib/utils/domain";
import { ensureSplitNames } from "@/lib/utils/person-name";
import { dbForUser } from "@/lib/supabase/scoped";
import { hideOwners, withOwnerNames, type OwnerCount } from "@/lib/import-duplicates";
import { classifyImport, cellString } from "@/lib/import-classify";
import { IMPORT_LIMITS, type ImportChoices, type ImportResult } from "@/lib/import-review-types";

export const maxDuration = 300;

// Fix D: detect when org domain doesn't match the email domain.
// Exact/registrable-root comparison, not substring — a substring check here
// previously let "jmbpmurphy@o2.ie" written into the domain column pass as
// "no mismatch", since user@domain.tld always contains domain.tld as a
// substring of itself. normalizeDomain() now rejects that shape outright
// before this ever runs (defense in depth), but this also fixes the same
// substring flaw for any other accidental near-match.
function domainMismatch(orgDomain: string | null, email: string | null): boolean {
  if (!orgDomain || !email) return false;
  const emailDomain = email.split("@")[1] ?? "";
  const emailRoot = emailDomain.split(".").slice(-2).join(".");
  const orgRoot = orgDomain.split(".").slice(-2).join(".");
  return emailDomain !== orgDomain && emailRoot !== orgRoot;
}

// Fix D: reject country values that look like job titles (Excel column misalignment)
const TITLE_KEYWORDS = /^(manager|director|ceo|cfo|coo|cto|officer|executive|president|head|lead|chief|vp|supervisor|coordinator)$/i;
function sanitizeCountry(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length <= 2) return undefined; // too short to be a country name
  if (TITLE_KEYWORDS.test(trimmed)) return undefined;
  return trimmed;
}

type Db = ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>;
/** Thrown before anything is written, so the empty import batch can be removed. */
class PreInsertError extends Error {}

function emailHash(email: string): string {
  return crypto.createHash("sha1").update(email.toLowerCase()).digest("hex");
}

async function parseExcel(buffer: Buffer): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Empty workbook");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length === 0) throw new Error("No rows found");
  const headers = Object.keys(rows[0]);
  return { headers, rows };
}

async function processRows(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
  userId: string,
  db: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  importId?: string | null,
  assignedTo?: string | null,
  assignmentStrategy?: "manual" | "round_robin" | "territory",
  /** Own import (no leads:assign): the leads are the importer's from the start —
   *  deferred assignment only happens once enrichment succeeds, and a lead whose
   *  site can't be read would otherwise stay unowned and invisible to them. */
  assignNow = false,
  /** The user's review decisions. Untrusted: classifyImport re-validates every entry. */
  choices?: ImportChoices,
): Promise<{ result: ImportResult; ownerCounts: OwnerCount[] }> {
  const orgNameCol = mapping["organization_name"];
  const orgDomainCol = mapping["organization_domain"];
  const titleCol = mapping["title"];
  const countryCol = mapping["country"];
  const cell = (row: Record<string, unknown>, col: string | undefined) =>
    col ? cellString(row[col]).slice(0, IMPORT_LIMITS.maxCellChars).trim() : "";

  // Authoritative classification: the same pure function the review step uses.
  const plan = classifyImport(rows, mapping, choices);
  const validRows = plan.importRows.map(({ rowIndex, email }) => {
    const row = rows[rowIndex]!;
    // Single "Name" columns are often mapped to first_name only — split when
    // last_name is blank so "Lionel Pernaud" does not land entirely in first_name.
    const { firstName, lastName } = ensureSplitNames(cell(row, mapping["first_name"]), cell(row, mapping["last_name"]));
    return {
      email,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      org_name: cell(row, orgNameCol) || "Unknown",
      org_domain: cell(row, orgDomainCol) || undefined,
      title: cell(row, titleCol) || undefined,
      country: sanitizeCountry(cell(row, countryCol) || undefined),
    };
  });

  let insertedCount = 0;
  let skippedDuplicateInDb = 0;

  const CHUNK = 500; // lead insert only (body, not URL)
  const LOOKUP_CHUNK = 150; // .in() goes in the URL: 500 long emails overran the 8KB limit

  // ── 1. Dedupe against existing LIVE emails (batched, chunks in parallel) ──
  // Soft-deleted leads don't block re-import: the email index
  // (leads_company_lower_email_active_uidx) only covers live rows. They DO still hold
  // their apollo_id (uq_leads_company_apollo is not partial), so a re-imported email
  // gets a fresh suffix below. One query serves both: no is_deleted filter, split here.
  const existingOwners = new Map<string, string | null>();
  const softDeleted = new Set<string>();
  const chunks: string[][] = [];
  for (let i = 0; i < validRows.length; i += LOOKUP_CHUNK) chunks.push(validRows.slice(i, i + LOOKUP_CHUNK).map((r) => r.email));
  const lookups = await Promise.all(chunks.map((chunk) =>
    db.from("leads").select("email, assigned_to, is_deleted").in("email", chunk)));
  for (const { data, error } of lookups) {
    // A failed look-up must not fall through to insert: a 23505 would drop a whole chunk silently.
    if (error) throw new PreInsertError(`Duplicate check failed: ${error.message}`);
    (data ?? []).forEach((r) => {
      if (r.is_deleted) softDeleted.add(r.email);
      else existingOwners.set(r.email, r.assigned_to as string | null);
    });
  }

  // Uncapped "who owns how many". Names / hiding happen in the POST handler.
  const ownerCounts = new Map<string | null, number>();
  const toInsert = validRows.filter((r) => {
    if (!existingOwners.has(r.email)) return true;
    skippedDuplicateInDb++;
    const owner = existingOwners.get(r.email) ?? null;
    ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
    return false;
  });
  const duplicateOwnerCounts: OwnerCount[] = [...ownerCounts].map(([assigned_to, count]) => ({ assigned_to, count }));
  const finish = () => ({
    ownerCounts: duplicateOwnerCounts,
    result: {
      total_rows: plan.totalRows,
      inserted: insertedCount,
      skipped_no_email: plan.noEmail,
      skipped_duplicate_in_file: plan.duplicateInFile,
      skipped_ambiguous: plan.skippedAmbiguous,
      skipped_by_choice: plan.skippedByChoice,
      skipped_duplicate_in_db: skippedDuplicateInDb,
      // Passed every rule but not saved (no org, insert error, lost race): shown, never silent.
      not_saved: plan.importRows.length - skippedDuplicateInDb - insertedCount,
      emails_corrected: plan.emailsCorrected,
      duplicate_owner_counts: [],
    } satisfies ImportResult,
  });
  if (toInsert.length === 0) return finish();

  // ── 2. Resolve orgs in bulk ───────────────────────────────────────────────
  // Compute safe domain per row upfront
  const rowsWithDomain = toInsert.map((r) => {
    const nd = r.org_domain ? normalizeDomain(r.org_domain) : null;
    const safeDomain = nd && !domainMismatch(nd, r.email) ? nd : null;
    return { ...r, safeDomain };
  });

  const uniqueDomains = [...new Set(rowsWithDomain.map((r) => r.safeDomain).filter(Boolean) as string[])];
  const uniqueNames   = [...new Set(rowsWithDomain.filter((r) => !r.safeDomain).map((r) => r.org_name.toLowerCase()))];

  // Fetch existing orgs by domain
  const domainToOrgId = new Map<string, string>();
  const domainChunks: string[][] = [];
  for (let i = 0; i < uniqueDomains.length; i += LOOKUP_CHUNK) domainChunks.push(uniqueDomains.slice(i, i + LOOKUP_CHUNK));
  const domainLookups = Promise.all(domainChunks.map((c) => db.from("organizations").select("id, domain").in("domain", c)));

  // Fetch existing orgs by name (for domain-less rows). Chunks of 50 keep the URL short;
  // all org look-ups run in parallel.
  const nameToOrgId = new Map<string, string>();
  const nameChunks: string[][] = [];
  for (let i = 0; i < uniqueNames.length; i += 50) nameChunks.push(uniqueNames.slice(i, i + 50));
  const nameLookups = Promise.all(nameChunks.map((c) => db.from("organizations").select("id, name").in("name", c)));
  for (const { data } of await domainLookups) (data ?? []).forEach((o) => { if (o.domain) domainToOrgId.set(o.domain, o.id); });
  for (const { data } of await nameLookups) (data ?? []).forEach((o) => { if (o.name) nameToOrgId.set(o.name.toLowerCase(), o.id); });

  // Create missing orgs in bulk
  const missingDomainOrgs = uniqueDomains
    .filter((d) => !domainToOrgId.has(d))
    .map((d) => {
      const row = rowsWithDomain.find((r) => r.safeDomain === d)!;
      return { name: row.org_name, domain: d, domain_source: "manual", created_at: new Date().toISOString() };
    });

  const missingNameOrgs = uniqueNames
    .filter((n) => !nameToOrgId.has(n))
    .map((n) => {
      const row = rowsWithDomain.find((r) => !r.safeDomain && r.org_name.toLowerCase() === n)!;
      // No website in the sheet is NOT the end of the road — the row still has
      // an email, and a work address gives up the company domain for free
      // (sales@maapet.com -> maapet.com). Queue it so scrape-orgs' domain
      // resolution can try, then scrape it like any other company. Only if the
      // address is webmail (gmail/yahoo) does resolution give up, and it is
      // resolution that concludes the org NO_DOMAIN -> Input Required.
      //
      // This used to be marked "failed / No website found" right here, which
      // meant it was never queued, never resolved, and never scraped — a
      // spreadsheet without a website column could never enrich at all.
      return {
        name: row.org_name,
        enrichment_stage: "queued",
        enrichment_status: "SCRAPE_QUEUED",
        created_at: new Date().toISOString(),
      };
    });

  // Bulk insert; if it errors (one bad row, e.g. NUL byte, fails the whole
  // statement) retry one by one so good orgs still land. A failed org stays out
  // of the map, so only its own lead rows end up in not_saved.
  const insertOrgs = async (
    list: Record<string, unknown>[],
    key: "domain" | "name",
    map: Map<string, string>,
  ) => {
    if (list.length === 0) return;
    const put = (data: { id: string; domain?: string | null; name?: string | null }[] | null) =>
      (data ?? []).forEach((o) => {
        const k = o[key];
        if (k) map.set(key === "name" ? k.toLowerCase() : k, o.id);
      });
    const { data, error } = await db.from("organizations").insert(list).select("id, domain, name");
    if (!error) return put(data);
    for (let j = 0; j < list.length; j += 25) {
      const res = await Promise.all(list.slice(j, j + 25).map((o) => db.from("organizations").insert(o).select("id, domain, name")));
      for (const { data: d, error: e } of res) if (!e) put(d);
    }
  };
  await insertOrgs(missingDomainOrgs, "domain", domainToOrgId);
  await insertOrgs(missingNameOrgs, "name", nameToOrgId);

  // ── 3. Build lead rows and bulk insert ────────────────────────────────────
  const leadRows = rowsWithDomain.map((row) => {
    const orgId = row.safeDomain ? domainToOrgId.get(row.safeDomain) : nameToOrgId.get(row.org_name.toLowerCase());
    if (!orgId) return null;
    return {
      email: row.email,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      title: row.title ?? null,
      country: row.country ?? null,
      organization_id: orgId,
      apollo_id: `excel_${emailHash(row.email)}${softDeleted.has(row.email) ? `_${crypto.randomUUID().slice(0, 8)}` : ""}`,
      lead_source: "excel",
      created_by: userId,
      import_id: importId ?? null,
      // Deferred assignment: land unassigned; the import's stored choice is
      // applied by autoAssignEnrichedLeads once each lead is workable (it only
      // touches unassigned leads). An own import is assigned straight away.
      assigned_to: assignNow ? assignedTo ?? null : null,
      assigned_at: assignNow && assignedTo ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    };
  }).filter(Boolean) as object[];

  const insertedIds: string[] = [];
  for (let i = 0; i < leadRows.length; i += CHUNK) {
    const chunk = leadRows.slice(i, i + CHUNK);
    const { data, error } = await db.from("leads").insert(chunk).select("id");
    if (!error) {
      insertedCount += (data ?? []).length;
      insertedIds.push(...(data ?? []).map((r) => r.id as string));
      continue;
    }
    // One bad row (NUL byte, lone surrogate, race-lost 23505) fails the whole chunk insert:
    // retry row by row so good rows still land. A row failing alone stays in not_saved.
    for (let j = 0; j < chunk.length; j += 25) {
      const res = await Promise.all(chunk.slice(j, j + 25).map((r) => db.from("leads").insert(r).select("id")));
      for (const { data: d, error: e } of res) {
        if (e) continue;
        insertedCount += (d ?? []).length;
        insertedIds.push(...(d ?? []).map((x) => x.id as string));
      }
    }
  }

  // Assignment is deferred to autoAssignEnrichedLeads (post-enrichment).
  void assignedTo; void assignmentStrategy;

  if (insertedIds.length > 0) {
    const { logLeadEvents } = await import("@/lib/services/lead-events");
    await logLeadEvents(db, insertedIds.map((id) => ({
      leadId: id, event: "created" as const, detail: "Imported from Excel/CSV", actorId: userId,
    })));
  }

  return finish();
}

/** Who owns an "already in Kuber" lead is other people's data. leads:all members get real ids
 *  + names (one profiles query, only when an owner exists); everyone else gets self/other/null,
 *  no id, no name. Enforced here, never in the UI. */
async function ownersFor(
  user: { id: string; member: Parameters<typeof canSeeAll>[0] },
  db: Db,
  counts: OwnerCount[],
): Promise<OwnerCount[]> {
  if (!canSeeAll(user.member, "leads")) return hideOwners(counts, user.id);
  const ids = counts.map((c) => c.assigned_to).filter((x): x is string => !!x);
  if (ids.length === 0) return counts;
  const { data } = await db.from("profiles").select("id, full_name, email").in("id", ids);
  return withOwnerNames(counts, new Map((data ?? []).map((p) => [p.id as string, p])));
}

async function runImport(
  req: NextRequest, user: Awaited<ReturnType<typeof requireScope>>, db: ReturnType<typeof dbForUser>,
  rows: Record<string, unknown>[], mapping: Record<string, string>, batch_name: string, color: string | undefined,
  assigned_to: string | null | undefined, assignment_strategy: "manual" | "round_robin" | "territory" | null | undefined,
  ownImport: boolean, choices?: ImportChoices,
) {
  if (!mapping["email"]) return fail(400, "VALIDATION_ERROR", "Mapping must include an 'email' column");
  const { data: importRow } = await db.from("imports")
    .insert({ label: batch_name, source: "excel", created_by: user.id, lead_count: 0, color: color ?? "violet", ...importAssignmentFields(assigned_to, assignment_strategy) })
    .select("id").single();
  const importId = importRow?.id ?? null;
  try {
    const { result, ownerCounts } = await processRows(rows, mapping, user.id, db, importId, assigned_to, assignment_strategy ?? undefined, ownImport, choices);
    await finishImport(db, importId, result.inserted);
    if (result.inserted > 0) triggerScrape(req);
    return ok({ ...result, duplicate_owner_counts: await ownersFor(user, db, ownerCounts) });
  } catch (e) {
    if (e instanceof PreInsertError) await finishImport(db, importId, 0); // nothing saved: no empty batch left behind
    return fail(500, "IMPORT_FAILED", (e as Error).message);
  }
}

/** Keep the batch only when it got leads. A file of all duplicates used to
 *  leave an empty batch behind on every try (3 x "Kazakhstan-2024", 17 Nov). */
async function finishImport(db: ReturnType<typeof dbForUser>, importId: string | null, inserted: number) {
  if (!importId) return;
  if (inserted > 0) await db.from("imports").update({ lead_count: inserted }).eq("id", importId);
  else await db.from("imports").delete().eq("id", importId);
}

/** import-time assignment choice → columns stored on the import row (deferred). */
function importAssignmentFields(assignedTo?: string | null, strategy?: "manual" | "round_robin" | "territory" | null) {
  return {
    assignment_strategy: assignedTo ? "manual" : (strategy ?? null),
    assignment_target: assignedTo ?? null,
  };
}

function triggerScrape(req: NextRequest) {
  if (!process.env.INTERNAL_SECRET) return;
  const base = internalAppBaseUrl(req);
  const secret = process.env.INTERNAL_SECRET;
  after(() =>
    fetch(`${base}/api/enrich/scrape-orgs`, {
      method: "POST",
      headers: { "x-internal-secret": secret },
    }).catch(() => {})
  );
}

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "imports:excel"); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = ExcelImportSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  // Who gets the leads: chosen (person / strategy / pool) with leads:assign;
  // without it, everything imported is assigned to the importer (importAssignment).
  // Written back onto parsed.data so both import modes below use it.
  let ownImport = false;
  if (parsed.data.mode !== "headers") {
    const a = importAssignment(user, parsed.data as { assigned_to?: string | null; assignment_strategy?: string | null });
    Object.assign(parsed.data, { assigned_to: a.assigned_to ?? undefined, assignment_strategy: a.assignment_strategy ?? undefined });
    ownImport = a.self;
  }
  if (parsed.data.mode !== "headers" && parsed.data.assigned_to) {
    const { data: employee } = await db.from("profiles").select("id, is_active").eq("id", parsed.data.assigned_to).maybeSingle();
    if (!employee || !employee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  // Direct mode — rows provided in the request body, no storage needed
  if (parsed.data.mode === "direct") {
    const { rows, mapping, batch_name, color, assigned_to, assignment_strategy, choices } = parsed.data;
    return runImport(req, user, db, rows, mapping, batch_name, color, assigned_to, assignment_strategy, ownImport, choices as ImportChoices | undefined);
  }

  // Storage modes — download file first
  const { data: fileData, error: dlError } = await db.storage
    .from("excel-imports")
    .download(parsed.data.storage_path);
  if (dlError || !fileData) return fail(422, "VALIDATION_ERROR", "Could not download file from storage");

  const buffer = Buffer.from(await fileData.arrayBuffer());
  let parsed_excel: Awaited<ReturnType<typeof parseExcel>>;
  try {
    parsed_excel = await parseExcel(buffer);
  } catch (e) {
    return fail(422, "VALIDATION_ERROR", `Could not parse Excel file: ${(e as Error).message}`);
  }

  if (parsed.data.mode === "headers") {
    return ok({ columns: parsed_excel.headers });
  }

  // mode === "import"
  const { mapping, batch_name: importBatchName, color: importColor, assigned_to: importAssignedTo, assignment_strategy: importStrategy } =
    parsed.data as { mapping: Record<string, string>; batch_name: string; color: string; assigned_to?: string | null; assignment_strategy?: "round_robin" | "territory" };
  if (parsed_excel.rows.length > IMPORT_LIMITS.maxRows) return fail(422, "VALIDATION_ERROR", `Too many rows (max ${IMPORT_LIMITS.maxRows}), split the file`);
  // No choices here: multi-email / ambiguous rows are not imported (safe default).
  return runImport(req, user, db, parsed_excel.rows, mapping, importBatchName, importColor, importAssignedTo, importStrategy, ownImport);
}

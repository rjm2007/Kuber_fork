import { NextRequest, after } from "next/server";
import crypto from "crypto";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { ExcelImportSchema } from "@/lib/validators/leads";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { normalizeDomain } from "@/lib/utils/domain";
import { ensureSplitNames } from "@/lib/utils/person-name";
import { dbForUser } from "@/lib/supabase/scoped";

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
) {
  const emailCol = mapping["email"];
  const firstNameCol = mapping["first_name"];
  const lastNameCol = mapping["last_name"];
  const orgNameCol = mapping["organization_name"];
  const orgDomainCol = mapping["organization_domain"];
  const titleCol = mapping["title"];
  const countryCol = mapping["country"];

  let insertedCount = 0;
  let skippedBlankEmail = 0;
  let skippedInvalidEmail = 0;
  let skippedDuplicateInFile = 0;
  let skippedDuplicateInDb = 0;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seenEmails = new Set<string>();
  const validRows: Array<{
    email: string; first_name?: string; last_name?: string;
    org_name: string; org_domain?: string; title?: string; country?: string;
  }> = [];

  for (const row of rows) {
    const rawEmail = String(row[emailCol] ?? "").trim();
    if (!rawEmail) { skippedBlankEmail++; continue; }
    if (!emailRegex.test(rawEmail)) { skippedInvalidEmail++; continue; }
    const email = rawEmail.toLowerCase();
    if (seenEmails.has(email)) { skippedDuplicateInFile++; continue; }
    seenEmails.add(email);
    // Single "Name" columns are often mapped to first_name only — split when
    // last_name is blank so "Lionel Pernaud" does not land entirely in first_name.
    const { firstName, lastName } = ensureSplitNames(
      firstNameCol ? String(row[firstNameCol] ?? "").trim() : "",
      lastNameCol ? String(row[lastNameCol] ?? "").trim() : "",
    );
    validRows.push({
      email,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      org_name: orgNameCol ? String(row[orgNameCol] ?? "").trim() || "Unknown" : "Unknown",
      org_domain: orgDomainCol ? String(row[orgDomainCol] ?? "").trim() || undefined : undefined,
      title: titleCol ? String(row[titleCol] ?? "").trim() || undefined : undefined,
      country: sanitizeCountry(countryCol ? String(row[countryCol] ?? "").trim() || undefined : undefined),
    });
  }

  const CHUNK = 500;

  // ── 1. Dedupe against existing LIVE emails (batched) ─────────────────────
  // Soft-deleted leads don't block re-import (planning.md Phase 5 / Q7).
  // Track WHO already owns each duplicate — previously a second importer was
  // just told "skipped" with no idea the lead belongs to someone else
  // (review §3.3), capped to a reasonable sample for the response.
  const existingOwners = new Map<string, string | null>();
  for (let i = 0; i < validRows.length; i += CHUNK) {
    const chunk = validRows.slice(i, i + CHUNK).map((r) => r.email);
    const { data: existing } = await db.from("leads").select("email, assigned_to").in("email", chunk).eq("is_deleted", false);
    (existing ?? []).forEach((r) => existingOwners.set(r.email, r.assigned_to as string | null));
  }

  const DUPLICATE_SAMPLE_CAP = 50;
  const duplicateOwners: Array<{ email: string; assigned_to: string | null }> = [];
  const toInsert = validRows.filter((r) => {
    if (existingOwners.has(r.email)) {
      skippedDuplicateInDb++;
      if (duplicateOwners.length < DUPLICATE_SAMPLE_CAP) {
        duplicateOwners.push({ email: r.email, assigned_to: existingOwners.get(r.email) ?? null });
      }
      return false;
    }
    return true;
  });
  if (toInsert.length === 0) {
    return {
      inserted: 0, skipped_blank_email: skippedBlankEmail, skipped_invalid_email: skippedInvalidEmail,
      skipped_duplicate_in_file: skippedDuplicateInFile, skipped_duplicate_in_db: skippedDuplicateInDb,
      duplicate_owners: duplicateOwners,
    };
  }

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
  if (uniqueDomains.length > 0) {
    for (let i = 0; i < uniqueDomains.length; i += CHUNK) {
      const { data } = await db.from("organizations").select("id, domain").in("domain", uniqueDomains.slice(i, i + CHUNK));
      (data ?? []).forEach((o) => { if (o.domain) domainToOrgId.set(o.domain, o.id); });
    }
  }

  // Fetch existing orgs by name (for domain-less rows)
  const nameToOrgId = new Map<string, string>();
  if (uniqueNames.length > 0) {
    // ilike OR filter not supported for bulk — use .in with lower() via rpc fallback; use sequential batches
    const nameChunks = [];
    for (let i = 0; i < uniqueNames.length; i += 50) nameChunks.push(uniqueNames.slice(i, i + 50));
    for (const chunk of nameChunks) {
      const { data } = await db.from("organizations").select("id, name").in("name", chunk);
      (data ?? []).forEach((o) => { if (o.name) nameToOrgId.set(o.name.toLowerCase(), o.id); });
    }
  }

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

  if (missingDomainOrgs.length > 0) {
    const { data } = await db.from("organizations").insert(missingDomainOrgs).select("id, domain");
    (data ?? []).forEach((o) => { if (o.domain) domainToOrgId.set(o.domain, o.id); });
  }
  if (missingNameOrgs.length > 0) {
    const { data } = await db.from("organizations").insert(missingNameOrgs).select("id, name");
    (data ?? []).forEach((o) => { if (o.name) nameToOrgId.set(o.name.toLowerCase(), o.id); });
  }

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
      apollo_id: `excel_${emailHash(row.email)}`,
      lead_source: "excel",
      created_by: userId,
      import_id: importId ?? null,
      // Deferred assignment: land unassigned; the import's stored choice is
      // applied by autoAssignEnrichedLeads once each lead is workable.
      assigned_to: null,
      assigned_at: null,
      created_at: new Date().toISOString(),
    };
  }).filter(Boolean) as object[];

  const insertedIds: string[] = [];
  for (let i = 0; i < leadRows.length; i += CHUNK) {
    const { data, error } = await db.from("leads").insert(leadRows.slice(i, i + CHUNK)).select("id");
    if (!error) {
      insertedCount += (data ?? []).length;
      insertedIds.push(...(data ?? []).map((r) => r.id as string));
    } else if (error.code === "23505") skippedDuplicateInDb += leadRows.slice(i, i + CHUNK).length;
  }

  // Assignment is deferred to autoAssignEnrichedLeads (post-enrichment).
  void assignedTo; void assignmentStrategy;

  if (insertedIds.length > 0) {
    const { logLeadEvents } = await import("@/lib/services/lead-events");
    await logLeadEvents(db, insertedIds.map((id) => ({
      leadId: id, event: "created" as const, detail: "Imported from Excel/CSV", actorId: userId,
    })));
  }

  return {
    inserted: insertedCount, skipped_blank_email: skippedBlankEmail, skipped_invalid_email: skippedInvalidEmail,
    skipped_duplicate_in_file: skippedDuplicateInFile, skipped_duplicate_in_db: skippedDuplicateInDb,
    assignment_skipped: 0, duplicate_owners: duplicateOwners,
  };
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
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = ExcelImportSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  if (parsed.data.mode !== "headers" && parsed.data.assigned_to) {
    const { data: employee } = await db.from("profiles").select("id, is_active").eq("id", parsed.data.assigned_to).maybeSingle();
    if (!employee || !employee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  // Direct mode — rows provided in the request body, no storage needed
  if (parsed.data.mode === "direct") {
    const { rows, mapping, batch_name, color, assigned_to, assignment_strategy } = parsed.data;
    if (!mapping["email"]) return fail(400, "VALIDATION_ERROR", "Mapping must include an 'email' column");
    const { data: importRow } = await db.from("imports")
      .insert({ label: batch_name, source: "excel", created_by: user.id, lead_count: 0, color: color ?? "violet", ...importAssignmentFields(assigned_to, assignment_strategy) })
      .select("id").single();
    const importId = importRow?.id ?? null;
    const result = await processRows(rows, mapping, user.id, db, importId, assigned_to, assignment_strategy);
    if (importId && result.inserted > 0) {
      await db.from("imports").update({ lead_count: result.inserted }).eq("id", importId);
    }
    if (result.inserted > 0) triggerScrape(req);
    return ok(result);
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
  if (!mapping["email"]) return fail(400, "VALIDATION_ERROR", "Mapping must include an 'email' column");
  const { data: importRow2 } = await db.from("imports")
    .insert({ label: importBatchName, source: "excel", created_by: user.id, lead_count: 0, color: importColor ?? "violet", ...importAssignmentFields(importAssignedTo, importStrategy) })
    .select("id").single();
  const importId2 = importRow2?.id ?? null;
  const result = await processRows(parsed_excel.rows, mapping, user.id, db, importId2, importAssignedTo, importStrategy);
  if (importId2 && result.inserted > 0) {
    await db.from("imports").update({ lead_count: result.inserted }).eq("id", importId2);
  }
  if (result.inserted > 0) triggerScrape(req);
  return ok(result);
}

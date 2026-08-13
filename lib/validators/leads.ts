import { z } from "zod";
import { dbId } from "./id";
import { domainField } from "@/lib/validators/organizations";
import { COMPANY_LOOKUP_MAX_CONTACTS, COMPANY_LOOKUP_MAX_PAGES } from "@/lib/constants";

export const CreateLeadSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email(),
  title: z.string().optional(),
  headline: z.string().optional(),
  linkedin_url: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  organization_name: z.string().min(1),
  organization_domain: domainField.optional(),
  organization_industry: z.string().optional(),
  organization_country: z.string().optional(),
  batch_name: z.string().optional(),
  color: z.string().optional(),
  import_id: dbId.optional(),
  assigned_to: dbId.nullable().optional(),
});

export const PatchLeadSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
  headline: z.string().optional(),
  linkedin_url: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  email_status: z.string().optional(),
  status: z.enum(["new", "enriching", "enriched", "input_required", "open", "closed"]).optional(),
  // Single-lead reassignment (manager-only, enforced in the route) — the
  // previous only way to move one lead was bulk-assign or a campaign-assign
  // side effect (review §3.2). null = return to the pool.
  assigned_to: dbId.nullable().optional(),
});

/** "a,b,c" -> ["a","b","c"]. Empty/blank entries dropped so a trailing comma
 *  or an empty param can never turn into an `.in(col, [""])` that matches
 *  nothing. */
const csvList = z
  .string()
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .optional();

export const LeadListQuerySchema = z.object({
  country: z.string().optional(),
  email_status: z.string().optional(),
  lead_source: z.enum(["apollo", "excel", "manual"]).optional(),
  organization_id: dbId.optional(),
  email_domain_catchall: z.enum(["true", "false"]).optional(),
  import_id: dbId.optional(),
  created_after: z.string().datetime().optional(),
  assigned_to: z.string().optional(),
  // Multi-select filters, comma-separated. The Leads page used to apply these
  // in the browser against the ~500 rows it had loaded, which silently missed
  // anything further back than the newest page. They belong in the query.
  statuses: csvList,
  sources: csvList,
  import_ids: csvList,
  created_before: z.string().datetime().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(2000).default(50),
});

// Imports can distribute leads as they land (planning.md Phase 4 / Q5):
// `assigned_to` = manual target (legacy, still supported); `assignment_strategy`
// = spread the batch round-robin or by territory instead.
const ImportAssignmentStrategy = z.enum(["round_robin", "territory"]).optional();

export const ApolloSearchSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1),
  locations: z.array(z.string()).default([]),
  // No max_pages: search depth is derived from the caps below, not chosen.
  // Apollo's search endpoint spends no lead credits, so a page budget could
  // only ever stop an import short of the cap the manager asked for — see
  // apollo-search/route.ts.
  titles: z.array(z.string()).nullable().optional(),
  seniorities: z.array(z.string()).nullable().optional(),
  batch_name: z.string().min(1),
  color: z.string().default("violet"),
  preview: z.boolean().optional(),
  assigned_to: dbId.nullable().optional(),
  assignment_strategy: ImportAssignmentStrategy,
  // Every lead inserted here eventually gets a paid Apollo bulk_match call —
  // these are the actual credit-spend ceilings for the import, enforced
  // server-side in apollo-search/route.ts regardless of what the client sends.
  // 500 is the ceiling for a single import, by the account owner's decision:
  // one import is one burst of spend, and 500 is the largest burst worth risking
  // in one go. It is enforced here, server-side, whatever the client sends.
  max_total_leads: z.number().int().min(25).max(500).default(200),
  max_leads_per_keyword: z.union([z.literal(25), z.literal(50)]).default(50),
  // Strict mode trades range for safety: only the tightest tiers are allowed.
  strict_cap: z.boolean().default(false),
}).refine(
  (data) => !data.strict_cap || [25, 50, 100].includes(data.max_total_leads),
  { message: "Strict mode only allows 25, 50, or 100 total leads", path: ["max_total_leads"] },
);

// ── Company Lookup ──────────────────────────────────────────────────────────

/** Every Organization Search filter beyond the three basic fields, surfaced in
 *  the UI under Advanced Search. All optional — an untouched Advanced panel
 *  must never narrow a search. */
const CompanyAdvancedSchema = z.object({
  employeeRanges: z.array(z.string()).optional(),
  keywordTags: z.array(z.string()).optional(),
  revenueMin: z.number().nonnegative().optional(),
  revenueMax: z.number().nonnegative().optional(),
  technologyUids: z.array(z.string()).optional(),
  notLocations: z.array(z.string()).optional(),
  latestFundingAmountMin: z.number().nonnegative().optional(),
  latestFundingAmountMax: z.number().nonnegative().optional(),
  totalFundingMin: z.number().nonnegative().optional(),
  totalFundingMax: z.number().nonnegative().optional(),
  latestFundingDateMin: z.string().optional(),
  latestFundingDateMax: z.string().optional(),
  jobTitles: z.array(z.string()).optional(),
  jobLocations: z.array(z.string()).optional(),
  numJobsMin: z.number().int().nonnegative().optional(),
  numJobsMax: z.number().int().nonnegative().optional(),
  jobPostedAtMin: z.string().optional(),
  jobPostedAtMax: z.string().optional(),
}).optional();

export const CompanySearchSchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.string().trim().max(100).optional(),
  website: z.string().trim().max(200).optional(),
  // Each page is a paid Apollo call. Capped here as well as in the UI so a
  // hand-rolled request cannot walk Apollo's 500-page limit on our credits.
  page: z.number().int().min(1).max(COMPANY_LOOKUP_MAX_PAGES).default(1),
  advanced: CompanyAdvancedSchema,
});

export const CompanyPeopleSchema = z.object({
  apollo_org_id: z.string().trim().min(1),
  page: z.number().int().min(1).max(20).default(1),
});

/** One selected contact, carried from the free people search. Only `apollo_id`
 *  is load-bearing — the rest is display data re-fetched authoritatively by the
 *  paid reveal, so nothing here is trusted as final. */
const CompanyContactSchema = z.object({
  apollo_id: z.string().trim().min(1),
  first_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

export const CompanyImportSchema = z.object({
  organization: z.object({
    apollo_org_id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    domain: z.string().trim().nullable().optional(),
    website: z.string().trim().nullable().optional(),
    industry: z.string().trim().nullable().optional(),
    employees: z.number().int().nullable().optional(),
    city: z.string().trim().nullable().optional(),
    state: z.string().trim().nullable().optional(),
    country: z.string().trim().nullable().optional(),
  }),
  // THE spend ceiling for the reveal step. Enforced here so the limit holds
  // regardless of what the client sends.
  contacts: z.array(CompanyContactSchema).min(1).max(COMPANY_LOOKUP_MAX_CONTACTS),
  batch_name: z.string().min(1),
  color: z.string().default("violet"),
  assigned_to: dbId.nullable().optional(),
  assignment_strategy: ImportAssignmentStrategy,
});

export const ExcelImportSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("headers"), storage_path: z.string().min(1) }),
  z.object({
    mode: z.literal("import"),
    storage_path: z.string().min(1),
    mapping: z.record(z.string(), z.string()),
    batch_name: z.string().min(1),
    color: z.string().default("violet"),
    assigned_to: dbId.nullable().optional(),
    assignment_strategy: ImportAssignmentStrategy,
  }),
  z.object({
    mode: z.literal("direct"),
    rows: z.array(z.record(z.string(), z.unknown())),
    mapping: z.record(z.string(), z.string()),
    batch_name: z.string().min(1),
    color: z.string().default("violet"),
    assigned_to: dbId.nullable().optional(),
    assignment_strategy: ImportAssignmentStrategy,
  }),
]);

export const EnrichSchema = z.union([
  z.object({
    campaign_id: dbId,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({
    lead_ids: z.array(dbId).min(1).max(200),
  }),
  z.object({
    import_id: dbId,
  }),
]);

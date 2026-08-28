import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { classifyFallback } from "@/lib/services/fallback-reason";

// Surfaces recent upstream credit/auth failures so the UI can show a clear
// "top up / fix your API key" banner instead of leaving managers to decode raw
// HTTP 402 dumps buried in a lead's enrichment log. Scans the last few hours of
// enrichment_logs for the signatures of the three paid providers.
//
// Deliberately looks at the NEWEST log row per provider, not "any error in the
// window" — an old 402 sitting in the last 6h must not keep the banner up
// after the key's been fixed and later scrapes are succeeding again. Rows with
// error: null (successes) are included in the query for exactly this reason:
// they're what lets a fixed key "win" over a stale error.
const LOOKBACK_HOURS = 6;

// "warning" = degraded but still functioning (a fallback is covering the gap);
// "critical" = the capability is actually down. Drives banner color (amber vs red).
type ServiceIssue = { service: string; kind: "credits" | "auth"; message: string; severity: "warning" | "critical" };

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: rows } = await db
    .from("enrichment_logs")
    .select("source, event, error, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  const issues: ServiceIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: ServiceIssue) => {
    if (seen.has(issue.service)) return;
    seen.add(issue.service);
    issues.push(issue);
  };

  for (const row of rows ?? []) {
    const err = (row.error ?? "").toLowerCase();

    // Instantly's copy of a sequence no longer matches ours. Not a credit or
    // auth problem, but it belongs here for the same reason the others do: it
    // is an upstream disagreement nobody would otherwise notice, and the last
    // one ran for weeks and stopped every follow-up 2 from being sent.
    // "warning" rather than "critical" — mail is still going out, just on the
    // wrong schedule.
    if (row.event === "SEQUENCE_DRIFT") {
      add({
        service: "Follow-up schedule",
        kind: "auth",
        message: row.error
          ?? "A campaign's follow-up timing in Instantly no longer matches this app.",
        severity: "warning",
      });
      continue;
    }

    // Severity is derived from which event actually fired, not re-guessed
    // from env vars — with 6 possible LLM tiers (Settings > Keys), a fixed
    // "is OPENAI_API_KEY set" check can no longer tell whether a fallback is
    // actually covering the gap. scrape-orgs/route.ts already did that work
    // and logged the outcome; this just surfaces it.
    //
    // Both branches below share the SAME `service` value ("LLM providers")
    // deliberately — confirmed live that using two different names let a
    // stale critical SKIPPED_LOW_CREDITS row (from before a fallback was
    // configured) coexist in the response alongside a much more recent
    // warning row saying the fallback is actively covering it. Sharing one
    // key means the newest-first row ordering's dedup-by-service correctly
    // lets the most recent event win.
    if (row.event === "PRIMARY_LLM_LOW_CREDITS_FALLBACK_ACTIVE") {
      add({ service: "LLM API key", kind: "credits", severity: "warning", message: row.error ?? "" });
    } else if (row.event === "SKIPPED_LOW_CREDITS" && (err.includes("no usable llm provider") || err.includes("openrouter") || err.includes("credit"))) {
      add({
        service: "LLM API key",
        kind: "credits",
        severity: "critical",
        message: "No configured LLM provider can generate company profiles right now — add or top up a key in Settings > Keys.",
      });
    } else if (row.event === "DRAFT_LLM_UNAVAILABLE") {
      // Drafts have their own branch because the two rules above are worded for
      // company profiles, and because an OpenRouter 402 carries neither the
      // word "openai" nor a code the next rule matches — so a drafts outage on
      // that key alone would have shown nothing at all.
      // Worded for BOTH audiences on purpose: this banner is not gated by role
      // (dashboard, leads, campaigns list and campaign detail all render it),
      // and an employee cannot open Settings > Keys — telling them to go there
      // would be the only instruction they are unable to follow.
      // The reason matters. This branch used to say "Out of credits" whatever
      // had actually gone wrong, so a key returning 401 Missing Authentication
      // sent someone to top up an account that had money in it. Seen live
      // 28 Aug 2026 on a freshly added OpenRouter key.
      const why = classifyFallback(row.error);
      add({
        service: "LLM API key",
        kind: why.code === "bad_key" ? "auth" : "credits",
        severity: "critical",
        message: why.code === "bad_key"
          ? "The AI provider is rejecting the API key, so email drafts are paused. A manager needs to check or replace it in Settings > Keys — this is not a billing problem."
          : why.code === "service_busy"
            ? "The AI provider is temporarily unavailable, so email drafts are paused. This usually clears on its own; drafting resumes automatically."
            : "Out of credits — email drafts are paused and no new ones will be generated. A manager needs to top up or replace the key in Settings > Keys.",
      });
    } else if (row.source === "llm" && err.includes("openai") && (err.includes("401") || err.includes("403") || err.includes("insufficient_quota") || err.includes("429"))) {
      add({ service: "OpenAI", kind: "credits", severity: "critical", message: "OpenAI is rejecting requests — check its API key / billing." });
    }
    // The Firecrawl low-credit skip message ("Firecrawl is out of credits (N
    // left)") has neither "402" nor "insufficient" in it — match "credit" too.
    if (row.source === "firecrawl" && (err.includes("402") || err.includes("insufficient") || err.includes("credit"))) {
      add({ service: "Firecrawl", kind: "credits", severity: "critical", message: "Firecrawl is out of credits — company websites can't be read. Top up or update the Firecrawl API key." });
    }
    // Apollo email-reveal (people/bulk_match) returns 422 "insufficient credits"
    // on most plans and 402 on others — enrich logs CREDITS_EXHAUSTED for both.
    // Without this branch the leads page just showed New forever with no banner.
    if (row.event === "CREDITS_EXHAUSTED" || (row.source === "apollo" && (err.includes("insufficient credits") || err.includes("credits exhausted")))) {
      add({
        service: "Apollo",
        kind: "credits",
        severity: "critical",
        message: "Apollo is out of lead credits — imported contacts can't get emails revealed. Top up credits or update the Apollo key in Settings > Keys.",
      });
    } else if (row.source === "apollo" && (err.includes("401") || err.includes("403"))) {
      add({ service: "Apollo", kind: "auth", severity: "critical", message: "Apollo rejected the API key — lead emails can't be revealed. Update the Apollo master key." });
    }
  }

  return ok({ issues });
}

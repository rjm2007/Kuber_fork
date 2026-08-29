import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithRetry, sleep } from "@/lib/http";
import { createScopedClient } from "@/lib/supabase/scoped";
import { getActiveKey, markKeyFailed, markKeySucceeded } from "@/lib/services/provider-keys";

const BASE = "https://api.firecrawl.dev/v2";

export interface FirecrawlResult {
  success: boolean;
  data?: {
    markdown: string;
    metadata?: {
      statusCode?: number;
      description?: string;
      ogDescription?: string;
      creditsUsed?: number;
    };
  };
  error?: string;
}

// db is optional so every existing call site (scrapePage(url)) keeps working
// unchanged — pass it when the caller already has one in scope so rotation
// state (markKeyFailed/Succeeded) is written through the same client.
/**
 * Scrape one page using THIS company's Firecrawl key.
 *
 * `companyId` is required for the same reason it is on complete(): the old
 * optional-`db` form defaulted to the admin client, so key selection returned
 * every company's Firecrawl keys and used whichever sorted first. Measured on
 * 2026-08-29, the client's scraping was running on dev's key. Firecrawl credits
 * are bought per account, so this was spending the wrong company's money.
 */
export async function scrapePage(url: string, companyId: string): Promise<FirecrawlResult> {
  const client = createScopedClient(companyId);
  const tried = new Set<string>();

  for (;;) {
    const resolved = await getActiveKey(client, "firecrawl", companyId, { exclude: tried });
    if (!resolved) return { success: false, error: "No usable Firecrawl key configured" };

    const res = await fetchWithRetry("firecrawl", `${BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.secret}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });

    if (res.ok) {
      if (resolved.keyId) await markKeySucceeded(client, resolved.keyId);
      return res.json();
    }

    // Non-key-attributable failures (site itself is down/slow/blocked) —
    // rotating to a different Firecrawl key won't fix a target site's own
    // problem, so surface immediately rather than burning through the pool.
    if (![401, 402, 403, 429].includes(res.status)) {
      return { success: false, error: `HTTP ${res.status}` };
    }

    if (!resolved.keyId) return { success: false, error: `HTTP ${res.status}` }; // env-sourced — nothing left to rotate to
    await markKeyFailed(client, resolved.keyId, { status: res.status, message: `HTTP ${res.status}` });
    tried.add(resolved.keyId);
  }
}

export interface ScrapeOrgResult {
  markdown: string;
  metaDescription: string | null;
  creditsUsed: number;
}

export interface SearchResult {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
}

export interface FirecrawlSearchResult {
  success: boolean;
  data?: SearchResult[];
  error?: string;
}

/** Search the web via Firecrawl /v2/search. Returns top results as markdown snippets. */
export async function searchWeb(query: string, limit: number, companyId: string): Promise<string> {
  try {
    const client = createScopedClient(companyId);
    const resolved = await getActiveKey(client, "firecrawl", companyId);
    if (!resolved) return "";

    const res = await fetchWithRetry("firecrawl", `${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.secret}` },
      body: JSON.stringify({ query, limit, scrapeOptions: { formats: ["markdown"] } }),
    });

    if (!res.ok) return "";

    const json: FirecrawlSearchResult = await res.json();
    if (!json.success || !json.data?.length) return "";

    return json.data
      .map((r) => {
        const parts: string[] = [];
        if (r.title) parts.push(`## ${r.title}`);
        if (r.url) parts.push(`Source: ${r.url}`);
        if (r.markdown) parts.push(r.markdown.slice(0, 1500));
        else if (r.description) parts.push(r.description);
        return parts.join("\n");
      })
      .join("\n\n---\n\n");
  } catch {
    return "";
  }
}

/** Scrape homepage + /about, concat with separator. Returns null on total failure. */
export async function scrapeOrg(domain: string, companyId: string): Promise<ScrapeOrgResult | null> {
  const homeUrl = `https://${domain}`;
  const aboutUrl = `https://${domain}/about`;

  const homeResult = await scrapePage(homeUrl, companyId);

  if (
    !homeResult.success ||
    !homeResult.data?.markdown ||
    (homeResult.data?.metadata?.statusCode ?? 200) >= 400
  ) {
    return null;
  }

  let markdown = homeResult.data.markdown;
  const credits = homeResult.data.metadata?.creditsUsed ?? 1;
  const metaDescription =
    homeResult.data.metadata?.description ??
    homeResult.data.metadata?.ogDescription ??
    null;

  await sleep(300);

  const aboutResult = await scrapePage(aboutUrl, companyId);
  if (
    aboutResult.success &&
    aboutResult.data?.markdown &&
    (aboutResult.data?.metadata?.statusCode ?? 200) < 400
  ) {
    markdown += "\n\n---\n\n" + aboutResult.data.markdown;
  }

  return { markdown, metaDescription, creditsUsed: credits };
}

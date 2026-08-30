/**
 * Per-user request limits.
 *
 * The point here is NOT to stop attackers — every route is behind a login, so
 * the realistic threat is a bug, not a person. A stuck poll, a double-fired
 * button, a retry loop in the browser: any of those can call a money-spending
 * route thousands of times overnight and it looks exactly like the app working.
 * Drafting costs roughly Rs 1.50 per email, so an unbounded loop is an
 * unbounded bill.
 *
 * WHAT IS DELIBERATELY EXEMPT
 *
 * Nothing internal is limited, and that is not an oversight — it is the whole
 * design. Every cron job and every self-chain authenticates with
 * INTERNAL_SECRET (or the service-role bearer) and therefore never reaches
 * requireAuth, where this is enforced. That matters because 20 routes self-chain:
 * drafting a 100-lead campaign is a sequence of internal calls, and limiting
 * those would stop a campaign half-written with no error anyone would see.
 *
 * The limits below are sized against real behaviour, not guessed:
 *   - the UI polls progress every 3 seconds = 20 requests/min from ONE poller,
 *     so the read budget has to clear that several times over
 *   - bulk actions (certify all, regenerate all) are ONE request carrying many
 *     ids, not one request per lead, so they cost a single unit
 *
 * KNOWN LIMITATION, stated plainly: this counts in the memory of one serverless
 * instance. Vercel runs several, so a user spread across instances gets a higher
 * effective limit than the number below. It still does the job it exists for —
 * a runaway loop hammers one warm instance and is caught there — but it is not
 * a security control, and it should not be described as one. A shared counter
 * (Upstash/Redis) is the upgrade when this needs to be exact.
 */

export type RateLimitTier = "read" | "write" | "spend";

/** Requests allowed per minute, per user, per tier. */
const LIMITS: Record<RateLimitTier, number> = {
  // Comfortably above the 3-second progress poller (20/min) plus every other
  // panel a busy screen might refresh at the same time.
  read: 300,
  // Ordinary edits: saving a draft, a comment, a setting.
  write: 120,
  // Routes that cost real money on every call. Bulk actions are one request, so
  // this is per CLICK, not per lead — 20 deliberate money-spending clicks in a
  // minute is already far beyond normal use.
  spend: 20,
};

const WINDOW_MS = 60_000;

/**
 * Paths whose every call spends money at a provider. Matched as substrings of
 * the pathname, so the dynamic [id] segments do not need enumerating.
 */
const SPEND_PATHS = [
  "/generate-drafts",
  "/regenerate-drafts",
  "/regenerate",
  "/followup-regenerate",
  "/followup-step-regenerate",
  "/leads/enrich",
  "/apollo-search",
  "/company-search",
  "/company-people",
  "/company-import",
  "/rescrape",
  "/reply-drafts/generate",
];

export function tierFor(pathname: string, method: string): RateLimitTier {
  if (SPEND_PATHS.some((p) => pathname.includes(p))) return "spend";
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/** timestamps of recent requests, per key. Trimmed on read, so it cannot grow
 *  without bound for a user who stops calling. */
const hits = new Map<string, number[]>();

/**
 * Stops the map growing forever on a long-lived instance. Runs at most once a
 * minute and only touches keys that are already stale.
 */
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1] < now - WINDOW_MS) hits.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Records one request and says whether it is allowed.
 *
 * Fails OPEN by construction: there is no I/O here that can throw, and if this
 * ever gains any, it must keep that property. Refusing real work because the
 * limiter itself broke would be a worse outcome than the loop it guards against.
 */
export function checkRateLimit(userId: string, tier: RateLimitTier): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const limit = LIMITS[tier];
  const key = `${userId}:${tier}`;
  const cutoff = now - WINDOW_MS;

  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    const oldest = recent[0];
    hits.set(key, recent);
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  recent.push(now);
  hits.set(key, recent);
  return { allowed: true, limit, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

/** Test seam — the counters live in module memory, so a test needs a way to
 *  start clean. Not called by application code. */
export function __resetRateLimits() {
  hits.clear();
  lastSweep = 0;
}

import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";

/** Lightweight sidebar readout — remaining / plan limit for the active Apollo key. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  let check = await checkApolloCredits(db, "any" /* one shared Apollo account */);
  // Older cache entries predate `limit` — one fresh read fills it in.
  if (check.remaining != null && check.limit == null) {
    check = await checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: true });
  }
  return ok({
    remaining: check.remaining,
    limit: check.limit ?? null,
  });
}

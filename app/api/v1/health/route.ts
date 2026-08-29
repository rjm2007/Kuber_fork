import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { getActiveKey } from "@/lib/services/provider-keys";

export async function GET(_req: NextRequest) {
  const db = createAdminClient();

  let dbStatus = "ok";
  try {
    const { error } = await db.from("organizations").select("id").limit(1);
    if (error) dbStatus = error.message;
  } catch (e) {
    dbStatus = String(e);
  }

  // Provider keys resolve DB-first (Settings > Keys) with .env as the fallback
  // tier, so report what getActiveKey() would actually return — reading
  // process.env alone showed every provider as missing on deployments that
  // configure keys through the UI.
  const [apollo, firecrawl, openrouter, openai] = await Promise.all(
    (["apollo", "firecrawl", "openrouter", "openai"] as const).map((p) =>
      // "any": this is an unauthenticated liveness probe asking whether the
      // deployment has any usable key at all, not whose key it is.
      getActiveKey(db, p, "any").then((k) => !!k).catch(() => false),
    ),
  );

  const env = {
    apollo,
    firecrawl,
    openrouter,
    openai,
    // Genuinely env-only — these have no Settings > Keys equivalent.
    supabase_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabase_jwt_secret: !!process.env.SUPABASE_JWT_SECRET,
  };

  if (dbStatus !== "ok") {
    return fail(503, "DB_ERROR", dbStatus);
  }

  return ok({ status: "ok", db: dbStatus, env });
}

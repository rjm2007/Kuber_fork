import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { getUniboxScope } from "@/lib/auth/scope";
import { getUnreadCount } from "@/lib/services/unibox";
import { dbForUser } from "@/lib/supabase/scoped";

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const scope = getUniboxScope(user) ?? undefined;
  const count = await getUnreadCount(db, scope);
  return ok({ unread: count });
}

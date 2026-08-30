import { NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth/verify-jwt";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AppRole } from "@/lib/auth/roles";
import { SERVICE_ROLE_USER_ID } from "@/lib/constants";
import { checkRateLimit, tierFor } from "@/lib/auth/rate-limit";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * `companyId` is the tenant every query must be scoped to (see
 * lib/supabase/scoped.ts). It is null only for the service-role bearer used by
 * internal server-to-server calls, which legitimately operate across companies
 * and carry company_id explicitly from the rows they process.
 */
export type AuthedUser = {
  id: string;
  email?: string;
  role: AppRole;
  isSuperAdmin: boolean;
  companyId: string | null;
};

function unauthorized(message: string) {
  return Response.json(
    { success: false, data: null, error: { code: "UNAUTHORIZED", message } },
    { status: 401 },
  );
}

function tooManyRequests(retryAfterSeconds: number, limit: number) {
  return Response.json(
    {
      success: false,
      data: null,
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests — the limit is ${limit} per minute. Try again in ${retryAfterSeconds}s.`,
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function forbidden(message: string) {
  return Response.json(
    { success: false, data: null, error: { code: "FORBIDDEN", message } },
    { status: 403 },
  );
}

/**
 * Verifies the Bearer JWT and resolves the caller's role from `profiles` (not the JWT claim) so a
 * role change takes effect immediately, without waiting on token refresh. Returns the user or throws a Response.
 */
export async function requireAuth(request: NextRequest): Promise<AuthedUser> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    throw unauthorized("Missing Authorization header");
  }

  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    return { id: SERVICE_ROLE_USER_ID, email: "admin@service", role: "manager", isSuperAdmin: true, companyId: null };
  }

  const verified = await verifyAccessToken(token);
  if (!verified) {
    throw unauthorized("Invalid or expired token");
  }

  // Only real user sessions are limited. The service-role bearer returned
  // above, and every cron job and self-chain authenticates with INTERNAL_SECRET
  // and so never reaches this function at all — which is exactly why drafting a
  // 100-lead campaign (a long sequence of internal calls) cannot be throttled
  // half way through. See lib/auth/rate-limit.ts.
  const url = new URL(request.url);
  const limited = checkRateLimit(verified.id, tierFor(url.pathname, request.method));
  if (!limited.allowed) {
    throw tooManyRequests(limited.retryAfterSeconds, limited.limit);
  }

  const db = createAdminClient();
  const { data: profile } = await db
    .from("profiles")
    .select("role, is_active, is_super_admin, company_id")
    .eq("id", verified.id)
    .maybeSingle();

  if (!profile || !profile.is_active) {
    throw unauthorized("Account is inactive or not provisioned");
  }

  // A provisioned profile always has a company (company_id is NOT NULL). Treat a
  // missing one as unprovisioned rather than falling through to an unscoped
  // client, which would expose every tenant's data.
  if (!profile.company_id) {
    throw unauthorized("Account is not assigned to a company");
  }

  return {
    id: verified.id,
    email: verified.email,
    role: profile.role as AppRole,
    isSuperAdmin: profile.is_super_admin,
    companyId: profile.company_id as string,
  };
}

/** Like requireAuth, but 403s unless the caller is a manager. */
export async function requireManager(request: NextRequest): Promise<AuthedUser> {
  const user = await requireAuth(request);
  if (user.role !== "manager") {
    throw forbidden("Manager access required");
  }
  return user;
}

/** Like requireManager, but 403s unless the caller is also flagged
 *  is_super_admin — for the handful of routes more sensitive than ordinary
 *  manager territory (provider API keys). Promotes the inline
 *  `caller.isSuperAdmin` check already used ad hoc in settings/users/route.ts
 *  to a reusable guard now that a whole route family needs it. */
export async function requireSuperAdmin(request: NextRequest): Promise<AuthedUser> {
  const user = await requireManager(request);
  if (!user.isSuperAdmin) {
    throw forbidden("Super admin access required");
  }
  return user;
}

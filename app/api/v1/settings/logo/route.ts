import { NextRequest } from "next/server";
import { requireAuth, requireManager } from "@/lib/auth/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 30;

const BUCKET = "campaign-attachments";
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 2 * 1024 * 1024;

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function getSignedLogoUrl(db: ReturnType<typeof createAdminClient>, path: string | null) {
  if (!path) return null;
  const { data } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
  return data?.signedUrl ?? null;
}

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data, error } = await db
    .from("settings")
    .select("key, value")
    .eq("key", "brand_logo_path")
    .maybeSingle();
  if (error) return fail(500, "INTERNAL", error.message);

  const logoPath = data?.value ?? null;
  const logoUrl = await getSignedLogoUrl(db, logoPath);
  return ok({ logo_path: logoPath, logo_url: logoUrl });
}

// The brand logo is part of Company Details, so writes are manager-only — the
// same rule PATCH /api/v1/settings enforces via KNOWLEDGE_SETTINGS_KEYS. This
// route writes `brand_logo_path` directly and would otherwise be the way around
// that check.
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return fail(400, "VALIDATION_ERROR", "No file provided");
  if (!ALLOWED.has(file.type)) return fail(400, "VALIDATION_ERROR", `Unsupported file type: ${file.type}`);
  if (file.size > MAX_BYTES) return fail(400, "VALIDATION_ERROR", "Logo exceeds 2MB limit");

  const db = dbForUser(user);
  const safeName = sanitizeFilename(file.name || "logo");
  const path = `branding/logo/${crypto.randomUUID()}-${safeName}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: true });
  if (upErr) return fail(500, "INTERNAL", upErr.message);

  const now = new Date().toISOString();
  const { error: setErr } = await db.from("settings").upsert(
    { key: "brand_logo_path", value: path, updated_at: now },
    { onConflict: "key" },
  );
  if (setErr) return fail(500, "INTERNAL", setErr.message);

  const logoUrl = await getSignedLogoUrl(db, path);
  return ok({
    logo_path: path,
    logo_url: logoUrl,
    logo_name: file.name,
    logo_mime: file.type,
    logo_size: file.size,
  });
}

export async function DELETE(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "brand_logo_path")
    .maybeSingle();
  if (error) return fail(500, "INTERNAL", error.message);

  const path = data?.value ?? null;
  if (path) {
    await db.storage.from(BUCKET).remove([path]).catch(() => {});
  }

  const now = new Date().toISOString();
  const { error: clearErr } = await db.from("settings").upsert(
    { key: "brand_logo_path", value: "", updated_at: now },
    { onConflict: "key" },
  );
  if (clearErr) return fail(500, "INTERNAL", clearErr.message);

  return ok({ cleared: true });
}


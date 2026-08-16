import type { SupabaseClient } from "@supabase/supabase-js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const e = raw.trim().toLowerCase();
    if (!e || !EMAIL_RE.test(e) || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** Persist CC/BCC addresses used on a successful reply for this user. */
export async function rememberReplyAddresses(
  db: SupabaseClient,
  userId: string,
  emails: string[],
): Promise<void> {
  const list = normalizeEmails(emails);
  if (list.length === 0) return;

  const now = new Date().toISOString();
  for (const email of list) {
    const { data: existing, error: selErr } = await db
      .from("reply_mailing_list")
      .select("id, use_count")
      .eq("user_id", userId)
      .eq("email", email)
      .maybeSingle();
    if (selErr) {
      console.error("reply_mailing_list select failed:", selErr.message);
      continue;
    }
    if (existing) {
      const { error } = await db
        .from("reply_mailing_list")
        .update({
          last_used_at: now,
          use_count: (existing.use_count ?? 1) + 1,
        })
        .eq("id", existing.id);
      if (error) console.error("reply_mailing_list update failed:", error.message);
    } else {
      const { error } = await db.from("reply_mailing_list").insert({
        user_id: userId,
        email,
        last_used_at: now,
        use_count: 1,
      });
      if (error) console.error("reply_mailing_list insert failed:", error.message);
    }
  }
}

/** Recent CC/BCC addresses for autocomplete (most recently used first). */
export async function listReplyAddresses(
  db: SupabaseClient,
  userId: string,
  opts?: { q?: string; limit?: number },
): Promise<string[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 50);
  const q = opts?.q?.trim().toLowerCase() ?? "";

  let query = db
    .from("reply_mailing_list")
    .select("email")
    .eq("user_id", userId)
    .order("last_used_at", { ascending: false })
    .limit(limit);

  if (q) query = query.ilike("email", `%${q}%`);

  const { data, error } = await query;
  if (error) {
    console.error("reply_mailing_list list failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => r.email as string).filter(Boolean);
}

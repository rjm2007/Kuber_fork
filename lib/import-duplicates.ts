/** `name` is only ever set for members with leads:all (see withOwnerNames). */
export type OwnerCount = { assigned_to: string | null; count: number; name?: string };

/**
 * Who owns an already-existing lead is other people's data, so a member
 * without leads:all gets owners collapsed to "self" / "other" / null
 * (unassigned). The counts stay, so the import screen can still say
 * "36 assigned to another team member, contact your manager".
 */
export function hideOwners(counts: OwnerCount[], selfId: string): OwnerCount[] {
  const merged = new Map<string | null, number>();
  for (const c of counts) {
    const key = c.assigned_to === null ? null : c.assigned_to === selfId ? "self" : "other";
    merged.set(key, (merged.get(key) ?? 0) + c.count);
  }
  return [...merged].map(([assigned_to, count]) => ({ assigned_to, count }));
}

/** Managers only: attach a display name (full name, else email) to real owner ids. */
export function withOwnerNames(
  counts: OwnerCount[],
  profilesById: Map<string, { full_name?: string | null; email?: string | null }>,
): OwnerCount[] {
  return counts.map((c) => {
    const p = c.assigned_to ? profilesById.get(c.assigned_to) : undefined;
    const name = p?.full_name || p?.email || undefined;
    return name ? { ...c, name } : c;
  });
}

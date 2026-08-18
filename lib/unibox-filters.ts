/**
 * Unibox filter predicates.
 *
 * Pure and separate from lib/services/unibox.ts on purpose: these decide which
 * conversations a user can see, and the previous versions lived as private
 * functions inside a module that cannot be imported without a database, so they
 * were never once executed in a test. That is how "Needs reply" came to hide a
 * thread whose prospect had been waiting three days — the rule was wrong in a
 * place nothing could check it.
 *
 * Every predicate here has a case in unibox-filters.test.ts. Add a rule, add a
 * case.
 */

export type UniboxTab = "primary" | "others";
export type UniboxReadState = "unread" | "read" | "replied" | "needs_reply" | "no_reply";

/** The only thread facts any filter is allowed to read. */
export type ThreadFilterState = {
  unread_count: number;
  /** Someone other than us has written at least once. */
  has_reply: boolean;
  /** Someone asked something we have not answered THEM (see unansweredInbound). */
  needs_reply: boolean;
};

/**
 * Instantly's Primary/Others split, mirrored. Others collects auto-replies and
 * anything Instantly could not attribute to a lead — note this is per MESSAGE,
 * so a thread appears under a tab if any of its messages match.
 */
export function matchesTab(
  tab: UniboxTab,
  row: { is_focused: boolean; is_auto_reply: boolean },
): boolean {
  if (tab === "primary") return row.is_focused && !row.is_auto_reply;
  return !row.is_focused || row.is_auto_reply;
}

/**
 * The Conversations filter.
 *
 * "Replied" and "Needs reply" used to test whether the newest message was
 * outbound, which silently assumed two parties: the moment ANY reply went out
 * the newest message was ours, so a thread where we answered a CC'd colleague
 * but never the prospect counted as replied and dropped out of the queue.
 * Both now read `needs_reply`, which is computed per person.
 *
 * The two pairs are exact complements over their own axis — unread/read on
 * unread_count, and needs_reply/replied over threads that have a reply — so no
 * conversation can fall through every filter and become unreachable.
 */
export function matchesReadState(state: UniboxReadState, t: ThreadFilterState): boolean {
  switch (state) {
    case "unread":      return t.unread_count > 0;
    case "read":        return t.unread_count === 0;
    // Answered everyone who wrote in. A campaign thread nobody ever answered is
    // "no reply yet", not "replied", even though its last message is outbound too.
    case "replied":     return t.has_reply && !t.needs_reply;
    case "needs_reply": return t.needs_reply;
    case "no_reply":    return !t.has_reply;
    default:            return true;
  }
}

/** Instantly's own AI interest value. "lead" means it has not classified them. */
export function matchesInterestFilter(
  filter: number | "lead",
  interestStatus: number | null,
): boolean {
  if (filter === "lead") return interestStatus === null;
  return interestStatus === filter;
}

/** Campaign scope. `campaign_ids` wins over the single `campaign_id`. */
export function campaignMatches(
  rowCampaignId: string | null | undefined,
  filters: { campaign_id?: string; campaign_ids?: string[] },
): boolean {
  if (filters.campaign_ids && filters.campaign_ids.length > 0) {
    return !!rowCampaignId && filters.campaign_ids.includes(rowCampaignId);
  }
  if (filters.campaign_id) return rowCampaignId === filters.campaign_id;
  return true;
}

/**
 * Who is actually in a Unibox thread.
 *
 * A thread is not "us and the lead". Anyone the lead CC'd — or anyone we CC'd —
 * can reply, and Instantly files their message into the same thread under the
 * lead's key. Confirmed live: a reply from an address that is not a lead in any
 * campaign was ingested into the lead's thread with the lead's campaign_lead_id.
 *
 * Everything here exists because the UI used to assume a single counterparty. It
 * labelled every inbound message with the lead's name whoever sent it, and the
 * composer always answered the newest message — so a reply meant for the lead
 * silently went to whoever spoke last, with the lead dropped off the mail
 * entirely.
 *
 * THE constraint that shapes this API: Instantly's POST /emails/reply has no To
 * field (see replyToInstantlyEmail). It derives the To from the sender of
 * `reply_to_uuid`. So "reply to person X" is only expressible as "reply to a
 * message X sent" — and someone who has only ever been CC'd, never written, can
 * be CC'd but not addressed. That is why ThreadParticipant.replyTargetId is
 * nullable and why callers must treat a null one as CC-only.
 */

export type ParticipantMessage = {
  instantly_email_id: string;
  direction: string;
  from_email: string | null;
  to_emails: string | null;
  cc_emails: string | null;
  timestamp_email: string;
};

export type ThreadParticipant = {
  email: string;
  /** This address is the campaign lead the thread is filed under. */
  isLead: boolean;
  /**
   * Instantly id of their most recent INBOUND message, or null when they have
   * never written. Only a non-null value can be used as reply_to_uuid.
   */
  replyTargetId: string | null;
  /** Timestamp of that message, for ordering. */
  latestAt: string | null;
};

const norm = (raw: string): string => raw.trim().toLowerCase();

/** `"Name <a@b.com>"` → `a@b.com`; a bare address passes through. */
function extractAddress(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  return norm(angled ? angled[1] : raw);
}

/** Split a stored `to_emails` / `cc_emails` column into normalized addresses. */
export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((part) => extractAddress(part))
    .filter(Boolean);
}

/** Inbound = written by someone else. Everything else is ours. */
export function isInbound(m: Pick<ParticipantMessage, "direction">): boolean {
  return m.direction === "received";
}

/**
 * Our own mailboxes, so they never end up CC'd on our own reply. Derived from
 * the senders of outbound messages, plus any eaccount the caller already knows
 * (a thread with no outbound message yet would otherwise have no other clue).
 */
export function ourAddresses(
  messages: ParticipantMessage[],
  known: Array<string | null | undefined> = [],
): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (!isInbound(m) && m.from_email) out.add(extractAddress(m.from_email));
  }
  for (const e of known) {
    if (e) out.add(extractAddress(e));
  }
  return out;
}

/**
 * Everyone on the thread except us, newest-speaker information folded in.
 * Ordered lead first, then people who can be replied to (most recent first),
 * then CC-only addresses alphabetically — so the UI can render the list
 * directly without re-sorting.
 */
export function threadParticipants(
  messages: ParticipantMessage[],
  opts: { ourEmails: Set<string>; leadEmail: string | null },
): ThreadParticipant[] {
  const lead = opts.leadEmail ? extractAddress(opts.leadEmail) : null;
  const byEmail = new Map<string, ThreadParticipant>();

  function touch(email: string): ThreadParticipant | null {
    if (!email || opts.ourEmails.has(email)) return null;
    let p = byEmail.get(email);
    if (!p) {
      p = { email, isLead: email === lead, replyTargetId: null, latestAt: null };
      byEmail.set(email, p);
    }
    return p;
  }

  const ordered = [...messages].sort((a, b) =>
    a.timestamp_email.localeCompare(b.timestamp_email),
  );

  for (const m of ordered) {
    for (const e of parseAddressList(m.from_email)) touch(e);
    for (const e of parseAddressList(m.to_emails)) touch(e);
    for (const e of parseAddressList(m.cc_emails)) touch(e);

    // Only an inbound message can become reply_to_uuid — replying to our own
    // sent mail would address it back to ourselves.
    if (isInbound(m) && m.from_email) {
      const p = touch(extractAddress(m.from_email));
      if (p) {
        p.replyTargetId = m.instantly_email_id;
        p.latestAt = m.timestamp_email;
      }
    }
  }

  return [...byEmail.values()].sort((a, b) => {
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    const aCan = !!a.replyTargetId;
    const bCan = !!b.replyTargetId;
    if (aCan !== bCan) return aCan ? -1 : 1;
    if (aCan && bCan) return (b.latestAt ?? "").localeCompare(a.latestAt ?? "");
    return a.email.localeCompare(b.email);
  });
}

/** The message a reply defaults to: the most recent inbound one. */
export function latestInboundMessage<T extends ParticipantMessage>(
  messages: T[],
): T | null {
  let latest: T | null = null;
  for (const m of messages) {
    if (!isInbound(m)) continue;
    if (!latest || m.timestamp_email.localeCompare(latest.timestamp_email) > 0) {
      latest = m;
    }
  }
  return latest;
}

/**
 * The reply target for ANY message in the thread, not just inbound ones —
 * lets "Reply" appear on our own sent messages too (Gmail lets you reply
 * from any point in a thread), even when the lead has never written back at
 * all. For an inbound message, that's itself. For one of our own outbound
 * messages, prefers the most recent inbound message AT OR BEFORE it — what
 * it was effectively answering — then the nearest inbound message AFTER it,
 * then, if NO inbound message exists anywhere in the thread, the outbound
 * message itself.
 *
 * Instantly's reply_to_uuid accepts any existing email id, inbound or
 * outbound (confirmed against its OpenAPI spec) — but its documented default
 * recipient is always "the sender of the email being replied to". For an
 * outbound target that sender is US, not the lead, so a caller resolving to
 * an outbound target MUST force the lead's address into additional_recipients
 * (see replyRecipients below and app/api/v1/unibox/reply/route.ts's
 * forcedTo) — Instantly will not infer it.
 */
export function replyTargetFor<T extends ParticipantMessage>(
  m: T,
  messages: T[],
): T {
  if (isInbound(m)) return m;
  let before: T | null = null;
  let after: T | null = null;
  for (const x of messages) {
    if (!isInbound(x)) continue;
    if (x.timestamp_email.localeCompare(m.timestamp_email) <= 0) {
      if (!before || x.timestamp_email.localeCompare(before.timestamp_email) > 0) before = x;
    } else if (!after || x.timestamp_email.localeCompare(after.timestamp_email) < 0) {
      after = x;
    }
  }
  return before ?? after ?? m;
}

/**
 * Inbound messages still waiting on an answer.
 *
 * "Answered" is per PERSON, not per thread. Replying to whoever spoke last does
 * not answer the question somebody else asked earlier — and the thread-level
 * test this replaces (`latest message is outbound`) called the whole
 * conversation handled the moment any reply went out, so a prospect's
 * unanswered question silently dropped out of the Needs-reply queue as soon as
 * a CC'd colleague was answered.
 *
 * A message counts as answered once we send something after it carrying its
 * sender in To or Cc.
 */
export function unansweredInbound<T extends ParticipantMessage>(
  messages: T[],
  ourEmails: Set<string>,
): T[] {
  const ordered = [...messages].sort((a, b) =>
    a.timestamp_email.localeCompare(b.timestamp_email),
  );
  const outbound = ordered.filter((m) => !isInbound(m));

  return ordered.filter((m) => {
    if (!isInbound(m)) return false;
    const sender = parseAddressList(m.from_email)[0] ?? null;
    // Our own address arriving as "inbound" (a loop-back copy) is not a question.
    if (!sender || ourEmails.has(sender)) return false;
    return !outbound.some(
      (o) =>
        o.timestamp_email.localeCompare(m.timestamp_email) > 0 &&
        [...parseAddressList(o.to_emails), ...parseAddressList(o.cc_emails)].includes(sender),
    );
  });
}

/**
 * Who receives a reply aimed at `target`.
 *
 * `to` is not a choice for an INBOUND target — Instantly forces it to the
 * target's sender, so this reports what WILL happen rather than what we
 * asked for. For an OUTBOUND target (one of our own messages, only reachable
 * when the lead has never written back at all — see replyTargetFor),
 * Instantly's forced default recipient would be US, so `to` is set to the
 * lead's own address instead; the caller sends it through
 * additional_recipients, which Instantly always delivers to regardless of
 * the default. Everyone else on the thread lands in `cc`, which makes
 * reply-all the default: over-including is noise, under-including drops a
 * prospect out of their own conversation without telling anyone.
 */
export function replyRecipients(
  target: Pick<ParticipantMessage, "from_email" | "direction"> | null,
  participants: ThreadParticipant[],
  leadEmail: string | null,
): { to: string[]; cc: string[] } {
  const to = !target
    ? []
    : isInbound(target)
      ? (target.from_email ? [extractAddress(target.from_email)] : [])
      : (leadEmail ? [extractAddress(leadEmail)] : []);
  const addressed = new Set(to);
  return { to, cc: participants.filter((p) => !addressed.has(p.email)).map((p) => p.email) };
}

/**
 * Self-check for thread participant/recipient resolution — the logic that
 * decides who actually receives a reply. Run with:
 *   npx tsx lib/thread-participants.test.ts
 *
 * The fixture is the real thread ff-9QPh9_MdMeq4C8IC_flG5VF, which is what
 * exposed the bug: the lead CC'd a second address, that address replied, and
 * the app then sent our answer to the CC'd address ALONE — dropping the lead.
 */
import { strict as assert } from "assert";
import {
  latestInboundMessage,
  ourAddresses,
  parseAddressList,
  replyRecipients,
  threadParticipants,
  unansweredInbound,
} from "./thread-participants";

const US = "pushkar.garg@kuberpolyplast.com";
const LEAD = "rudraksh.mehta@djsce.edu.in";
const CCD = "rjmehta05081007@gmail.com";

const messages = [
  { instantly_email_id: "m1", direction: "sent_campaign", from_email: US,   to_emails: LEAD, cc_emails: null, timestamp_email: "2026-08-16T16:22:38Z" },
  { instantly_email_id: "m2", direction: "received",      from_email: LEAD, to_emails: US,   cc_emails: CCD,  timestamp_email: "2026-08-16T16:44:40Z" },
  { instantly_email_id: "m3", direction: "received",      from_email: CCD,  to_emails: LEAD, cc_emails: US,   timestamp_email: "2026-08-16T16:46:14Z" },
];

// ─── Address parsing ─────────────────────────────────────────────────────────
assert.deepEqual(parseAddressList("a@b.com,c@d.com"), ["a@b.com", "c@d.com"]);
// Real headers arrive with display names and stray casing/whitespace.
assert.deepEqual(parseAddressList('Raghav Mehta <Raghav@B.com>; c@d.com '), ["raghav@b.com", "c@d.com"]);
assert.deepEqual(parseAddressList(null), []);

// ─── Our own mailbox never CCs itself ────────────────────────────────────────
const ours = ourAddresses(messages, [US]);
assert.equal(ours.has(US), true);
assert.equal(ours.has(LEAD), false);

const participants = threadParticipants(messages, { ourEmails: ours, leadEmail: LEAD });

// Both counterparties are found; we are not one of them.
assert.deepEqual(participants.map((p) => p.email), [LEAD, CCD]);
assert.equal(participants.every((p) => p.email !== US), true);

// The lead sorts first even though the CC'd address spoke more recently.
assert.equal(participants[0].isLead, true);
assert.equal(participants[1].isLead, false);

// Both wrote, so both are addressable, each pointing at their own newest message.
assert.equal(participants[0].replyTargetId, "m2");
assert.equal(participants[1].replyTargetId, "m3");

// ─── THE regression: replying must not drop the lead ─────────────────────────
const newest = latestInboundMessage(messages);
assert.equal(newest?.instantly_email_id, "m3");

const toNewest = replyRecipients(newest, participants);
assert.deepEqual(toNewest.to, [CCD]);
// The lead stays on the mail instead of silently falling out of the thread.
assert.deepEqual(toNewest.cc, [LEAD]);

// ─── Targeting the lead specifically (the "answer the price question" case) ──
const leadMsg = messages.find((m) => m.instantly_email_id === "m2")!;
const toLead = replyRecipients(leadMsg, participants);
assert.deepEqual(toLead.to, [LEAD]);
assert.deepEqual(toLead.cc, [CCD]);

// ─── CC-only participant: addressable false, still receives the mail ─────────
const silent = "boss@corp.com";
const withSilent = [
  ...messages,
  { instantly_email_id: "m4", direction: "received", from_email: LEAD, to_emails: US, cc_emails: `${CCD},${silent}`, timestamp_email: "2026-08-16T17:00:00Z" },
];
const p2 = threadParticipants(withSilent, { ourEmails: ours, leadEmail: LEAD });
const boss = p2.find((p) => p.email === silent)!;
// Never wrote → cannot be a To (Instantly has no To field), but must be CC'd.
assert.equal(boss.replyTargetId, null);
assert.equal(replyRecipients(latestInboundMessage(withSilent), p2).cc.includes(silent), true);

// A thread nobody has answered has no reply target at all.
assert.equal(latestInboundMessage([messages[0]]), null);
assert.deepEqual(replyRecipients(null, participants), { to: [], cc: [LEAD, CCD] });

// ─── Reply-all composition ───────────────────────────────────────────────────
// Instantly has no To field, but `additional_recipients` puts extra addresses
// in To alongside the forced one. So reply-all is to+cc merged into To, with CC
// left empty — not "one in To, the rest in CC".
const replyAllTo = [...toLead.to, ...toLead.cc];
assert.deepEqual(replyAllTo, [LEAD, CCD]);
// The forced address is always first, and it is the one the UI locks.
assert.equal(replyAllTo[0], toLead.to[0]);
// Everything after it is what the route sends as additional_recipients.
assert.deepEqual(replyAllTo.filter((e) => e !== toLead.to[0]), [CCD]);

// ─── Needs-reply is per person, not per thread ───────────────────────────────
// Both wrote and we have answered nobody.
assert.deepEqual(
  unansweredInbound(messages, ours).map((m) => m.instantly_email_id),
  ["m2", "m3"],
);

// THE filter regression: we answer only the CC'd address. The thread's newest
// message is now outbound, which the old thread-level test read as "handled" —
// but the lead's question has never been answered and must stay in the queue.
const repliedToCcdOnly = [
  ...messages,
  { instantly_email_id: "m5", direction: "sent_manual", from_email: US, to_emails: CCD, cc_emails: "", timestamp_email: "2026-08-16T16:49:01Z" },
];
assert.deepEqual(
  unansweredInbound(repliedToCcdOnly, ours).map((m) => m.instantly_email_id),
  ["m2"],
);

// Reply-all answers everyone at once, so nothing is left outstanding.
const repliedAll = [
  ...messages,
  { instantly_email_id: "m6", direction: "sent_manual", from_email: US, to_emails: CCD, cc_emails: LEAD, timestamp_email: "2026-08-16T16:49:01Z" },
];
assert.deepEqual(unansweredInbound(repliedAll, ours), []);

// An answer only counts if it comes AFTER the question.
const answeredThenAsked = [
  { instantly_email_id: "m7", direction: "sent_manual", from_email: US,   to_emails: LEAD, cc_emails: "", timestamp_email: "2026-08-16T16:00:00Z" },
  { instantly_email_id: "m8", direction: "received",    from_email: LEAD, to_emails: US,   cc_emails: "", timestamp_email: "2026-08-16T16:30:00Z" },
];
assert.deepEqual(
  unansweredInbound(answeredThenAsked, ours).map((m) => m.instantly_email_id),
  ["m8"],
);

// Plain two-party threads must behave exactly as before.
assert.deepEqual(unansweredInbound([messages[0]], ours), []);

console.log("thread-participants: all recipient checks passed");

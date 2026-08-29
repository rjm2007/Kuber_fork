/**
 * Anthropic removed temperature/top_p/top_k from the Claude 5 generation and
 * from Opus 4.7/4.8. Sending one is a hard 400, not a warning.
 *
 * This file sends `temperature` on every call, so without this split two of the
 * three models Settings > Keys offered — including the default, claude-sonnet-5
 * — would have failed on every single request the moment the client's Claude
 * key went in. Nothing would have drafted.
 *
 * Mirrors anthropicRejectsTemperature() in lib/services/providers/registry.ts.
 *
 *   node scripts/check-anthropic-sampling.mjs
 */
import assert from "node:assert/strict";

const ANTHROPIC_NO_SAMPLING = [
  "claude-fable-5", "claude-mythos-5",
  "claude-opus-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7",
];

const rejects = (model) => {
  const m = model.trim().toLowerCase();
  return ANTHROPIC_NO_SAMPLING.some((p) => m.startsWith(p));
};

// ── The models that must NOT be sent a temperature ───────────────────────────
for (const m of [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "claude-mythos-5",
]) {
  assert.equal(rejects(m), true, `${m} must not be sent temperature`);
}

// ── The models that still take one, so our 0.2 / 0.8 tuning survives ─────────
for (const m of [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-3-5-haiku-20241022",
]) {
  assert.equal(rejects(m), false, `${m} still accepts temperature`);
}

// ── Dated snapshots resolve the same as their base id ────────────────────────
// Prefix matching, so a pinned snapshot cannot silently fall into the wrong
// branch and start 400ing in production.
assert.equal(rejects("claude-sonnet-5-20260101"), true);
assert.equal(rejects("claude-opus-5-20260320"), true);
assert.equal(rejects("claude-haiku-4-5-20251001"), false);

// ── Whitespace and case, since these come from a settings field ──────────────
assert.equal(rejects("  claude-sonnet-5  "), true);
assert.equal(rejects("Claude-Sonnet-5"), true);

// ── The near-miss that makes prefix matching safe ────────────────────────────
// "claude-sonnet-4-6" must not match the "claude-sonnet-5" prefix, and
// "claude-opus-4-6" must not match "claude-opus-4-7"/"4-8". Getting this wrong
// in either direction is a 400 on every request, or a silently ignored
// temperature.
assert.equal(rejects("claude-sonnet-4-6"), false);
assert.equal(rejects("claude-opus-4-6"), false);

// ── Unknown models keep temperature ──────────────────────────────────────────
// Safe default: every model that existed before this rule accepts it, and a
// wrong guess here breaks a provider that was working.
assert.equal(rejects("claude-some-future-thing"), false);
assert.equal(rejects(""), false);

console.log("ok — Claude models that reject temperature are excluded from it");

// npx tsx --test lib/services/generate-drafts.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTrailingSignOff, earlierEmailsBlock } from "./generate-drafts.ts";

test("drops a closing the model wrote itself (issue 9)", () => {
  const q = "Dear Mayank,\n\nWould it be worth a quick chat?";
  assert.equal(stripTrailingSignOff(`${q}\n\nBest,`), q); // the 216-draft case
  assert.equal(stripTrailingSignOff(`${q}\n\nKind regards,`), q);
  assert.equal(stripTrailingSignOff(`${q}\n\nBest regards`), q);
  assert.equal(stripTrailingSignOff(`${q}\nThanks!`), q);
});

test("leaves real sentences alone", () => {
  const s = "Dear Heena,\n\nWe make the best white masterbatch for film.";
  assert.equal(stripTrailingSignOff(s), s);
  assert.equal(stripTrailingSignOff("Dear A,\n\nIs it the best fit?"), "Dear A,\n\nIs it the best fit?");
});

test("earlier emails are labelled in order and capped (issue 8)", () => {
  assert.equal(earlierEmailsBlock([]), "");
  const block = earlierEmailsBlock([{ step: 1, body: "Opening" }, { step: 2, body: "x".repeat(5000) }]);
  assert.match(block, /--- Opening email ---\nOpening/);
  assert.match(block, /--- Follow-up 1 ---/);
  assert.ok(block.length < 2500, "a long email is capped");
});

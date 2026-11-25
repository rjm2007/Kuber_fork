import { test } from "node:test";
import assert from "node:assert/strict";
import { hideOwners, withOwnerNames } from "./import-duplicates.ts";

test("other members collapse to 'other', own and unassigned stay distinct", () => {
  const out = hideOwners([
    { assigned_to: "ankit", count: 30 },
    { assigned_to: "ruby", count: 6 },
    { assigned_to: null, count: 2 },
    { assigned_to: "me", count: 1 },
  ], "me");
  assert.deepEqual(out, [
    { assigned_to: "other", count: 36 },
    { assigned_to: null, count: 2 },
    { assigned_to: "self", count: 1 },
  ]);
});

test("no real owner id leaks", () => {
  const out = hideOwners([{ assigned_to: "ankit", count: 5 }], "me");
  assert.ok(out.every((o) => o.assigned_to === null || o.assigned_to === "self" || o.assigned_to === "other"));
});

test("hideOwners never emits a name, even if the input carried one", () => {
  const out = hideOwners([{ assigned_to: "ankit", count: 5, name: "Ankit Sharma" }, { assigned_to: "me", count: 1, name: "Me" }], "me");
  assert.ok(!JSON.stringify(out).includes("Ankit"));
  assert.ok(out.every((o) => !("name" in o)));
});

test("withOwnerNames: full name, else email, unassigned stays nameless", () => {
  const prof = new Map([["a", { full_name: "Ankit", email: "a@x.com" }], ["b", { full_name: null, email: "b@x.com" }]]);
  assert.deepEqual(withOwnerNames([{ assigned_to: "a", count: 1 }, { assigned_to: "b", count: 2 }, { assigned_to: null, count: 3 }, { assigned_to: "zz", count: 4 }], prof), [
    { assigned_to: "a", count: 1, name: "Ankit" }, { assigned_to: "b", count: 2, name: "b@x.com" },
    { assigned_to: null, count: 3 }, { assigned_to: "zz", count: 4 },
  ]);
});

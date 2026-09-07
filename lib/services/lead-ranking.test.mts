import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTitle, titleTier, pickBestContact, orgKey } from "./lead-ranking.ts";

test("buying function outranks org-chart height", () => {
  // The whole premise: a purchase manager buys masterbatch, a CEO does not.
  assert.ok(scoreTitle("Purchase Manager") > scoreTitle("Chief Executive Officer"));
  assert.ok(scoreTitle("Head of Procurement") > scoreTitle("General Manager"));
  assert.ok(scoreTitle("Sourcing Manager") > scoreTitle("Director"));
});

test("owner-operators beat generic leadership but not procurement", () => {
  assert.ok(scoreTitle("Proprietor") > scoreTitle("Operations Director"));
  assert.ok(scoreTitle("Managing Director") > scoreTitle("CEO"));
  assert.ok(scoreTitle("Purchase Manager") > scoreTitle("Managing Director"));
});

test("technical gatekeepers sit above generic leadership", () => {
  assert.ok(scoreTitle("Production Manager") > scoreTitle("Vice President"));
  assert.ok(scoreTitle("Plant Head") > scoreTitle("Director"));
});

test("sales and marketing are never picked", () => {
  for (const t of ["Sales Manager", "Director - Sales & Marketing", "VP Business Development", "HR Manager"]) {
    assert.ok(scoreTitle(t) < 0, `${t} should be disqualified`);
  }
  // A seller is a seller even when the title also says procurement.
  assert.ok(scoreTitle("Sales & Procurement Manager") < scoreTitle("Procurement Manager"));
});

test("seniority breaks ties inside a tier", () => {
  assert.ok(scoreTitle("Head of Purchasing") > scoreTitle("Purchase Manager"));
  assert.ok(scoreTitle("Purchase Manager") > scoreTitle("Purchase Assistant"));
});

test("an unknown title still beats nothing and still loses to a real buyer", () => {
  assert.equal(scoreTitle(""), 0);
  assert.equal(scoreTitle(null), 0);
  assert.ok(scoreTitle("Consultant") > scoreTitle(""));
  assert.ok(scoreTitle("Purchase Officer") > scoreTitle("Consultant"));
});

test("pickBestContact takes the buyer out of a real Apollo page", () => {
  // Titles as they came back from the live free search on 2026-09-07.
  const people = [
    { id: "a", title: "CEO" },
    { id: "b", title: "General Manager" },
    { id: "c", title: "Supply Chain Manager" },
    { id: "d", title: "Head of Procurement" },
    { id: "e", title: "Sales Manager" },
  ];
  assert.equal(pickBestContact(people)?.id, "d");
  assert.equal(pickBestContact([])?.id, undefined);
  // Deterministic: first of an equal pair wins, never a random one.
  assert.equal(pickBestContact([{ id: "x", title: "Purchase Manager" }, { id: "y", title: "Purchase Manager" }])?.id, "x");
});

test("titleTier explains the pick", () => {
  assert.equal(titleTier("Head of Procurement"), "procurement");
  assert.equal(titleTier("Proprietor"), "owner");
  assert.equal(titleTier("Sales Manager"), "disqualified");
});

test("orgKey merges legal-form spellings of one company", () => {
  assert.equal(orgKey("Acme Plastics Pvt. Ltd."), orgKey("Acme Plastics Private Limited"));
  assert.equal(orgKey("Windsor Machines Limited"), orgKey("Windsor Machines Ltd"));
  assert.equal(orgKey("Dallas Plastics Corporation"), orgKey("Dallas Plastics Corp"));
});

test("orgKey does NOT merge different companies that share a first word", () => {
  // The dangerous direction: a false merge blacklists a company we never mailed.
  assert.notEqual(orgKey("Reliance Industries"), orgKey("Reliance Group"));
  assert.notEqual(orgKey("Supreme Industries"), orgKey("Supreme Petrochem"));
  assert.notEqual(orgKey("Universal Packaging Company"), orgKey("Universal Films"));
});

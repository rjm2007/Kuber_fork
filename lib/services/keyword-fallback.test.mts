import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordVariants } from "./keyword-fallback.ts";

/** Every case here is a real term the client typed on 2026-09-07 that Apollo
 *  returned zero (or near-zero) for, paired with the shorter form measured to
 *  work. The variant list must contain that shorter form. */
const RESCUES: Array<[typed: string, mustOffer: string]> = [
  ["Plastic Bag Manufacturer", "plastic bags"],
  ["Poly Bag Manufacturer", "poly bags"],
  ["Garbage Bag Manufacturer", "garbage bags"],
  ["Shopping Bag Manufacturer", "shopping bags"],
  ["Plastic HDPE pipes", "hdpe pipes"],
  ["Plastic Corrugated Pipes", "corrugated pipes"],
  ["Plastic Irrigation pipes", "irrigation pipes"],
  ["Plastic Taps", "taps"],
  ["Pipe and Extrusion", "pipe extrusion"],
  ["Plastic pipes and fittings", "pipes and fittings"],
];

for (const [typed, expected] of RESCUES) {
  test(`"${typed}" offers "${expected}"`, () => {
    const v = keywordVariants(typed);
    assert.ok(v.includes(expected), `got [${v.join(", ")}]`);
  });
}

test("never suggests the original back", () => {
  assert.ok(!keywordVariants("blown film").includes("blown film"));
});

test("never suggests a bare generic that matches half of Apollo", () => {
  for (const bad of ["plastic", "poly", "and", "the"]) {
    assert.ok(!keywordVariants("Plastic Manufacturer").includes(bad));
  }
});

test("handles empty and junk without throwing", () => {
  assert.deepEqual(keywordVariants(""), []);
  assert.deepEqual(keywordVariants("   "), []);
  assert.ok(Array.isArray(keywordVariants("!!!")));
});

test("respects the limit so a rescue stays cheap", () => {
  assert.ok(keywordVariants("Plastic Bag Manufacturer Company Products", 2).length <= 2);
});

import { pickBestVariant, MIN_USEFUL_RESULTS } from "./keyword-fallback.ts";

test("prefers the specific term over a bigger but vaguer one", () => {
  // Real numbers: "Plastic Taps" rescued to "tap" (6,445) purely on volume,
  // which also matches tap water. "plastic tap" keeps the client's intent.
  const best = pickBestVariant([
    { term: "tap", count: 6445 },
    { term: "taps", count: 3182 },
    { term: "plastic tap", count: 40 },
  ]);
  assert.equal(best?.term, "plastic tap");
});

test("falls back to volume when nothing precise is usable", () => {
  const best = pickBestVariant([
    { term: "plastic corrugated pipe", count: 1 },
    { term: "corrugated pipe", count: 203 },
  ]);
  assert.equal(best?.term, "corrugated pipe");
});

test("takes the best of a bad lot rather than nothing", () => {
  const best = pickBestVariant([{ term: "a b", count: 2 }, { term: "c", count: 9 }]);
  assert.equal(best?.term, "c");
});

test("returns null when every variant is empty", () => {
  assert.equal(pickBestVariant([{ term: "x", count: 0 }]), null);
  assert.equal(pickBestVariant([]), null);
});

test("MIN_USEFUL_RESULTS matches the smallest import a manager can request", () => {
  assert.equal(MIN_USEFUL_RESULTS, 25);
});

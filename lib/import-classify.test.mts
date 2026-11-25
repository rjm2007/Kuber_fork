import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEmailCell, classifyImport, cellString } from "./import-classify.ts";
import { IMPORT_LIMITS, type ImportChoices } from "./import-review-types.ts";

const M = { email: "E", first_name: "N", organization_name: "C" };
const r = (E: unknown, N = "", C = "") => ({ E, N, C });
const one = (s: unknown) => cleanEmailCell(s).candidates;
const sum = (p: ReturnType<typeof classifyImport>) =>
  p.noEmail + p.duplicateInFile + p.skippedByChoice + p.skippedAmbiguous + p.importRows.length;

test("cleaning: case, spaces, mailto, zero-width, nbsp, punctuation, brackets", () => {
  assert.deepEqual(one("  A@X.COM  "), ["a@x.com"]);
  assert.deepEqual(one("mailto:a@x.com"), ["a@x.com"]);
  assert.deepEqual(one("a​@x.com"), ["a@x.com"]);
  assert.deepEqual(one(" a@x.com "), ["a@x.com"]);
  assert.deepEqual(one("a@x.com."), ["a@x.com"]);
  assert.deepEqual(one("a@x.com,"), ["a@x.com"]);
  assert.deepEqual(one("John <j@x.com>"), ["j@x.com"]);
  assert.deepEqual(one("a @x .com"), ["a@x.com"]);
  assert.deepEqual(one("a@x. com"), ["a@x.com"]);
  assert.deepEqual(one("email: a@x.com. Thanks"), ["a@x.com"]);
});

test("no usable email", () => {
  for (const bad of ["", "   ", null, undefined, "John @", "name@", "@x.com", "a@b", "a@@b.com", "hello", "a@x.c", "a..b@x.com", 12345])
    assert.deepEqual(one(bad), [], String(bad));
});

test("typo dictionary: fixes known, never touches unknown", () => {
  const known: Array<[string, string]> = [
    ["gmail.con", "gmail.com"], ["gmail.cm", "gmail.com"], ["gmail.co", "gmail.com"], ["gmial.com", "gmail.com"],
    ["gmai.com", "gmail.com"], ["gamil.com", "gmail.com"], ["gmaill.com", "gmail.com"], ["gnail.com", "gmail.com"],
    ["gmail.coom", "gmail.com"], ["hotmial.com", "hotmail.com"], ["hotnail.com", "hotmail.com"],
    ["hotmail.con", "hotmail.com"], ["yaho.com", "yahoo.com"], ["yahooo.com", "yahoo.com"], ["yahoo.con", "yahoo.com"],
    ["yhoo.com", "yahoo.com"], ["outlok.com", "outlook.com"], ["outlook.con", "outlook.com"],
    ["acme.con", "acme.com"], ["acme.coom", "acme.com"], ["acme.comm", "acme.com"], ["acme.cmo", "acme.com"], ["acme.ocm", "acme.com"],
  ];
  for (const [from, to] of known) {
    const c = cleanEmailCell(`u@${from}`);
    assert.deepEqual(c.candidates, [`u@${to}`], from);
    assert.equal(c.corrected, true, from);
  }
  for (const same of ["gmal.com", "acmee.com", "acme.co", "acme.io", "gmail.com"]) {
    const c = cleanEmailCell(`u@${same}`);
    assert.deepEqual(c.candidates, [`u@${same}`]);
    assert.equal(c.corrected, false);
  }
});

test("multi-email separators + de-dupe + cap", () => {
  for (const sep of ["; ", ", ", " / ", "\n", " ", " and ", " & ", "|"])
    assert.deepEqual(one(`a@x.com${sep}b@y.com`), ["a@x.com", "b@y.com"], JSON.stringify(sep));
  assert.deepEqual(one("a@x.com; A@X.COM"), ["a@x.com"]);
  assert.equal(one(Array.from({ length: 30 }, (_, i) => `u${i}@x.com`).join(";")).length, 10);
});

test("hostile cell stays fast", () => {
  const t = Date.now();
  one("a".repeat(1_000_000));
  one("a@ .".repeat(250_000));
  one(" @".repeat(500_000));
  assert.ok(Date.now() - t < 200);
});

test("rule 1: empty rows ignored, no-email counted", () => {
  const p = classifyImport([r(""), r("  ", " ", ""), r("", "John"), r("John @", "J"), r("a@x.com")], M);
  assert.equal(p.emptyRows, 2);
  assert.equal(p.totalRows, 3);
  assert.equal(p.noEmail, 2);
  assert.equal(p.importRows.length, 1);
  const h = classifyImport([], M);
  assert.equal(h.totalRows, 0);
  assert.equal(classifyImport([r("a@x.com")], {}).noEmail, 1);
});

test("rule 2: corrected count only for imported rows", () => {
  const p = classifyImport([r("x@gmail.con"), r("y@gmail.com"), r("z@acme.con")], M);
  assert.equal(p.emailsCorrected, 2);
  assert.deepEqual(p.importRows.map((x) => x.email), ["x@gmail.com", "y@gmail.com", "z@acme.com"]);
});

test("rule 4: multi-email row needs a choice; default first is up to the caller", () => {
  const rows = [r("a@x.com; b@y.com", "Anna Roy", "Acme"), r("c@x.com")];
  const none = classifyImport(rows, M);
  assert.equal(none.review.multi.length, 1);
  assert.deepEqual(none.review.multi[0]!.candidates, ["a@x.com", "b@y.com"]);
  assert.equal(none.review.multi[0]!.name, "Anna Roy");
  assert.equal(none.review.multi[0]!.company, "Acme");
  assert.equal(none.skippedByChoice, 1);
  assert.equal(none.importRows.length, 1);
  const pick = classifyImport(rows, M, { "0": { action: "use_email", email: "b@y.com" } });
  assert.deepEqual(pick.importRows.map((x) => x.email), ["b@y.com", "c@x.com"]);
  assert.equal(classifyImport(rows, M, { "0": { action: "skip" } }).skippedByChoice, 1);
  // email not among candidates, or wrong action: ignored (row not imported)
  assert.equal(classifyImport(rows, M, { "0": { action: "use_email", email: "z@z.com" } }).skippedByChoice, 1);
  assert.equal(classifyImport(rows, M, { "0": { action: "keep" } }).skippedByChoice, 1);
});

test("rule 5: same email twice, same person = silent duplicate", () => {
  const same = (a: string, b: string) => classifyImport([r("a@x.com", a), r("A@X.com", b)], M);
  for (const [a, b] of [["John Smith", "john smith"], ["Zoë Ångström", "Zoe Angstrom"], ["John Smith", "Smith John"], ["John Smith", ""], ["John Smith", "John  Smith."]] as const) {
    const p = same(a, b);
    assert.equal(p.duplicateInFile, 1, `${a}|${b}`);
    assert.equal(p.review.ambiguous.length, 0);
    assert.equal(p.importRows.length, 1);
  }
  const p = same("", "Jane Roe");
  assert.deepEqual(p.importRows, [{ rowIndex: 1, email: "a@x.com" }]); // keeps the named row
});

test("rule 5: different names = ambiguous, nothing imported until decided", () => {
  const rows = [r("a@x.com", "John Smith", "Acme"), r("a@x.com", "Jane Roe", "Beta"), r("b@x.com", "Bob")];
  const p = classifyImport(rows, M);
  assert.equal(p.review.ambiguous.length, 1);
  assert.equal(p.review.ambiguous[0]!.rows.length, 2);
  assert.equal(p.review.ambiguous[0]!.rows[1]!.rowNumber, 2);
  assert.equal(p.skippedAmbiguous, 2);
  assert.equal(p.importRows.length, 1);
  assert.equal(sum(p), p.totalRows);
});

test("choices: keep / edit / none / two keeps / regroup", () => {
  const rows = [r("a@x.com", "John Smith"), r("a@x.com", "Jane Roe"), r("a@x.com", "Bob Lee")];
  const imp = (c: ImportChoices) => classifyImport(rows, M, c);
  let p = imp({ "1": { action: "keep" } });
  assert.deepEqual(p.importRows, [{ rowIndex: 1, email: "a@x.com" }]);
  assert.equal(p.skippedAmbiguous, 2);
  p = imp({ "0": { action: "keep" }, "1": { action: "keep" } });
  assert.equal(p.importRows.length, 0);
  assert.equal(p.skippedAmbiguous, 3);
  assert.equal(imp({}).importRows.length, 0);
  // edit one row: it becomes a different lead; remaining two still ambiguous
  p = imp({ "0": { action: "use_email", email: "john@x.com" } });
  assert.deepEqual(p.importRows, [{ rowIndex: 0, email: "john@x.com" }]);
  assert.equal(p.skippedAmbiguous, 2);
  // edit two, keep none of the rest -> third imports alone (group of 1)
  p = imp({ "0": { action: "use_email", email: "john@x.com" }, "1": { action: "use_email", email: "jane@x.com" } });
  assert.deepEqual(p.importRows.map((x) => x.email), ["john@x.com", "jane@x.com", "a@x.com"]);
  assert.equal(p.skippedAmbiguous, 0);
  assert.equal(sum(p), p.totalRows);
  // regroup collision with same-name = silent dup, different name = ambiguous again
  p = imp({ "0": { action: "use_email", email: "n@x.com" }, "1": { action: "use_email", email: "n@x.com" } });
  assert.equal(p.skippedAmbiguous, 2); // John vs Jane on n@x.com, undecided
  assert.equal(p.importRows.length, 1); // Bob alone on a@x.com
  const dup = classifyImport([r("a@x.com", "J S"), r("a@x.com", "Z Z"), r("n@x.com", "J S")], M, { "0": { action: "use_email", email: "n@x.com" } });
  assert.equal(dup.duplicateInFile, 1);
  assert.equal(sum(dup), dup.totalRows);
  // invalid edit (not one valid email) is ignored
  p = imp({ "0": { action: "use_email", email: "nope" }, "1": { action: "use_email", email: "a@x.com; b@x.com" } });
  assert.equal(p.importRows.length, 0);
  assert.equal(p.skippedAmbiguous, 3);
  // edit with typo gets corrected and counted
  p = imp({ "0": { action: "use_email", email: "j@gmail.con" } });
  assert.equal(p.emailsCorrected, 1);
});

test("hostile choices are ignored", () => {
  const rows = [r("a@x.com", "John"), r("b@x.com", "Jane"), r("a@x.com", "Zed")];
  const bad = {
    "-1": { action: "keep" }, "99999": { action: "keep" }, x: { action: "keep" }, "1": { action: "keep" },
    "5": null, "0": { action: "bogus" },
  } as unknown as ImportChoices;
  const p = classifyImport(rows, M, bad);
  // row 1 (b@) is not flagged, so its keep is ignored, it still imports on its own
  assert.deepEqual(p.importRows, [{ rowIndex: 1, email: "b@x.com" }]);
  assert.equal(p.skippedAmbiguous, 2);
  // skip on an ambiguous row does nothing
  assert.equal(classifyImport(rows, M, { "0": { action: "skip" } }).skippedAmbiguous, 2);
  assert.equal(classifyImport(rows, M, { "0": { action: "use_email", email: 5 as unknown as string } }).skippedAmbiguous, 2);
});

test("invariant on fuzz + speed on 20k", () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const cells = ["", "  ", "a@x.com", "A@X.com", "b@y.com", "c@gmail.con", "a@x.com; b@y.com", "bad", "n@", "d@z.org", "x@x.com and y@y.com"];
  const names = ["", "John Smith", "Jane Roe", "smith john", "Bob"];
  const mk = (n: number) => Array.from({ length: n }, () => r(cells[rnd(cells.length)], names[rnd(names.length)], "Co"));
  const rows = mk(3000);
  const choices: ImportChoices = {};
  for (let i = 0; i < 3000; i += 3) choices[i] = [{ action: "keep" }, { action: "skip" }, { action: "use_email", email: "q" + i + "@x.com" }, { action: "use_email", email: "a@x.com" }][rnd(4)] as never;
  for (const c of [undefined, choices]) {
    const p = classifyImport(rows, M, c);
    assert.equal(sum(p), p.totalRows);
    assert.equal(p.totalRows + p.emptyRows, rows.length);
  }
  const big = mk(20000);
  const t = Date.now();
  const p = classifyImport(big, M, choices);
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t}ms`);
  assert.equal(sum(p), p.totalRows);
});

test("hostile whitespace cells classify fast and give no email", () => {
  for (const cell of [" ".repeat(990) + "a", " ".repeat(990) + "@"]) {
    const t = Date.now();
    assert.deepEqual(one(cell), []);
    assert.ok(Date.now() - t < 100);
  }
  assert.deepEqual(one("a@x.com\nb@y.com"), ["a@x.com", "b@y.com"]);
});

test("row cap is the agreed 10000", () => {
  assert.equal(IMPORT_LIMITS.maxRows, 10000);
});

test("a hostile nested cell is an empty cell, not a stack overflow", () => {
  let deep: unknown = ["x"];
  for (let i = 0; i < 200_000; i++) deep = [deep];
  assert.equal(cellString(deep), "");
  assert.equal(cellString({ a: 1 }), "");
  assert.equal(cellString(null), "");
  assert.equal(cellString(42), "42");
  assert.deepEqual(cleanEmailCell(deep).candidates, []);
  assert.deepEqual(cleanEmailCell(null).candidates, []);
});

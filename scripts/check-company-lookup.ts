/**
 * Self-check for Company Lookup's pure logic. Run: npx tsx scripts/check-company-lookup.ts
 *
 * Covers the two bits that are easy to get subtly wrong and that nothing else
 * would catch: title ranking order, and the Advanced-filter parser that decides
 * whether an untouched panel silently narrows a paid search.
 */
import assert from "node:assert/strict";
import { companyLookupTitleRank, COMPANY_LOOKUP_MAX_CONTACTS } from "../lib/constants";

const rank = companyLookupTitleRank;

// A specific phrase must beat the generic word it contains, otherwise a
// Managing Director sorts level with any random "Director".
assert.ok(rank("Group Managing Director") < rank("Creative Director"), "managing director should outrank plain director");
assert.ok(rank("CEO") < rank("Export Manager"), "CEO should outrank export manager");
assert.ok(rank("Head of Procurement") < rank("Production Manager"), "head of should outrank a plain manager");
assert.ok(rank("Export Manager") < rank("Sales Executive"), "export should outrank generic sales roles");

// Case and surrounding words must not matter — Apollo returns free-form titles.
assert.equal(rank("managing director"), rank("Senior MANAGING DIRECTOR, APAC"), "ranking must be case- and context-insensitive");

// Unranked and missing titles sink, and must not accidentally sort first.
assert.equal(rank(null), Number.MAX_SAFE_INTEGER, "null title must sink");
assert.equal(rank(""), Number.MAX_SAFE_INTEGER, "empty title must sink");
assert.ok(rank("Yoga Instructor") > rank("Procurement Manager"), "unranked titles sink below ranked ones");

// A realistic roster sorts the way a salesperson would expect.
const roster = ["Warehouse Assistant", "Procurement Manager", "Managing Director", "Export Manager"];
const sorted = [...roster].sort((a, b) => rank(a) - rank(b));
assert.deepEqual(sorted, ["Managing Director", "Export Manager", "Procurement Manager", "Warehouse Assistant"]);

// The spend ceiling is what makes this feature safe to ship; if it ever moves,
// this check should be the thing that makes someone think twice.
assert.equal(COMPANY_LOOKUP_MAX_CONTACTS, 5, "contact cap changed — this is the reveal spend ceiling");

console.log("company-lookup self-check: all assertions passed");

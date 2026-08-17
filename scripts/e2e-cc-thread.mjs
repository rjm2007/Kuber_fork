/**
 * End-to-end check of the multi-participant thread UI.
 *
 * Run against a dev server already listening on localhost:3000:
 *   node scripts/e2e-cc-thread.mjs
 *
 * Signs in WITHOUT a password: mints a one-time magic-link token with the
 * service-role key, exchanges it for a real session, and writes that session
 * into the browser as the same cookie @supabase/ssr would. No test account is
 * created and no existing password is touched.
 *
 * Screenshots land in scripts/e2e-shots/.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "scripts", "e2e-shots");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const AS_USER = process.env.E2E_USER ?? "lakshit@gmail.com";

// .env.local is not loaded for a bare `node` run.
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** The cookie shape @supabase/ssr 0.12 writes: base64- prefixed JSON, chunked. */
function sessionCookies(session, projectRef) {
  const payload = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64");
  const name = `sb-${projectRef}-auth-token`;
  const CHUNK = 3180;
  const base = { domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" };
  if (payload.length <= CHUNK) return [{ ...base, name, value: payload }];
  const chunks = [];
  for (let i = 0; i * CHUNK < payload.length; i++) {
    chunks.push({ ...base, name: `${name}.${i}`, value: payload.slice(i * CHUNK, (i + 1) * CHUNK) });
  }
  return chunks;
}

async function mintSession() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: AS_USER });
  if (error) throw new Error(`generateLink: ${error.message}`);

  const anon = createClient(SUPABASE_URL, PUBLISHABLE, { auth: { persistSession: false } });
  const { data: verified, error: vErr } = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: "email",
  });
  if (vErr) throw new Error(`verifyOtp: ${vErr.message}`);
  return verified.session;
}

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** The filter rail starts collapsed behind an icon button. */
async function openFilters(page) {
  const toggle = page.getByRole("button", { name: "Open filters" });
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(600);
  }
}

/** Click a filter in the Conversations rail and read the "N threads" heading. */
async function readFilter(page, label) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(1400);
  const heading = await page.locator("text=/\\d+\\s+threads?/i").first().innerText().catch(() => "");
  return parseInt(heading, 10);
}

const session = await mintSession();
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(sessionCookies(session, projectRef));
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  // ── Auth ───────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/unibox`, { waitUntil: "networkidle", timeout: 90_000 });
  check("signed in (not bounced to login)", !page.url().endsWith("/"), page.url());
  await shot(page, "01-unibox");

  // ── Filters ────────────────────────────────────────────────────────────
  await page.getByPlaceholder(/search by lead name/i).waitFor({ timeout: 60_000 });
  await openFilters(page);
  const counts = {};
  for (const f of ["All", "Unread", "Read", "Replied", "Needs reply", "No reply yet"]) {
    counts[f] = await readFilter(page, f);
  }
  console.log("   filter counts:", JSON.stringify(counts));
  check("read + unread === all", counts.Read + counts.Unread === counts.All,
        `${counts.Read} + ${counts.Unread} vs ${counts.All}`);
  check("replied + needs reply + no reply yet === all",
        counts.Replied + counts["Needs reply"] + counts["No reply yet"] === counts.All,
        `${counts.Replied} + ${counts["Needs reply"]} + ${counts["No reply yet"]} vs ${counts.All}`);
  check("needs reply is non-empty", counts["Needs reply"] > 0, String(counts["Needs reply"]));
  await shot(page, "02-needs-reply");

  // ── Thread: identity + chips ───────────────────────────────────────────
  await page.getByRole("button", { name: "All", exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.locator("text=Raghav Mehta").first().click();
  // The detail fetch hydrates from Instantly, so it can take many seconds —
  // wait for real content rather than a fixed sleep.
  await page.locator("text=rjmehta05081007").first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(800);

  // Only the newest message is expanded by default, and the per-message actions
  // live in the expanded body — so open the third party's message explicitly.
  await page.locator("text=rjmehta05081007").first().click();
  await page.waitForTimeout(1200);
  await shot(page, "03-thread");

  const body = await page.locator("body").innerText();
  check("third party shown by address, not lead name", body.includes("rjmehta05081007@gmail.com"));
  check("'not the lead' or 'via cc' marker present", /not the lead|via cc/i.test(body));
  check("'Not answered' marker present", /not answered/i.test(body));
  check("real to/cc header rendered", /to\s+\S+@\S+/i.test(body));

  // ── Composer: reply all ────────────────────────────────────────────────
  const replyAll = page.getByRole("button", { name: /reply all/i }).first();
  if (await replyAll.count()) {
    await replyAll.click();
    await page.waitForTimeout(1500);
    await shot(page, "04-reply-all");
    const composer = await page.locator("body").innerText();
    check("reply-all puts both addresses in To",
          composer.includes("rudraksh.mehta@djsce.edu.in") && composer.includes("rjmehta05081007@gmail.com"));
  } else {
    check("reply all button present", false, "not found");
  }

  // ── Add as lead dialog ─────────────────────────────────────────────────
  const addLead = page.getByRole("button", { name: /add as lead/i }).first();
  if (await addLead.count()) {
    await addLead.click();
    await page.waitForTimeout(1200);
    await shot(page, "05-add-lead-dialog");
    const dlg = await page.locator("[role=dialog]").innerText().catch(() => "");
    check("dialog asks for a name", /first name/i.test(dlg), dlg.slice(0, 80).replace(/\n/g, " "));
    check("dialog shows inherited organization", /organization/i.test(dlg));
    const addBtn = page.locator("[role=dialog]").getByRole("button", { name: /^add lead$/i });
    check("Add lead disabled until a name is typed", await addBtn.isDisabled().catch(() => false));
    await page.keyboard.press("Escape");
  } else {
    check("add as lead button present", false, "not found (already a lead?)");
  }

  check("no console/page errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("run completed without throwing", false, String(e).split("\n")[0]);
  await shot(page, "99-failure").catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in scripts/e2e-shots/`);
process.exit(failed.length === 0 ? 0 : 1);

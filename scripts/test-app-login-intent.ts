/**
 * Regression: an admin's FAQ answer to "App download" told a student to
 * "type login" — but nothing in the router recognised the literal word
 * "login" as an actual request, so the student typing exactly that just
 * created ANOTHER unanswered-question ticket (WhatsApp UQ-050) instead of
 * getting anywhere. detectActionIntent() now recognises "login" and its
 * natural phrasings as a request for the real Student App link.
 *
 * Run with: npx tsx scripts/test-app-login-intent.ts
 */
import assert from "node:assert/strict";
import { detectActionIntent } from "../src/lib/whatsapp/rule-intent";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("REGRESSION: bare 'Login' (UQ-050) launches the app-login workflow, not a dead end", () => {
  assert.equal(detectActionIntent("login"), "app_login");
});

test("REGRESSION: bare 'App' also launches app_login (was falling through to a stale FAQ)", () => {
  assert.equal(detectActionIntent("app"), "app_login");
});

test("'App download' (UQ-048) also launches app_login directly", () => {
  assert.equal(detectActionIntent("app download"), "app_login");
});

test("natural phrasings all resolve to app_login", () => {
  for (const q of ["download app", "install the app", "student app", "open the app", "app link", "signin"]) {
    assert.equal(detectActionIntent(q), "app_login", `expected app_login for "${q}"`);
  }
});

test("'why can't I login' is an explanation, not a workflow launch — assistant should answer", () => {
  assert.equal(detectActionIntent("why can't i login"), null);
});

test("a genuine registration question isn't swallowed by the login intent", () => {
  assert.equal(detectActionIntent("i want to register"), "register");
});

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      c.run();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  - ${c.name}`);
      console.error(err);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();

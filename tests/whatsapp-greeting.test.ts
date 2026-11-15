import { strict as assert } from "node:assert";
import { test } from "node:test";
import { register } from "node:module";

register("./helpers/test-alias-hooks.mjs", import.meta.url);

const { parseIncomingWhatsApp } = await import("../src/lib/whatsapp/parser.ts");
const {
  processExplanationMessage,
  shortGreetingMessage,
  cleanDisplayName,
  resolveGreetingName,
} = await import("../src/lib/whatsapp/onboarding.ts");
const { isWelcomeGreeting } = await import("../src/lib/whatsapp/moderation.ts");

// Krupal, 28 Oct 2026: "When we type hi it must mention there name then
// ask what uh need" — "To everyone." The greeting must name the sender:
// registered profile first, then a name the bot already knows, then the
// WhatsApp profile name (pushname) — so an unregistered sender still gets
// a named greeting. Generic only when no name exists anywhere.

test("parser extracts the WhatsApp profile name (pushname)", () => {
  const payload = {
    entry: [{ changes: [{ value: {
      messages: [{ from: "9198765432", id: "wamid.1", type: "text", text: { body: "Hi" } }],
      contacts: [{ profile: { name: "Krupal Sai" }, wa_id: "9198765432" }],
    } }] }],
  };
  const msg = parseIncomingWhatsApp(payload);
  assert.equal(msg?.profileName, "Krupal Sai");
  assert.equal(msg?.text, "Hi");
});

test("parser leaves profileName null when Meta sends no contacts", () => {
  const payload = {
    entry: [{ changes: [{ value: {
      messages: [{ from: "9198765432", id: "wamid.2", type: "text", text: { body: "Hi" } }],
    } }] }],
  };
  assert.equal(parseIncomingWhatsApp(payload)?.profileName, null);
});

test("parser leaves profileName null for an empty profile name", () => {
  const payload = {
    entry: [{ changes: [{ value: {
      messages: [{ from: "9198765432", id: "wamid.3", type: "text", text: { body: "Hi" } }],
      contacts: [{ profile: { name: "   " }, wa_id: "9198765432" }],
    } }] }],
  };
  assert.equal(parseIncomingWhatsApp(payload)?.profileName, null);
});

test("cleanDisplayName takes the first word and rejects non-names", () => {
  assert.equal(cleanDisplayName("Krupal Sai"), "Krupal");
  assert.equal(cleanDisplayName("Sample Student"), "Sample");
  assert.equal(cleanDisplayName("  Anil  "), "Anil");
  assert.equal(cleanDisplayName("😎🔥"), null);
  assert.equal(cleanDisplayName("   "), null);
  assert.equal(cleanDisplayName(null), null);
  assert.equal(cleanDisplayName(undefined), null);
});

test("process explanation greets by name, generic when unknown", () => {
  assert.ok(processExplanationMessage("Krupal").startsWith("Hi Krupal! Welcome to Student Support."));
  assert.ok(processExplanationMessage(null).startsWith("Hi! Welcome to Student Support."));
  assert.ok(!processExplanationMessage(null).includes("undefined"));
  assert.ok(!processExplanationMessage("Krupal").includes("undefined"));
});

test("short greeting is the old question with the name in front", () => {
  assert.equal(
    shortGreetingMessage("Krupal"),
    "Hi Krupal, how can I help you today? Are you looking to register or have questions about your batch?",
  );
  assert.equal(
    shortGreetingMessage(null),
    "How can I help you today? Are you looking to register or have questions about your batch?",
  );
});

test("isWelcomeGreeting covers greetings but not commands", () => {
  for (const g of ["hi", "Hi!", "hello", "hey", "good morning", "namaste", "gm"]) {
    assert.equal(isWelcomeGreeting(g), true, g);
  }
  for (const c of ["menu", "help", "start", "how do I register", "thanks", "my payment failed"]) {
    assert.equal(isWelcomeGreeting(c), false, c);
  }
});

// Minimal Supabase stub: only the two lookups resolveGreetingName runs.
function fakeDb(opts: { profile?: { full_name: string | null } | null; preferred?: string | null }) {
  return {
    from(table: string) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        async maybeSingle() {
          if (table === "profiles") return { data: opts.profile ?? null };
          if (table === "whatsapp_moderation") {
            return { data: opts.preferred === undefined ? null : { preferred_name: opts.preferred } };
          }
          return { data: null };
        },
      };
      return chain;
    },
  };
}

test("resolveGreetingName: registered profile name wins over pushname", async () => {
  const db = fakeDb({ profile: { full_name: "Sample Student" }, preferred: "Anil" });
  assert.equal(await resolveGreetingName(db as never, "9000000001", "Rocky"), "Sample");
});

test("resolveGreetingName: known name wins over pushname when unregistered", async () => {
  const db = fakeDb({ profile: null, preferred: "Anil" });
  assert.equal(await resolveGreetingName(db as never, "9000000002", "Rocky"), "Anil");
});

test("resolveGreetingName: unregistered sender still gets the WhatsApp profile name", async () => {
  const db = fakeDb({ profile: null, preferred: null });
  assert.equal(await resolveGreetingName(db as never, "9000000003", "Rocky"), "Rocky");
});

test("resolveGreetingName: null profile name falls back to generic", async () => {
  const db = fakeDb({ profile: null, preferred: null });
  assert.equal(await resolveGreetingName(db as never, "9000000004", null), null);
  assert.equal(await resolveGreetingName(db as never, "9000000004", "😎"), null);
});

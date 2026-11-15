/**
 * Every command the admin system prompt advertises must actually exist.
 *
 * Live-reported: asked to send an announcement, the assistant replied "use the
 * admin console (or the /announce command in the admin WhatsApp group)". That
 * command has never existed. The prompt told the model that every real action
 * goes through "this bot's actual commands (see HELP)" without ever showing it
 * HELP, so it invented something plausible — the same failure as item #71's
 * Admin Copilot inventing a "Messaging screen".
 *
 * The fix is to give the prompt the real list. This test is the other half:
 * a command named in that list but missing from the handler is exactly the
 * bug the list was added to prevent, so it fails the build instead.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

function run() {
  const reference = read("../src/lib/intent-engine/platform-knowledge.ts");
  const admin = read("../src/lib/whatsapp/admin.ts");
  const adminMenu = read("../src/lib/whatsapp/admin-menu.ts");
  const router = read("../src/lib/whatsapp/router.ts");
  const handlers = admin + adminMenu + router;

  const block = reference.match(/ADMIN_COMMAND_REFERENCE = `([\s\S]*?)`;/);
  assert.ok(block, "ADMIN_COMMAND_REFERENCE must exist — it is what stops the model inventing commands");

  // The leading keyword of each bullet, e.g. "- ANNOUNCE <batch>: ..." → ANNOUNCE.
  const advertised = block![1]
    .split("\n")
    .filter(l => l.trim().startsWith("- "))
    .flatMap(l => l.replace(/^\s*-\s*/, "").split("—")[0].split("/"))
    .map(part => (part.trim().match(/^[A-Z][A-Z ]*[A-Z]|^[A-Z]+/) ?? [""])[0].trim())
    .filter(Boolean);

  assert.ok(advertised.length >= 15, `expected the full command list, parsed ${advertised.length}`);

  for (const cmd of new Set(advertised)) {
    // A command is implemented if its keyword appears in a matcher or an
    // equality check somewhere in the handler chain.
    const words = cmd.split(/\s+/).map(w => w.replace(/[^A-Z]/gi, ""));
    const found = words.every(w => new RegExp(`\\b${w}\\b`, "i").test(handlers));
    assert.ok(found, `ADMIN_COMMAND_REFERENCE advertises "${cmd}" but no handler mentions it`);
  }

  // The two added in response to the report specifically.
  assert.ok(/\^ACTIVE\\s\*BATCH/.test(admin), "ACTIVE BATCH must be a real command, not an LLM answer");
  assert.ok(/\^ANNOUNCE\\b/.test(admin), "ANNOUNCE must be a real command");

  // And the prompt must forbid inventing the things it cannot do.
  const prompt = read("../src/lib/intent-engine/groq-provider.ts");
  assert.ok(
    /NEVER invent a command/.test(prompt),
    "the admin prompt must forbid inventing commands, screens and URLs",
  );
  assert.ok(
    /Never state a fee amount/.test(prompt),
    "the admin prompt must carry the rule 8 fee ban",
  );

  console.log(`test-admin-commands: ${new Set(advertised).size} advertised commands all implemented`);
}

run();

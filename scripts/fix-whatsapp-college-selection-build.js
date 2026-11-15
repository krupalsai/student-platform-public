const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "src/lib/whatsapp/router.ts");
const source = fs.readFileSync(file, "utf8");

const oldBlock = `  const incomingSelection = (msg.text ?? "").trim();\n  const selectionMatch = incomingSelection.match(/^COLLEGE_SELECTED:([A-Za-z0-9_-]{20,80})$/);\n  if (selectionMatch || incomingSelection) {`;

const newBlock = `  const incomingSelection = (msg.text ?? "").trim();\n  const selectionMatch = incomingSelection.match(/^COLLEGE_SELECTED:([A-Za-z0-9_-]{20,80})$/);\n  // A plain college name is only a selection when this WhatsApp number has a\n  // matching unconsumed website-selection token. Never treat arbitrary text\n  // such as "Hii" or "Register" as a college-selection callback.\n  const pendingNameSelection = !selectionMatch && incomingSelection\n    ? Boolean((await db.from("whatsapp_college_selection_tokens")\n        .select("id")\n        .eq("phone", normalizePhone(phone))\n        .eq("college_name", incomingSelection)\n        .is("consumed_at", null)\n        .gt("expires_at", new Date().toISOString())\n        .limit(1)\n        .maybeSingle()).data)\n    : false;\n  if (selectionMatch || pendingNameSelection) {`;

if (!source.includes(oldBlock)) {
  if (source.includes("const pendingNameSelection = !selectionMatch")) process.exit(0);
  throw new Error("Expected WhatsApp college-selection guard was not found; refusing to build with an unknown router shape.");
}

fs.writeFileSync(file, source.replace(oldBlock, newBlock), "utf8");
console.log("[prebuild] Fixed WhatsApp college-selection guard: plain messages no longer enter selection flow.");

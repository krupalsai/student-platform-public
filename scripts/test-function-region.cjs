// Pins the serverless function region next to the database (item #250).
// Run: node scripts/test-function-region.cjs
//
// The Supabase project lives in ap-southeast-1 (Singapore). Until 2026-10-12 the functions ran in the
// Vercel default, iad1 (Washington D.C.), so EVERY database query crossed the planet: a single query took
// 0.5-1.5 s, /api/extra-fee 3-4 s, a menu tap in Support 8 s, a typed Support question 21 s. The functions
// belong in sin1 (same AWS region as the database). Hobby plans allow exactly one region.
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8"));
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };

check("vercel.json pins the functions to one region", Array.isArray(cfg.regions) && cfg.regions.length === 1);
check("that region is Singapore (sin1), next to the Supabase project in ap-southeast-1", cfg.regions && cfg.regions[0] === "sin1");
check("no per-function region override sends a route back across the ocean", !JSON.stringify(cfg.functions ?? {}).includes('"regions"'));
const src = (() => { try { return require("child_process").execSync("grep -rln \"preferredRegion\\|runtime = \\\"edge\\\"\" src || true", { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }); } catch { return ""; } })();
check("no route opts into the edge runtime or its own region", src.trim() === "");

console.log(`test-function-region: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

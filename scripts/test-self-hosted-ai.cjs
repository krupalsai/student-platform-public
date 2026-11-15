// Pins the self-hosted AI wiring. Run: node scripts/test-self-hosted-ai.cjs
const path = require("path"), fs = require("fs");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

delete process.env.SELF_HOSTED_AI_URL; delete process.env.SELF_HOSTED_AI_TOKEN;
const { selfHostedConfig } = jiti("../src/lib/intent-engine/self-hosted-provider.ts");
check("inert without env", selfHostedConfig() === null);
process.env.SELF_HOSTED_AI_URL = "https://x.duckdns.org/";
check("inert without token", selfHostedConfig() === null);
process.env.SELF_HOSTED_AI_TOKEN = "t";
const c = selfHostedConfig();
check("configured with url+token", c && c.url === "https://x.duckdns.org" && c.primary === false && c.model === "qwen2.5:3b");
process.env.SELF_HOSTED_AI_ROLE = "primary";
check("primary role", selfHostedConfig().primary === true);

const idx = read("src/lib/intent-engine/index.ts");
check("app channel only (never WhatsApp)", /channel === "app" \? selfHostedConfig\(\) : null/.test(idx));
check("fallback after cloud by default", /cloud\.kind === "unavailable" && selfHosted && !selfHosted\.primary/.test(idx));

const caddy = read("ai-server/Caddyfile");
check("caddy requires bearer token", /header Authorization "Bearer \{\$AI_TOKEN\}"/.test(caddy));
check("caddy allows only two paths", /path \/v1\/chat\/completions \/api\/tags/.test(caddy));
check("caddy refuses everything else", /respond "Unauthorized" 401/.test(caddy));
const compose = read("ai-server/docker-compose.yml");
check("ollama never published", !/ollama:[\s\S]*?ports:[\s\S]*?11434/.test(compose.split("model-pull:")[0]));
check(".env is gitignored", /^\.env$/m.test(read("ai-server/.gitignore")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

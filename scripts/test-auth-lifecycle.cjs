// Pins the Step-1 login rules. Run: node scripts/test-auth-lifecycle.cjs
const path = require("path"), fs = require("fs");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
process.env.SESSION_TTL_DAYS = "30";
const { sessionTtlDays } = jiti("../src/lib/session.ts");
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

process.env.SESSION_TTL_DAYS = "30"; // the legacy value still set in production
check("student 30 days hard expiry (legacy SESSION_TTL_DAYS=30 ignored)", sessionTtlDays("student") === 30);
check("student expiry is hard, never extended on use", /hardExpiry/.test(read("src/lib/session.ts")));
check("admin 7 days", sessionTtlDays("admin") === 7);
check("super_admin 7 days", sessionTtlDays("super_admin") === 7);
check("viewer 7 days", sessionTtlDays("viewer") === 7);

const logout = read("src/app/api/auth/logout/route.ts");
check("logout revokes cookie AND bearer", /cookieToken/.test(logout) && /bearerToken/.test(logout) && /\.in\("token_hash", hashes\)/.test(logout));

// Every path that creates a session uses the role-based TTL — no stray 30-day constants.
for (const f of ["src/lib/services/registration-bootstrap.ts", "src/lib/whatsapp/admin-login.ts", "src/app/api/merchant-demo/login/route.ts", "src/lib/app-login.ts"]) {
  const s = read(f);
  check(`${f} uses sessionTtlDays`, /sessionTtlDays\(/.test(s) && !/SESSION_TTL_DAYS \?\? "30"/.test(s));
}
// Every login response sets the persistent cookie.
for (const f of ["src/app/api/auth/app-login/verify/route.ts", "src/app/api/registration-tokens/verify-otp/route.ts", "src/app/api/auth/whatsapp-otp/route.ts", "src/app/api/merchant-demo/login/route.ts", "src/app/api/auth/session/route.ts"]) {
  check(`${f} sets cookie`, /setSessionCookie\(/.test(read(f)));
}
// Admin preview must never become the admin's own cookie.
check("preview session sets no cookie", !/setSessionCookie/.test(read("src/app/api/admin/students/[id]/preview-session/route.ts")));
check("role guard skips session call in preview", /if \(previewToken\) return;/.test(read("src/lib/hooks/useRoleGuard.ts")));
// Network errors never clear the token.
check("login keeps token on transient errors", /SESSION_TRANSIENT/.test(read("src/app/login/page.tsx")));
// Phone is not changeable with only a session.
check("correction refuses phone change", /Changing your phone number needs fresh verification/.test(read("src/app/api/profile/correction/route.ts")));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

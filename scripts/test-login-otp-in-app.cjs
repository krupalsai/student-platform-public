// Pins in-app login codes (item #220) and the required-notifications gate.
// Run: node scripts/test-login-otp-in-app.cjs
const fs = require("fs");
const path = require("path");
const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const lib = read("src/lib/app-login.ts");
const route = read("src/app/api/auth/app-login/request/route.ts");
const sw = read("public/sw.js");
const login = read("src/app/login/page.tsx");
const gate = read("src/components/student/NotificationGate.tsx");
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };

// Security: a typed phone number must never route the code to the requester's own device.
check("in-app code only to an endpoint already linked to THIS student",
  /\.eq\("student_id", studentId\)\s*\.eq\("endpoint", endpoint\)/.test(lib));
check("in-app code goes to that one device, not every subscription",
  /sendPushMessage\(sub, \{[\s\S]{0,200}otp,/.test(lib) && !/getPushSubscriptionsForStudent\(db, studentId\);\s*\n[\s\S]{0,40}otp,/.test(lib));
// Delivery order: this device's push -> any linked device's push -> clean
// failure flagged for the WhatsApp-code path. The app request NEVER sends
// WhatsApp itself (9 Nov 2026): WhatsApp only delivers inside the 24h
// window after the student messages the bot, and a free-form text sent
// outside it is silently dropped — the old code treated "accepted" as
// delivered, so students saw "code sent" and got nothing. The student
// reopens the window by messaging VERIFY; the bot replies with the code.
// No SMS fallback since 26 Oct 2026 (Fast2SMS deleted — it never delivered;
// Twilio was never configured).
const iThis = lib.indexOf("tryPushToThisDevice(db, profile.id"), iAny = lib.indexOf("tryPushDelivery(db, profile.id");
check("delivery order is app -> any app -> clean failure, no WhatsApp send", iThis > 0 && iThis < iAny && !/sendWhatsAppOtp\(phone, otp\)/.test(lib) && /whatsappCodeFallback: true as const/.test(lib));
check("no SMS fallback remains", !/sendSmsOtp/.test(lib) && !/@\/lib\/sms/.test(lib));
check("in-app delivery needs this device's endpoint", /if \(opts\.deviceEndpoint\) \{\s*const here = await tryPushToThisDevice/.test(lib));
check("nothing in the request can skip in-app delivery or the cooldown", !/forceWhatsApp/.test(lib) && !/forceWhatsApp|via: z\.enum/.test(route));
check("a failed code is deleted when nothing could deliver it", /\.from\("app_login_otps"\)\.delete\(\)\.eq\("otp_hash", hashOtp\(otp\)\)/.test(lib));
check("route validates the endpoint as a URL", /device_endpoint: z\.string\(\)\.url\(\)/.test(route));
check("route forwards the device endpoint", /deviceEndpoint: body\.data\.device_endpoint/.test(route));

check("service worker relays only a 6-digit code", /\/\^\\d\{6\}\$\/\.test\(payload\.otp\)/.test(sw));
check("service worker still shows the notification", /showNotification\(payload\.title/.test(sw));
check("tapping the code notification does not navigate an open login page", /open\.postMessage\(\{ type: "sp_login_otp", otp \}\);\s*return open\.focus\(\)/.test(sw));
check("cache bumped with the worker", /student-platform-pwa-v\d+/.test(sw));

check("login sends this device's endpoint", /getThisDeviceEndpoint\(\)/.test(login) && /device_endpoint: deviceEndpoint/.test(login));
check("login auto-fills and submits a relayed code", /e\.data\?\.type === "sp_login_otp"/.test(login) && /void submitOtp\(savedPhone, code\)/.test(login));
check("login auto-submits a given code once", /autoSubmitted\.current === code/.test(login));
check("login offers the WhatsApp code when the code doesn't arrive", /No code\? Try again/.test(login) && /Get code on WhatsApp/.test(login) && /setShowCodeFallback\(data\?\.fallback === "whatsapp_code"\)/.test(login));

check("gate shows on every launch (no one-time seen flag)", !/sp_notif_gate_seen/.test(gate));
check("gate has no skip when permission is denied", /stage === "denied"[\s\S]{0,1600}I&apos;ve turned it on/.test(gate) && !/stage === "denied"[\s\S]{0,1600}Continue to the app/.test(gate));
check("gate re-checks on return from settings", /visibilitychange/.test(gate));
check("gate never blocks on missing server push keys", /getVapidPublicKey\(\); \} catch \{ return setStage\("hidden"\)/.test(gate));
check("gate never blocks admin preview", /preview_token/.test(gate));
check("gate leaves login/install/register open", /"\/login", "\/install", "\/register"/.test(gate));
check("only genuinely unsupported installed apps may continue", /NO_PUSH_ACK_KEY, "1"/.test(gate) && /isStandalone\(\) \? \(/.test(gate));

console.log(`test-login-otp-in-app: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

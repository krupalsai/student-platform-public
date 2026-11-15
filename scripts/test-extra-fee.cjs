// Pins the separate second-payment (₹200) rules.
// Run: node scripts/test-extra-fee.cjs
const fs = require("fs");
const path = require("path");
const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const svc = read("src/lib/services/extra-fee.ts");
const create = read("src/app/api/extra-fee/create-order/route.ts");
const verify = read("src/app/api/extra-fee/verify/route.ts");
const hook = read("src/app/api/razorpay/webhook/route.ts");
const data = read("src/lib/hooks/useStudentData.ts");
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };

check("second payment lives in its own table, never in payments", !/from\("payments"\)\.(insert|update)/.test(svc + create + verify));
check("only after the main fee is approved", /eq\("status", "approved"\)/.test(svc) && /main_not_paid/.test(svc));
check("opens when an admin switches it on OR its start date passes", /if \(!isExtraFeeOpen\(batch\)\)/.test(svc) && /batch\?\.extra_fee_enabled\) return true/.test(svc) && /now\.getTime\(\) >= start/.test(svc));
check("start date is 15 Oct 2026 IST", /2026-10-15T00:00:00\+05:30/.test(svc));
// behaviour of the gate itself
{
  const m = svc.match(/export function isExtraFeeOpen[\s\S]*?\n}\n/);
  const src = m[0].replace(/export /, "").replace(/: \{[^)]*\} \| null \| undefined/, "").replace(/now: Date = new Date\(\)/, "now = new Date()").replace(/\): boolean/, ")");
  const open = new Function(src + "; return isExtraFeeOpen;")();
  const start = "2026-10-15T00:00:00+05:30";
  check("closed the day before", !open({ extra_fee_starts_at: start }, new Date("2026-10-14T18:29:00Z")));
  check("open at midnight IST on the 15th", open({ extra_fee_starts_at: start }, new Date("2026-10-14T18:30:00Z")));
  check("admin can open it early", open({ extra_fee_enabled: true, extra_fee_starts_at: start }, new Date("2026-10-05T00:00:00Z")));
  check("no date and not switched on stays closed", !open({}, new Date("2030-01-01")));
}
check("students who paid the old full amount are not charged again", /Number\(main\.amount\) >= Number\(batch\?\.fee_amount \?\? 0\) \+ amount/.test(svc));
check("amount always comes from the server", /Math\.round\(state\.amount \* 100\)/.test(create) && !/body\?\.amount/.test(create));
check("create-order respects the gateway switch", /isRazorpayEnabled\(db\)/.test(create));
check("settle checks the captured amount", /captured\.amountPaise !== expected/.test(svc));
check("settle is idempotent (one winner)", /\.neq\("status", "paid"\)\.select\("id"\)/.test(svc));
check("verify checks signature and ownership", /verifyRazorpayPaymentSignature/.test(verify) && /row\.student_id !== user\.profileId/.test(verify));
check("webhook settles extra-fee orders", /extra_fee_payments[\s\S]{0,500}settleExtraFeeOrder/.test(hook));
check("Payments tab stays while the second payment is due", /nothingToPay = isApproved && !extraFeeDue/.test(data));

const page = read("src/app/payments/page.tsx");
check("order shows item 2 before it is payable (status later)", /status: "later"/.test(svc) && /extraFee\.status !== "none"/.test(page));
check("exempt students do not see item 2 at all", /paid_in_full_earlier/.test(svc) && !/reason: "paid_in_full_earlier", status/.test(svc));
check("order lists both items with a total", /Your order/.test(page) && /Total ₹/.test(page));
check("a batch that takes no payments puts no order on students who have not paid item 1", /batch\?\.status !== "active"/.test(svc) && svc.indexOf('batch?.status !== "active"') < svc.indexOf("if (!isExtraFeeOpen(batch))"));

// ---- getExtraFeeState itself, against a fake database (2026-10-12) -------------------------
// Every batch in production carries a second-payment amount, including closed ones, so what a
// student sees must follow from their own batch + payments, not from the amount alone.
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const svcPath = path.resolve(__dirname, "../src/lib/services/extra-fee.ts");
const real = jiti("../src/lib/services/extra-fee.ts");
// 2026-10-15: the second payment opens only when THE CHECK passes (UPI_MDR_ACTIVE — NPCI deferred the 0.4%
// UPI charge it exists to avoid, so it is off). The rules below must stay right for the day the charge lands,
// so they run against the SAME source with the check on, evaluated in memory; the check itself is tested at the end.
const rulesSrc = svc.replace(/export const UPI_MDR_ACTIVE = false;/, "export const UPI_MDR_ACTIVE = true;");
const { getExtraFeeState } = real.UPI_MDR_ACTIVE ? real : jiti.evalModule(rulesSrc, { filename: svcPath, ext: ".ts" });
check("rule tests run with the MDR check on", rulesSrc !== svc || real.UPI_MDR_ACTIVE);

function fakeDb({ batch, paidExtra = null, approved = null }) {
  const tables = { profiles: { batch_id: batch ? batch.id : null }, batches: batch, extra_fee_payments: paidExtra, payments: approved };
  return {
    from(table) {
      const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: tables[table] ?? null }) };
      return q;
    },
  };
}
const B = (over = {}) => ({ id: "b1", status: "active", fee_amount: "1100.00", extra_fee_amount: "1100", extra_fee_label: null, extra_fee_note: null, extra_fee_enabled: false, extra_fee_starts_at: null, ...over });
const stateOf = (opts) => getExtraFeeState(fakeDb(opts), "student-1");
const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";

(async () => {
  let s;

  // Unpaid students of a batch that takes no payments have no order at all.
  s = await stateOf({ batch: B({ status: "closed" }) });
  check("closed batch, unpaid, nothing scheduled: no order", s.status === "none" && !s.applies && !s.due && s.reason === "off");
  s = await stateOf({ batch: B({ status: "closed", extra_fee_enabled: true, extra_fee_starts_at: PAST }) });
  check("closed batch, unpaid, even if scheduled: no order (item 1 can never be paid)", s.status === "none" && !s.due);
  for (const status of ["archived", "paused", "full", "pending_setup"]) {
    s = await stateOf({ batch: B({ status }) });
    check(`${status} batch, unpaid: no order`, s.status === "none" && !s.due);
  }

  // Students who already paid item 1 keep every rule they had.
  s = await stateOf({ batch: B({ status: "closed" }), approved: { amount: "2200.00" } });
  check("closed batch, paid the old full amount: still exempt", s.status === "none" && s.reason === "paid_in_full_earlier");
  s = await stateOf({ batch: B({ status: "closed", extra_fee_enabled: true }), approved: { amount: "1100.00" } });
  check("closed batch, paid item 1 only, item 2 switched on: it is due", s.status === "due" && s.due && s.applies);
  s = await stateOf({ batch: B({ status: "closed" }), approved: { amount: "1100.00" } });
  check("closed batch, paid item 1 only, item 2 not scheduled: stays on the order as 'later'", s.status === "later" && !s.due);
  s = await stateOf({ batch: B({ status: "closed" }), paidExtra: { paid_at: "2026-10-01T00:00:00Z" }, approved: { amount: "1100.00" } });
  check("closed batch, item 2 already paid: paid", s.status === "paid" && s.paid);

  // Active batches behave exactly as before.
  s = await stateOf({ batch: B() });
  check("active batch, unpaid, nothing scheduled: item 2 shown as 'later'", s.status === "later" && s.reason === "off" && !s.due);
  s = await stateOf({ batch: B({ extra_fee_starts_at: FUTURE }) });
  check("active batch, unpaid, opens in the future: 'later'", s.status === "later" && !s.due);
  s = await stateOf({ batch: B({ extra_fee_starts_at: PAST }) });
  check("active batch, unpaid, start date passed: 'later' until item 1 is paid", s.status === "later" && s.reason === "main_not_paid" && !s.due);
  s = await stateOf({ batch: B({ extra_fee_starts_at: PAST }), approved: { amount: "1100.00" } });
  check("active batch, paid item 1, start date passed: due", s.status === "due" && s.due && s.applies);
  s = await stateOf({ batch: B({ extra_fee_starts_at: PAST }), approved: { amount: "2200.00" } });
  check("active batch, paid the old full amount: exempt", s.status === "none" && s.reason === "paid_in_full_earlier");
  s = await stateOf({ batch: B({ extra_fee_amount: null }) });
  check("no second-payment amount: nothing on the order", s.status === "none" && s.reason === "off" && !s.amount);
  // THE CHECK, part 2: the ₹2,000 threshold on the TOTAL fee.
  s = await stateOf({ batch: B({ fee_amount: "1100.00", extra_fee_amount: "100" }) });
  check("total 1200 under the threshold: no split even with the charge live", s.status === "none" && s.reason === "off" && !s.applies);
  s = await stateOf({ batch: B({ fee_amount: "1900.00", extra_fee_amount: "100" }) });
  check("total exactly 2000: no split (charge is strictly above 2000)", s.status === "none" && s.reason === "off");
  s = await stateOf({ batch: B({ fee_amount: "1100.00", extra_fee_amount: "1100" }) });
  check("total 2200 over the threshold: rules apply normally", s.status === "later" && s.reason === "off");
  s = await stateOf({ batch: null });
  check("student without a batch: nothing on the order", s.status === "none" && s.reason === "no_batch");

  // THE CHECK, part 1: while UPI_MDR_ACTIVE is off (NPCI deferred the charge), nobody has a second
  // payment, whatever their batch or payments say (no one has paid one yet — extra_fee_payments is empty —
  // so nothing is hidden). An admin forcing extra_fee_enabled bypasses the check.
  if (!real.UPI_MDR_ACTIVE) {
    const withSwitch = (opts) => real.getExtraFeeState(fakeDb(opts), "student-1");
    const cases = [
      ["open batch, item 1 paid, start date passed", { batch: B({ extra_fee_starts_at: PAST }), approved: { amount: "1100.00" } }],
      ["closed batch, item 1 paid", { batch: B({ status: "closed" }), approved: { amount: "1100.00" } }],
      ["open batch, nothing paid yet", { batch: B() }],
    ];
    for (const [label, opts] of cases) {
      s = await withSwitch(opts);
      check(`charge off: ${label}: no second payment`, s.status === "none" && !s.due && !s.applies && s.reason === "off");
    }
    // (An admin opening it early is NOT in the list above: that is the bypass, asserted here.)
    s = await withSwitch({ batch: B({ extra_fee_enabled: true }), approved: { amount: "1100.00" } });
    check("charge off, admin forced it on: second payment is due (bypass works)", s.status === "due" && s.due && s.applies);
  }

  console.log(`test-extra-fee: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });

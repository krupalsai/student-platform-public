"use client";

// Legacy Razorpay URLs stay on the same payment screen instead of redirecting
// to /pay/[slug]. This makes /pay/razorpay/[slug] a compatibility alias with
// no server redirect, so it cannot participate in a /pay <-> /pay/razorpay loop.
import PayPage from "../../[slug]/page";

export default function LegacyRazorpayPayPage() {
  return <PayPage />;
}

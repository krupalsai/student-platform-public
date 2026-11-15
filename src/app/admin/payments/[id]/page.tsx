"use client";
import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";

function Row({ label, value, mono = false }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-4 py-3 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-400 font-medium">{label}</span>
      <span className={`text-sm text-right text-gray-800 font-semibold break-all ${mono ? "font-mono" : ""}`}>{String(value)}</span>
    </div>
  );
}

export default function AdminPaymentDetail() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [pay, setPay] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  const load = () => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/admin/payments/${id}`, { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => { if (j.success) setPay(j.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="min-h-screen bg-gray-50 p-4"><div className="h-40 bg-gray-200 rounded-2xl animate-pulse" /></div>;

  if (!pay) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="font-semibold text-gray-700">Payment not found</p>
      <button onClick={() => router.back()} className="px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold">Back</button>
    </div>
  );

  const approved = pay.payment_status === "approved";
  const failed = pay.payment_status === "pg_failed";
  // `spot` (registered in person, entered by an admin) is handled by a human
  // exactly like manual UPI is — it must not claim automatic verification.
  const manual = pay.payment_method === "upi_manual" || pay.payment_method === "spot";
  const razorpay = pay.payment_method === "razorpay";

  const statusTitle = approved
    // Item #97 fixed the banner below to stop claiming automatic verification
    // for a payment a human actually reviewed, but left this title saying it
    // for every approved payment regardless of method. Same fix, same reason.
    ? (manual ? "Payment approved by an admin" : "Payment approved automatically")
    : failed
      ? "Payment failed"
      : "Payment processing";

  const statusMessage = approved
    ? (manual ? "Reviewed and approved by an admin." : "Razorpay payment was verified and approved automatically.")
    : failed
      ? (pay.review_notes || "Razorpay could not verify this payment. No approval was recorded.")
      : (razorpay ? "Razorpay is confirming this payment. The status will update automatically." : "Payment is being verified. The status will update automatically.");

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 px-4 pt-10 pb-6">
        <button onClick={() => router.back()} className="mb-5 rounded-xl bg-white/15 border border-white/25 px-3 py-2 text-white text-sm font-bold">← Back</button>
        <div className="flex justify-between items-start gap-3">
          <div>
            <p className="text-white font-black text-xl">{pay.full_name ?? "Student"}</p>
            <p className="text-blue-100 text-sm mt-1">{[pay.college, pay.branch, pay.batch_name].filter(Boolean).join(" · ")}</p>
          </div>
          <p className="text-white font-black text-2xl">₹{Number(pay.amount ?? 0).toLocaleString("en-IN")}</p>
        </div>
      </div>

      <div className="px-4 mt-4 space-y-3">
        <div className={`rounded-2xl p-4 border ${approved ? "bg-emerald-50 border-emerald-200" : failed ? "bg-red-50 border-red-200" : "bg-blue-50 border-blue-200"}`}>
          <div className="flex items-center gap-2">
            {approved ? <CheckCircle2 size={18} className="text-emerald-600" /> : failed ? <XCircle size={18} className="text-red-600" /> : <RefreshCw size={18} className="text-blue-600" />}
            <p className={`font-bold text-sm ${approved ? "text-emerald-800" : failed ? "text-red-800" : "text-blue-800"}`}>
              {statusTitle}
            </p>
          </div>
          <p className="text-xs mt-2 text-gray-600">{statusMessage}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm px-4">
          <Row label="Order ID" value={pay.razorpay_order_id ?? pay.cashfree_order_id ?? pay.phonepe_merchant_txn_id} mono />
          <Row label="Payment ID" value={pay.razorpay_payment_id ?? pay.cashfree_payment_id} mono />
          <Row label="UTR / Bank Reference" value={pay.utr_number} mono />
          <Row label="Student" value={pay.full_name} />
          <Row label="Roll Number" value={pay.roll_number} mono />
          <Row label="Phone" value={pay.phone} />
          <Row label="Batch" value={pay.batch_name} />
          <Row label="Amount" value={`₹${Number(pay.amount ?? 0).toLocaleString("en-IN")}`} />
          <Row label="Payment Status" value={pay.payment_status} />
          <Row label="Created" value={pay.created_at ? new Date(pay.created_at).toLocaleString("en-IN") : null} />
          <Row label="Processed" value={pay.submitted_at ? new Date(pay.submitted_at).toLocaleString("en-IN") : null} />
        </div>

        {!approved && !failed && (
          <button onClick={load} className="w-full py-3 rounded-xl bg-gray-900 text-white text-sm font-bold">
            Refresh status
          </button>
        )}
      </div>
    </div>
  );
}

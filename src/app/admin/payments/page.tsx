"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Inbox, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

const TABS = [
  { key: "all", label: "All" },
  { key: "approved", label: "Approved" },
  { key: "pg_failed", label: "Failed" },
];

const GATEWAY_LABEL: Record<string, string> = {
  cashfree: "Cashfree",
  phonepe: "PhonePe",
  upi_manual: "Manual UPI",
  spot: "Paid at spot",
};

function gatewayLabel(method: string | null | undefined) {
  return GATEWAY_LABEL[method ?? ""] ?? "Payment";
}

function reference(p: any) {
  return p.cashfree_order_id ?? p.phonepe_merchant_txn_id ?? p.utr_number ?? "—";
}

export default function AdminPayments() {
  const router = useRouter();
  const [payments, setPayments] = useState<any[]>([]);
  const [batches, setBatches] = useState<{ id: string; name: string; college: string }[]>([]);
  const [batchId, setBatchId] = useState("");     // "" = every batch
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  // Batch list for the filter chips. The API has always accepted batch_id
  // (item #80) — the chip row that used it was lost when this page was
  // rewritten during the Cashfree migration, leaving one flat list pooling
  // every batch together, which is what made it read as random.
  useEffect(() => {
    fetch("/api/admin/batches", { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => { if (j.success) setBatches(j.data ?? []); })
      .catch(() => {});
  }, []);

  const load = useCallback((silent = false) => {
    silent ? setRefreshing(true) : setLoading(true);
    const params = new URLSearchParams({ status: tab, q });
    if (batchId) params.set("batch_id", batchId);
    fetch(`/api/admin/payments?${params.toString()}`, { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        setPayments(j.success ? (j.data?.payments ?? []) : []);
        setLastUpdated(new Date());
      })
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [tab, q, batchId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => load(true), 20000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 px-4 pt-10 pb-4 sticky top-0 z-20">
        <button onClick={() => router.back()} className="mb-4 rounded-xl bg-white/15 border border-white/25 px-3 py-2 text-white text-sm font-bold">← Back</button>
        <h1 className="text-white text-xl font-bold">Payment History</h1>
        <p className="text-blue-100 text-xs mt-1">Cashfree, PhonePe & manual UPI</p>
        <div className="relative mt-4">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Name, roll number, reference…" className="w-full bg-white rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none" />
        </div>
      </div>

      <div className="sticky top-[150px] z-10 bg-gray-50 border-b border-gray-100">
        {/* Batch first, status second — an admin thinks in batches ("how is
            GNITC Batch 1 doing"), not in one pooled platform-wide ledger. */}
        <div className="flex gap-2 px-4 pt-2 overflow-x-auto">
          <button onClick={() => setBatchId("")} className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${batchId === "" ? "bg-gray-900 text-white" : "bg-white text-gray-500 border border-gray-200"}`}>
            All Batches
          </button>
          {batches.map(b => (
            <button key={b.id} onClick={() => setBatchId(b.id)} className={`px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${batchId === b.id ? "bg-gray-900 text-white" : "bg-white text-gray-500 border border-gray-200"}`}>
              {b.name}
            </button>
          ))}
        </div>
        <div className="flex gap-2 px-4 py-2 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} className={`px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap ${tab === t.key ? "bg-blue-600 text-white" : "bg-white text-gray-500 border border-gray-200"}`}>
              {t.label}
            </button>
          ))}
          <button onClick={() => load(true)} disabled={refreshing} className="ml-auto px-3 rounded-full bg-white border border-gray-200 text-gray-500">
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="px-4 py-2 text-xs text-gray-400 flex justify-between">
        <span>{loading ? "Loading…" : `${payments.length} record${payments.length === 1 ? "" : "s"}`}</span>
        {lastUpdated && <span>Updated {lastUpdated.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>}
      </div>

      <div className="px-4 pb-8 space-y-3">
        {loading && [1,2,3].map(i => <div key={i} className="h-28 bg-white rounded-2xl animate-pulse" />)}
        {!loading && payments.length === 0 && (
          <div className="text-center py-16">
            <Inbox size={36} className="mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500 font-semibold">No payments</p>
            <p className="text-gray-400 text-sm mt-1">Payments will appear here automatically.</p>
          </div>
        )}
        {!loading && (batchId ? payments : groupByBatch(payments)).map((group: any) =>
          batchId ? null : (
            <div key={group.name} className="pt-1">
              {/* Batch heading — the list is organised by batch instead of one
                  undifferentiated stream of every payment on the platform. */}
              <div className="flex items-baseline justify-between px-1 pb-2">
                <p className="text-sm font-extrabold text-gray-800">{group.name}</p>
                <p className="text-xs text-gray-400">
                  {group.rows.length} · ₹{group.total.toLocaleString("en-IN")}
                </p>
              </div>
              <div className="space-y-3">{group.rows.map(renderCard)}</div>
            </div>
          )
        )}
        {!loading && batchId && payments.map(renderCard)}
      </div>
    </div>
  );

  function renderCard(p: any) {
          const approved = p.payment_status === "approved";
          const gateway = gatewayLabel(p.payment_method);
          // upi_manual is admin-reviewed (item #73) and `spot` was collected in
          // person and entered by hand — only Cashfree/PhonePe are ever
          // auto-approved by a webhook. Don't claim "automatically" for a
          // payment a human actually handled.
          const byHand = p.payment_method === "upi_manual" || p.payment_method === "spot";
          const approvedLabel = byHand ? "Approved by admin" : "Approved automatically";
          return (
            <button key={p.payment_id} onClick={() => router.push(`/admin/payments/${p.payment_id}`)} className="w-full bg-white rounded-2xl shadow-sm text-left p-4 active:scale-[0.98] transition-transform">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-gray-800 text-sm truncate">{p.full_name ?? "Student"}</p>
                  <p className="text-xs text-gray-400 mt-1">{[p.college, p.branch, p.batch_name].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-black text-blue-600">₹{Number(p.amount ?? 0).toLocaleString("en-IN")}</p>
                  <span className={`inline-flex items-center gap-1 mt-1 text-xs px-2 py-1 rounded-full font-semibold ${approved ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
                    {approved ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    {approved ? approvedLabel : "Payment failed"}
                  </span>
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-400 flex justify-between">
                <span className="font-mono truncate">{gateway} · {reference(p)}</span>
                {p.submitted_at && <span>{new Date(p.submitted_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>}
              </div>
            </button>
          );
  }
}

/**
 * Groups payments under their batch, newest batch first, so the list reads as
 * "GNITC Batch 1: these, GNIT Batch 2: those" rather than one undifferentiated
 * stream. Order within a group is left exactly as the API returned it.
 */
function groupByBatch(rows: any[]): { name: string; rows: any[]; total: number }[] {
  const groups = new Map<string, { name: string; rows: any[]; total: number }>();
  for (const p of rows) {
    const name = p.batch_name ?? "No batch";
    const g = groups.get(name) ?? { name, rows: [] as any[], total: 0 };
    g.rows.push(p);
    // Only approved money is real money collected — a failed attempt must not
    // inflate a batch's total.
    if (p.payment_status === "approved") g.total += Number(p.amount ?? 0);
    groups.set(name, g);
  }
  return [...groups.values()];
}

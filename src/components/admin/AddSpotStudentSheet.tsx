"use client";

import { useEffect, useState } from "react";
import { X, UserPlus, ChevronDown, Loader2 } from "lucide-react";

type Batch = { id: string; name: string; college: string; status: string; fee_amount: number | string | null };

/**
 * Add a student who registered in person ("at spot").
 *
 * They paid the fee at the desk and sent their details over WhatsApp, so an
 * admin has exactly three facts: name, phone, batch. College is deliberately
 * NOT a separate field — every batch belongs to exactly one college and its
 * own name already says which ("GNIT Batch 1"), so picking a college first
 * was a redundant step; the batch list below is grouped by college instead,
 * and the server derives college from whichever batch is picked. Everything
 * the normal registration form demands is optional here — the student can
 * fill the rest in later through Correction.
 */
function authHeader(): Record<string, string> {
  const token = typeof window === "undefined" ? "" : localStorage.getItem("sp_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AddSpotStudentSheet({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (message: string, ok: boolean) => void;
}) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(false);

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [batchId, setBatchId] = useState("");

  const [markPaid, setMarkPaid] = useState(true);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const [showOptional, setShowOptional] = useState(false);
  const [fatherName, setFatherName] = useState("");
  const [rollNumber, setRollNumber] = useState("");
  const [branch, setBranch] = useState("");
  const [year, setYear] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One fetch, every college's batches at once — there's no college picker
  // upstream of this any more, so nothing to key the fetch on.
  useEffect(() => {
    if (!open) return;
    setLoadingBatches(true);
    fetch("/api/admin/batches", { cache: "no-store", headers: authHeader() })
      .then(r => r.json())
      .then(j => setBatches(j?.success ? j.data ?? [] : []))
      .catch(() => setBatches([]))
      .finally(() => setLoadingBatches(false));
  }, [open]);

  // Grouped by college for the <optgroup>s below, colleges in first-seen
  // order (the API already returns newest-created batch first).
  const batchesByCollege: Array<[string, Batch[]]> = [];
  for (const b of batches) {
    let group = batchesByCollege.find(([c]) => c === b.college);
    if (!group) { group = [b.college, []]; batchesByCollege.push(group); }
    group[1].push(b);
  }

  const selectedBatch = batches.find(b => b.id === batchId) ?? null;
  // Rule 4: fee_amount is NUMERIC and comes back as a string.
  const batchFee = selectedBatch?.fee_amount != null ? Number(selectedBatch.fee_amount) : null;

  useEffect(() => {
    if (batchFee != null && batchFee > 0) setAmount(String(Math.round(batchFee)));
  }, [batchFee]);

  function reset() {
    setFullName(""); setPhone(""); setBatchId("");
    setMarkPaid(true); setAmount(""); setNote("");
    setShowOptional(false); setFatherName(""); setRollNumber(""); setBranch(""); setYear("");
    setError(null);
  }

  const phoneOk = /^[6-9]\d{9}$/.test(phone.trim());
  const canSubmit = fullName.trim().length >= 2 && phoneOk && !!batchId && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/students", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName.trim(),
          phone: phone.trim(),
          batch_id: batchId,
          mark_paid: markPaid,
          ...(markPaid && amount ? { amount: Number(amount) } : {}),
          ...(markPaid && note.trim() ? { payment_note: note.trim() } : {}),
          ...(fatherName.trim() ? { father_name: fatherName.trim() } : {}),
          ...(rollNumber.trim() ? { roll_number: rollNumber.trim() } : {}),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
          ...(year.trim() ? { year: year.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? "Could not add the student.");

      // Report what ACTUALLY happened. The student can be created while the
      // payment is not (an unset batch fee, for one), and an admin who is told
      // "added and paid" when only half of that is true will not go and fix it.
      const p = json.data?.payment;
      let msg = `${fullName.trim()} added to ${json.data?.batch?.name ?? "the batch"}`;
      if (p?.error) msg += ` — ${p.error}`;
      else if (p?.approved) msg += ` and marked paid${p.amount ? ` (₹${Math.round(p.amount)})` : ""}`;
      onCreated(msg, !p?.error);
      reset();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const inputCls = "w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400";
  const labelCls = "block text-xs font-semibold text-gray-500 mb-1";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a student who registered at spot"
      className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/45"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md bg-gray-50 rounded-t-2xl max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: "calc(20px + env(safe-area-inset-bottom,0px))" }}
      >
        <div className="sticky top-0 bg-gray-50 px-4 pt-4 pb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-gray-900">Add student</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              For someone who registered in person and paid at the spot.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 p-1">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="px-4 space-y-3">
          <div>
            <label className={labelCls} htmlFor="spot-batch">Batch</label>
            <select id="spot-batch" value={batchId} onChange={e => setBatchId(e.target.value)}
              disabled={loadingBatches} className={inputCls}>
              <option value="">{loadingBatches ? "Loading…" : "Select batch"}</option>
              {batchesByCollege.map(([collegeName, group]) => (
                <optgroup key={collegeName} label={collegeName}>
                  {group.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.status !== "active" ? ` · ${b.status}` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              Just the batch — college is whichever one it belongs to.
            </p>
          </div>

          <div>
            <label className={labelCls} htmlFor="spot-name">Full name</label>
            <input id="spot-name" value={fullName} onChange={e => setFullName(e.target.value)}
              placeholder="As they gave it on WhatsApp" className={inputCls} />
          </div>

          <div>
            <label className={labelCls} htmlFor="spot-phone">Mobile number</label>
            <input id="spot-phone" value={phone} inputMode="numeric" maxLength={10}
              onChange={e => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="10-digit number" className={inputCls} />
            <p className="text-[11px] text-gray-400 mt-1">
              This is how they sign in to the app, so it must be their own number.
            </p>
          </div>

          <div className="bg-white rounded-xl p-3.5 border border-gray-200">
            <label className="flex items-center justify-between cursor-pointer">
              <span>
                <span className="text-sm font-semibold text-gray-800">Paid at spot</span>
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  Records the fee as received, so they count as paid and appear in the batch export.
                </span>
              </span>
              <input type="checkbox" checked={markPaid} onChange={e => setMarkPaid(e.target.checked)}
                className="w-5 h-5 accent-blue-600 shrink-0 ml-3" />
            </label>

            {markPaid && (
              <div className="mt-3 space-y-2.5 pt-3 border-t border-gray-100">
                <div>
                  <label className={labelCls} htmlFor="spot-amount">Amount (₹)</label>
                  <input id="spot-amount" value={amount} inputMode="numeric"
                    onChange={e => setAmount(e.target.value.replace(/\D/g, ""))}
                    placeholder={batchFee != null ? String(Math.round(batchFee)) : "Batch fee"} className={inputCls} />
                  {batchId && (batchFee == null || batchFee <= 0) && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      This batch has no fee set yet — the payment cannot be recorded until it does.
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelCls} htmlFor="spot-note">Reference (optional)</label>
                  <input id="spot-note" value={note} onChange={e => setNote(e.target.value)}
                    placeholder="Receipt no., cash, who collected it…" className={inputCls} />
                </div>
              </div>
            )}
          </div>

          <button onClick={() => setShowOptional(v => !v)}
            className="w-full flex items-center justify-between bg-white border border-gray-200 rounded-xl px-3.5 py-2.5">
            <span className="text-sm font-semibold text-gray-700">Other details (optional)</span>
            <ChevronDown size={16} strokeWidth={2}
              className={`text-gray-400 transition-transform ${showOptional ? "rotate-180" : ""}`} />
          </button>

          {showOptional && (
            <div className="space-y-3">
              <p className="text-[11px] text-gray-500 -mt-1">
                Leave blank if you don&apos;t have it. The student can add these later from the app.
              </p>
              <div><label className={labelCls} htmlFor="spot-father">Father&apos;s name</label>
                <input id="spot-father" value={fatherName} onChange={e => setFatherName(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls} htmlFor="spot-roll">Roll number</label>
                <input id="spot-roll" value={rollNumber} onChange={e => setRollNumber(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls} htmlFor="spot-branch">Branch</label>
                <input id="spot-branch" value={branch} onChange={e => setBranch(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls} htmlFor="spot-year">Year</label>
                <input id="spot-year" value={year} onChange={e => setYear(e.target.value)} className={inputCls} /></div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3.5 py-3">
              <p className="text-xs text-red-700 leading-relaxed">{error}</p>
            </div>
          )}

          <button onClick={submit} disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 disabled:bg-gray-300 text-white rounded-xl py-3 font-semibold text-sm">
            {saving ? <><Loader2 size={16} className="animate-spin" /> Adding…</> : <><UserPlus size={16} strokeWidth={2} /> Add student</>}
          </button>
        </div>
      </div>
    </div>
  );
}

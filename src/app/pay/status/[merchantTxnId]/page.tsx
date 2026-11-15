"use client";
import React from "react";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";

type Status = "checking" | "approved" | "submitted" | "pg_failed" | "pg_pending" | "error";

/* ─── Confetti burst ─────────────────────────────────────────────────────── */
function Confetti() {
  const colors = ["#22c55e","#16a34a","#4ade80","#fbbf24","#6ee7b7","#60a5fa","#34d399"];
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {[...Array(24)].map((_, i) => {
        const angle = (i / 24) * 360;
        const dist  = 90 + (i % 4) * 35;
        const size  = 6 + (i % 5) * 2;
        return (
          <div key={i} style={{
            position: "absolute", top: "38%", left: "50%",
            width: size, height: size,
            borderRadius: i % 3 === 0 ? "50%" : "3px",
            background: colors[i % colors.length],
            transform: `translate(calc(-50% + ${Math.cos(angle * Math.PI / 180) * dist}px), calc(-50% + ${Math.sin(angle * Math.PI / 180) * dist}px))`,
            animation: `confettiFly 1s ease-out ${(i % 6) * 0.06}s both`,
          }} />
        );
      })}
      <style>{`
        @keyframes confettiFly {
          from { opacity:1; transform: translate(-50%,-50%) scale(0); }
          to   { opacity:0; }
        }
      `}</style>
    </div>
  );
}

/* ─── Success Screen ─────────────────────────────────────────────────────── */
function SuccessScreen({ amount }: { amount: number | null }) {
  const [phase, setPhase] = useState<"ring"|"tick"|"burst"|"done">("ring");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("tick"),  400);
    const t2 = setTimeout(() => setPhase("burst"), 900);
    const t3 = setTimeout(() => setPhase("done"),  1800);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white">
      {phase === "burst" || phase === "done" ? <Confetti /> : null}

      {/* Animated checkmark */}
      <div className="relative z-10 flex items-center justify-center rounded-full transition-all duration-500"
        style={{
          width: phase === "ring" ? 80 : 128,
          height: phase === "ring" ? 80 : 128,
          background: phase === "ring"
            ? "linear-gradient(135deg,#d1fae5,#a7f3d0)"
            : "linear-gradient(135deg,#16a34a,#22c55e)",
          boxShadow: phase !== "ring"
            ? "0 0 0 14px rgba(34,197,94,0.12),0 0 0 28px rgba(34,197,94,0.06)"
            : "none",
        }}>
        <svg width={phase === "ring" ? 36 : 60} height={phase === "ring" ? 36 : 60}
          viewBox="0 0 60 60" fill="none"
          style={{ transition: "all 0.4s cubic-bezier(0.34,1.56,0.64,1)" }}>
          <polyline points="12,30 26,44 48,16" stroke="white" strokeWidth={5.5}
            strokeLinecap="round" strokeLinejoin="round" fill="none"
            style={{
              strokeDasharray: 70,
              strokeDashoffset: phase === "ring" ? 70 : 0,
              transition: "stroke-dashoffset 0.5s cubic-bezier(0.4,0,0.2,1) 0.3s",
            }} />
        </svg>
      </div>

      {/* Text */}
      <div className="z-10 text-center px-8 mt-8"
        style={{
          opacity: phase === "done" ? 1 : 0,
          transform: phase === "done" ? "translateY(0)" : "translateY(14px)",
          transition: "all 0.5s ease",
        }}>
        <h1 className="text-2xl font-black text-gray-900">Payment Successful!</h1>
        {amount != null && (
          <p className="text-3xl font-black text-emerald-600 mt-1">
            ₹{amount.toLocaleString("en-IN")}
          </p>
        )}
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          Your registration is complete! 🎉<br />
          Tap below to open your dashboard.
        </p>
      </div>

      {/* CTA — always visible once animation is done */}
      <div className="z-10 mt-8 flex flex-col items-center gap-3"
        style={{
          opacity: phase === "done" ? 1 : 0,
          transform: phase === "done" ? "translateY(0)" : "translateY(16px)",
          transition: "all 0.5s ease 0.3s",
          pointerEvents: phase === "done" ? "auto" : "none",
        }}>

        <button
          onClick={() => { window.location.href = "/dashboard"; }}
          className="flex items-center gap-2 text-white font-bold px-8 py-4 rounded-2xl active:scale-95 transition-transform shadow-lg"
          style={{ background: "#1d4ed8", minWidth: 240 }}
        >
          Go to Dashboard →
        </button>
      </div>
    </div>
  );
}

/* ─── Status icons ───────────────────────────────────────────────────────── */
const IconClock = () => (
  <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
    <circle cx="28" cy="28" r="28" fill="#fef3c7"/>
    <circle cx="28" cy="28" r="18" stroke="#f59e0b" strokeWidth="3" fill="none"/>
    <path d="M28 18v10l7 5" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
);
const IconFail = () => (
  <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
    <circle cx="28" cy="28" r="28" fill="#fee2e2"/>
    <circle cx="28" cy="28" r="18" stroke="#ef4444" strokeWidth="3" fill="none"/>
    <path d="M21 21l14 14M35 21l-14 14" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" fill="none"/>
  </svg>
);
const IconSpinner = () => (
  <svg width="56" height="56" viewBox="0 0 56 56" fill="none" className="animate-spin">
    <circle cx="28" cy="28" r="22" stroke="#e0e7ff" strokeWidth="5" fill="none"/>
    <path d="M28 6a22 22 0 0 1 22 22" stroke="#1d4ed8" strokeWidth="5" strokeLinecap="round" fill="none"/>
  </svg>
);

/* ─── Main ───────────────────────────────────────────────────────────────── */
export default function PaymentStatusPage() {
  const params       = useParams() as { merchantTxnId: string };
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>("checking");
  const [amount, setAmount] = useState<number | null>(null);
  const pollCount = useRef(0);
  const maxPolls  = 15; // ~30s

  // Token from localStorage OR from ?t= query param (iOS Safari workaround)
  const getToken = useCallback(() => {
    return localStorage.getItem("sp_token") || searchParams.get("t") || "";
  }, [searchParams]);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      // No auth at all — still show the page, just can't poll. Show a helpful message.
      setStatus("error");
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const gwParam = searchParams.get("gw");
        const gw  = gwParam === "razorpay" ? "razorpay" : gwParam === "phonepe" ? "phonepe" : "cashfree";
        const res  = await fetch(`/api/${gw}/status/${params.merchantTxnId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (cancelled) return;

        if (!json.success) { setStatus("error"); return; }

        const s = json.data?.status as string;
        if (json.data?.amount) setAmount(Number(json.data.amount));

        if (s === "approved")  { setStatus("approved");  return; }
        if (s === "submitted") { setStatus("submitted"); return; }
        if (s === "pg_failed") { setStatus("pg_failed"); return; }

        pollCount.current += 1;
        if (pollCount.current >= maxPolls) { setStatus("pg_pending"); return; }
        timer = setTimeout(poll, 2000);
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [params.merchantTxnId, getToken]);

  /* ── Approved → success screen ─────────────────────────────────────────── */
  if (status === "approved") {
    return <SuccessScreen amount={amount} />;
  }

  /* ── Non-success states ────────────────────────────────────────────────── */
  const states: Record<Exclude<Status,"approved">, { Icon: ()=>React.ReactElement; title: string; sub: string; showReturn: boolean }> = {
    checking: {
      Icon: IconSpinner,
      title: "Verifying payment…",
      sub: "Please wait while we confirm your payment.",
      showReturn: false,
    },
    submitted: {
      Icon: IconClock,
      title: "Payment Received",
      sub: "Your payment is being verified. This usually takes a minute or two. You can return to the app — we'll notify you.",
      showReturn: true,
    },
    pg_pending: {
      Icon: IconClock,
      title: "Still Processing",
      sub: "Your payment is taking a bit longer than usual. Check your dashboard in a few minutes, or contact support if this persists.",
      showReturn: true,
    },
    pg_failed: {
      Icon: IconFail,
      title: "Payment Failed",
      sub: "Your payment could not be completed. Please return to the app and try again.",
      showReturn: true,
    },
    error: {
      Icon: IconFail,
      title: "Something went wrong",
      sub: "We couldn't confirm your payment status. If you completed the payment, check your dashboard — it may have already been recorded.",
      showReturn: true,
    },
  };

  const { Icon, title, sub, showReturn } = states[status as Exclude<Status,"approved">];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-6 text-center">

      <div className={status === "checking" ? "" : ""}>
        <Icon />
      </div>

      <h1 className="text-xl font-black text-gray-900 mt-5">{title}</h1>
      <p className="text-sm text-gray-500 mt-2 max-w-xs leading-relaxed">{sub}</p>

      {/* Always-visible dashboard button once we're past "checking" */}
      {showReturn && (
        <button
          onClick={() => { window.location.href = "/dashboard"; }}
          className="mt-8 flex items-center gap-2 text-white font-bold px-8 py-4 rounded-2xl active:scale-95 transition-transform shadow-md"
          style={{ background: "#1d4ed8", minWidth: 220 }}
        >
          Go to Dashboard
        </button>
      )}

      {status === "pg_failed" && (
        <p className="text-xs text-gray-500 mt-3">
          If any amount was deducted, it will be refunded to your account automatically.
        </p>
      )}

      <p className="text-xs text-gray-500 mt-8 font-mono">Ref: {params.merchantTxnId}</p>
    </div>
  );
}

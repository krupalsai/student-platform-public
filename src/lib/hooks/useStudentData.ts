"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRoleGuard } from "@/lib/hooks/useRoleGuard";

// Neutral-grey + one accent palette (student-ui.ts) — color is reserved for
// real status meaning (success/warning/danger), not decoration, so this
// reads as a calm, premium status chip rather than a rainbow of pills.
export const PAY_STATUS: Record<string, { label: string; dot: string; bg: string; border: string; text: string }> = {
  pending:            { label: "Payment Pending",     dot: "#c9890f", bg: "#fdf6ec", border: "#f3e0bd", text: "#9a5b11" },
  pg_pending:         { label: "Payment In Progress", dot: "#0066cc", bg: "#f2f7fd", border: "#d8e8fa", text: "#0066cc" },
  pg_failed:          { label: "Payment Failed",      dot: "#d7332a", bg: "#fdf1f0", border: "#f6d4d1", text: "#c4281f" },
  submitted:          { label: "Payment Submitted",   dot: "#0066cc", bg: "#f2f7fd", border: "#d8e8fa", text: "#0066cc" },
  approved:           { label: "Payment Approved",    dot: "#1d7a46", bg: "#eef8f1", border: "#cde9d7", text: "#1d7a46" },
  rejected:           { label: "Rejected",            dot: "#d7332a", bg: "#fdf1f0", border: "#f6d4d1", text: "#c4281f" },
  reupload_requested: { label: "Reupload Needed",     dot: "#c9890f", bg: "#fdf6ec", border: "#f3e0bd", text: "#9a5b11" },
};

const isPaymentPromptAnnouncement = (a: any) => {
  const text = `${a?.title ?? ""} ${a?.body ?? ""}`.toLowerCase();
  return /payment\s+(is\s+)?now\s+open|payment\s+required|pay\s+now|tap\s+pay|go\s+to\s+the\s+payments\s+tab|payment.*open.*pay/i.test(text);
};

export function useStudentData() {
  const router = useRouter();
  const [previewToken] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("preview_token") : null
  );
  const previewMode = !!previewToken;
  const { checking } = useRoleGuard("/dashboard");

  const [profile, setProfile] = useState<any>(null);
  const [payment, setPayment] = useState<any>(null);
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [seatProgress, setSeatProgress] = useState<any>(null);
  const [routeMapEnabled, setRouteMapEnabled] = useState(true);
  const [groupChatEnabled, setGroupChatEnabled] = useState(true);
  const [voiceCallsEnabled, setVoiceCallsEnabled] = useState(true);
  const [extraFee, setExtraFee] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isStaff, setIsStaff] = useState(false);

  const h = () => ({ Authorization: `Bearer ${previewToken ?? (typeof window !== "undefined" ? localStorage.getItem("sp_token") : null) ?? ""}` });

  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => { setLoadError(false); setLoading(true); setReloadKey((k) => k + 1); };

  useEffect(() => {
    if (checking) return;
    if (!previewMode && typeof window !== "undefined") {
      const r = localStorage.getItem("sp_role");
      setIsStaff(r === "admin" || r === "super_admin" || r === "viewer");
    }
    if (!previewToken && typeof window !== "undefined" && !localStorage.getItem("sp_token")) { router.replace("/"); return; }

    let cancelled = false;
    // Never throws: a slow or failed request is data ("couldn't load"), not an
    // exception. Before this, ONE failed request among six sent the student to
    // the homepage, and the installed app routed them straight back — a loop
    // that read as "the app is glitching and won't open" (item #239).
    const get = async (url: string, auth: boolean): Promise<{ status: number; json: any } | null> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(url, { headers: auth ? h() : undefined, signal: ctl.signal, cache: "no-store" });
        let json: any = null;
        try { json = await r.json(); } catch { /* non-JSON (e.g. a gateway timeout page) */ }
        return { status: r.status, json };
      } catch { return null; } finally { clearTimeout(timer); }
    };

    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        if (attempt > 0) await new Promise((res) => setTimeout(res, attempt * 2000));
        const [p, pay, ann, seats, settings, extra] = await Promise.all([
          get("/api/profile", true), get("/api/payments/status", true), get("/api/announcements", true),
          get("/api/batches/seat-progress", true), get("/api/settings", false), get("/api/extra-fee", true),
        ]);
        if (cancelled) return;
        // A real rejection of the session: the only reason to leave this screen.
        if (p && (p.status === 401 || p.status === 403)) { router.replace("/"); return; }
        // Essential data missing (network/timeout/5xx): try again, don't leave.
        const essentialOk = !!p?.json?.success && !!pay?.json?.success;
        if (!essentialOk) continue;
        if (p!.json.data.is_profile_complete === false) { router.replace("/register"); return; }
        const nextPayment = pay!.json.data ?? null;
        const nextApproved = nextPayment?.status === "approved";
        const annData: any[] = ann?.json?.success ? (ann.json.data ?? []) : [];
        setProfile(p!.json.data);
        setPayment(nextPayment);
        setAnnouncements(nextApproved ? annData.filter((a: any) => !isPaymentPromptAnnouncement(a)) : annData);
        setSeatProgress(seats?.json?.success ? seats.json.data : null);
        const st = settings?.json?.success ? settings.json.data : null;
        setRouteMapEnabled(st ? st.route_map_enabled !== "false" : true);
        setGroupChatEnabled(st ? st.group_chat_enabled !== "false" : true);
        setVoiceCallsEnabled(st ? st.voice_calls_enabled !== "false" : true);
        setExtraFee(extra?.json?.success ? extra.json.data : null);
        setLoading(false);
        return;
      }
      if (!cancelled) setLoadError(true);
    })();
    return () => { cancelled = true; };
  }, [checking, reloadKey]);

  const batch = profile?.batches;
  const payStatus = payment?.status ?? "pending";
  const ps = PAY_STATUS[payStatus] ?? PAY_STATUS.pending;
  const isApproved = payStatus === "approved";
  const isSubmitted = payStatus === "submitted";
  const isRegisteredWithBatch = !!profile?.is_profile_complete && !!batch;
  // The batch's separate second payment (e.g. ₹200), switched on by an admin.
  const extraFeeDue = !!extraFee?.due;
  // The Payments tab hides once nothing is left to pay.
  const nothingToPay = isApproved && !extraFeeDue;

  // A preview_token is an authenticated, short-lived student session. Treat
  // it exactly like the student's own session for navigation and student-side
  // actions. Never fall back to the admin's localStorage token while previewing.
  function navigate(path: string) {
    if (!previewToken) {
      router.push(path);
      return;
    }
    const separator = path.includes("?") ? "&" : "?";
    router.push(`${path}${separator}preview_token=${encodeURIComponent(previewToken)}`);
  }
  function authHeader() { return h(); }

  return {
    router, previewToken, previewMode, loading, loadError, reload,
    profile, payment, announcements, seatProgress, routeMapEnabled, groupChatEnabled, voiceCallsEnabled,
    batch, payStatus, ps, isApproved, isSubmitted, isRegisteredWithBatch, isStaff,
    extraFee, extraFeeDue, nothingToPay, setExtraFee,
    navigate, authHeader,
  };
}

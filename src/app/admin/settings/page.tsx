"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BellOff, Bell } from "lucide-react";

function Toggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${on ? "bg-blue-600" : "bg-gray-200"} ${disabled ? "opacity-50" : ""}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${on ? "translate-x-6" : "translate-x-0"}`} />
    </button>
  );
}

type GatewayKey = "razorpay" | "cashfree" | "phonepe";

export default function AdminSettings() {
  const router = useRouter();
  const [notify, setNotify] = useState(true);
  const [muted, setMuted] = useState(false);
  // Exactly one (or none) of these three is ever true — see toggleGateway().
  const [razorpay, setRazorpay] = useState(false);
  const [cashfree, setCashfree] = useState(false);
  const [phonepe, setPhonepe] = useState(false);
  const [routeMapEnabled, setRouteMapEnabled] = useState(true);
  const [groupChatEnabled, setGroupChatEnabled] = useState(true);
  const [voiceCallsEnabled, setVoiceCallsEnabled] = useState(true);
  const [paymentAnnouncements, setPaymentAnnouncements] = useState(true);
  const [paymentNudge, setPaymentNudge] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<{ msg: string; ok: boolean; warn?: boolean } | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ msg: string; ok: boolean } | null>(null);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    fetch("/api/admin/settings", { headers: h() }).then(r => r.json()).then(j => {
      if (j.success) {
        setNotify(j.data.payment_notify !== "false");
        setMuted(j.data.payment_notify_muted === "true");
        setRazorpay(j.data.razorpay_enabled === "true");
        setCashfree(j.data.cashfree_enabled === "true");
        setPhonepe(j.data.phonepe_enabled === "true");
        setRouteMapEnabled(j.data.route_map_enabled !== "false");
        setGroupChatEnabled(j.data.group_chat_enabled !== "false");
        setVoiceCallsEnabled(j.data.voice_calls_enabled !== "false");
        setPaymentAnnouncements(j.data.payment_announcements_enabled !== "false");
        setPaymentNudge(j.data.payment_nudge_enabled !== "false");
        if (j.data.pwa_student_icon_url) setIconUrl(j.data.pwa_student_icon_url);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  /**
   * Razorpay / Cashfree / PhonePe are mutually exclusive — exactly one is
   * the live gateway students actually pay through. Turning one ON here
   * turns the other two OFF in the same click, so the admin never ends up
   * in an ambiguous "two are on" state (getActivePaymentGateway() on the
   * server would pick one by priority order in that case, but this UI
   * shouldn't let that state happen in the first place). Tapping the
   * currently-active one again turns it OFF, leaving no gateway live —
   * the explicit "payments unavailable" state, not an accidental one.
   */
  function toggleGateway(which: GatewayKey) {
    const setters: Record<GatewayKey, (v: boolean) => void> = { razorpay: setRazorpay, cashfree: setCashfree, phonepe: setPhonepe };
    const current: Record<GatewayKey, boolean> = { razorpay, cashfree, phonepe };
    const turningOn = !current[which];
    (Object.keys(setters) as GatewayKey[]).forEach(key => setters[key](key === which ? turningOn : false));
  }

  async function save() {
    setMsg(null);
    setSaving(true);
    try {
      const r = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({
          payment_notify: notify,
          payment_notify_muted: muted,
          razorpay_enabled: razorpay,
          cashfree_enabled: cashfree,
          phonepe_enabled: phonepe,
          route_map_enabled: routeMapEnabled,
          group_chat_enabled: groupChatEnabled,
          voice_calls_enabled: voiceCallsEnabled,
          payment_announcements_enabled: paymentAnnouncements,
          payment_nudge_enabled: paymentNudge,
        }),
      });
      const j = await r.json();
      setMsg(j.success ? { msg: "Saved", ok: true } : { msg: j.error ?? "Save failed", ok: false });
    } catch {
      setMsg({ msg: "Network error", ok: false });
    } finally {
      setSaving(false);
    }
  }

  async function reindexFaqs() {
    setReindexMsg(null);
    setReindexing(true);
    try {
      const r = await fetch("/api/admin/faqs/reindex", { method: "POST", headers: h() });
      const j = await r.json();
      setReindexMsg(j.success
        ? { msg: j.data?.enabled === false ? j.data.message : `Indexed ${j.data.embedded}/${j.data.total} FAQ(s) for AI search`, ok: j.data?.enabled !== false, warn: j.data?.enabled === false }
        : { msg: j.error ?? "Failed", ok: false });
    } catch {
      setReindexMsg({ msg: "Network error", ok: false });
    } finally {
      setReindexing(false);
    }
  }

  useEffect(() => {
    if (!selectedFile) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(selectedFile);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [selectedFile]);

  async function uploadIcon() {
    if (!selectedFile) return;
    setUploadMsg(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      const r = await fetch("/api/admin/settings/icon", { method: "POST", headers: h(), body: fd });
      const j = await r.json();
      if (j.success) { setIconUrl(j.data.url); setUploadMsg({ msg: "Icon uploaded", ok: true }); setSelectedFile(null); }
      else setUploadMsg({ msg: j.error, ok: false });
    } catch {
      setUploadMsg({ msg: "Network error", ok: false });
    } finally {
      setUploading(false);
    }
  }

  async function resetIcon() {
    setUploadMsg(null);
    setUploading(true);
    try {
      const r = await fetch("/api/admin/settings/icon", { method: "DELETE", headers: h() });
      const j = await r.json();
      if (j.success) { setIconUrl(null); setUploadMsg({ msg: "Reset to default", ok: true }); }
      else setUploadMsg({ msg: j.error, ok: false });
    } catch {
      setUploadMsg({ msg: "Network error", ok: false });
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const gateways: { key: GatewayKey; label: string; value: boolean }[] = [
    { key: "razorpay", label: "Razorpay", value: razorpay },
    { key: "cashfree", label: "Cashfree", value: cashfree },
    { key: "phonepe", label: "PhonePe", value: phonepe },
  ];
  const noGatewayActive = !razorpay && !cashfree && !phonepe;

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1.5 bg-white/15 border border-white/25 rounded-xl px-2.5 py-1.5 mb-2">← Back</button>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm opacity-75">Payment & app settings</p>
      </div>
      <div className="px-4 mt-5 space-y-4">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">Payment Gateway</p>
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-4">
          {gateways.map(g => (
            <div key={g.key} className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <p className="text-sm font-semibold text-gray-800">{g.label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{g.value ? "This is the live gateway for new payments" : "Off"}</p>
              </div>
              <Toggle on={g.value} onToggle={() => toggleGateway(g.key)} />
            </div>
          ))}
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs text-gray-500">
              Only one of these three can be on at a time — switching one on switches the other two off, so new payments always go through exactly the gateway shown as on here.
              {noGatewayActive && (
                <span className="block mt-1 font-semibold text-amber-700">None is on right now — students cannot pay until you turn one on and save.</span>
              )}
              {" "}Turning a gateway off only affects new payment attempts; orders already in progress and payments already submitted are unaffected.
            </p>
          </div>
        </div>

        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">Student App Features</p>
        {([
          ["Route Map", routeMapEnabled, setRouteMapEnabled],
          ["Batch Discussion", groupChatEnabled, setGroupChatEnabled],
          ["Call an Admin", voiceCallsEnabled, setVoiceCallsEnabled],
          ["Announce Payments in Discussion", paymentAnnouncements, setPaymentAnnouncements],
          ["Nudge Unpaid Students", paymentNudge, setPaymentNudge],
        ] as [string, boolean, (v: (b: boolean) => boolean) => void][]).map(([label, value, setter]) => (
          <div className="bg-white rounded-2xl p-4 shadow-sm" key={label}>
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4"><p className="text-sm font-semibold text-gray-800">{label}</p></div>
              <Toggle on={value} onToggle={() => setter((v: boolean) => !v)} />
            </div>
          </div>
        ))}

        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">Admin Notifications</p>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div><p className="text-sm font-semibold text-gray-800">Payment Alerts</p></div>
            <Toggle on={notify} onToggle={() => setNotify(v => !v)} />
          </div>
          {notify && (
            <div className="flex items-center justify-between pt-3 border-t">
              <div><p className="text-sm font-semibold text-gray-800">{muted ? <><BellOff size={14} className="inline" /> Silent</> : <><Bell size={14} className="inline" /> Sound On</>}</p></div>
              <Toggle on={muted} onToggle={() => setMuted(v => !v)} />
            </div>
          )}
        </div>

        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">AI Assistant</p>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-sm font-semibold">Semantic FAQ Search</p>
          <button onClick={reindexFaqs} disabled={reindexing} className="mt-3 w-full bg-teal-50 text-teal-700 border border-teal-200 py-2.5 rounded-xl font-semibold">
            {reindexing ? "Indexing…" : "Rebuild FAQ search index"}
          </button>
          {reindexMsg && <p className="text-xs mt-2">{reindexMsg.msg}</p>}
        </div>

        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider px-1">App Branding</p>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <div className="flex gap-4">
            <img src={previewUrl ?? iconUrl ?? "/pwa-icon.svg"} alt="Icon preview" className="w-20 h-20 object-cover rounded-md" />
            <div>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setSelectedFile(e.target.files?.[0] ?? null)} />
              <div className="flex gap-2 mt-2">
                <button disabled={!selectedFile || uploading} onClick={uploadIcon}>Upload</button>
                <button disabled={uploading} onClick={resetIcon}>Reset</button>
              </div>
              {uploadMsg && <p className="text-xs mt-2">{uploadMsg.msg}</p>}
            </div>
          </div>
        </div>

        <button onClick={save} disabled={saving} className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold">
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {msg && <p className={`text-sm text-center ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.msg}</p>}
      </div>
    </div>
  );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function AdminLoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [error, setError] = useState("");

  useEffect(() => {
    const otp = params.get("otp");
    if (!otp) {
      setStatus("error");
      setError("Missing login link — open the link from WhatsApp again.");
      return;
    }

    (async () => {
      try {
        const r = await fetch("/api/auth/whatsapp-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otp }),
        });
        const j = await r.json();
        if (!j.success) {
          setStatus("error");
          setError(j.error || "Login failed.");
          return;
        }
        localStorage.setItem("sp_token", j.data.token);
        router.replace("/admin/install");
      } catch {
        setStatus("error");
        setError("Couldn't reach the server — check your connection and try again.");
      }
    })();
  }, [params, router]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-sm p-8 max-w-sm w-full text-center">
        {status === "working" ? (
          <>
            <div className="w-10 h-10 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-gray-500">Logging you in…</p>
          </>
        ) : (
          <>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center text-2xl mx-auto mb-4">❌</div>
            <p className="text-sm font-semibold text-gray-800 mb-1">Couldn't log you in</p>
            <p className="text-xs text-gray-500 leading-relaxed">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="w-10 h-10 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
        </div>
      }
    >
      <AdminLoginInner />
    </Suspense>
  );
}

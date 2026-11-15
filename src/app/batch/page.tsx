"use client";
import { useEffect, useState } from "react";
import RouteMap from "@/components/RouteMap";
import SeatProgressCard from "@/components/student/SeatProgressCard";
import StudentPageHeader from "@/components/student/StudentPageHeader";
import StudentBottomNav from "@/components/student/StudentBottomNav";
import { useStudentData } from "@/lib/hooks/useStudentData";
import { ui } from "@/lib/student-ui";
import LoadFailed from "@/components/student/LoadFailed";

/**
 * Batch tab — administrative info about the student's own batch: status,
 * seat progress toward the petition minimum, and the Certificate Route
 * Map. Court case status is shown on Home only (not repeated here).
 * Everything here already existed on Home (dashboard/page.tsx)
 * before the 5-tab restructure; moved here rather than duplicated so Home
 * can stay a condensed overview. Batch Discussion lives on the Messages
 * tab instead — it's a communication feature, not batch administration,
 * so it isn't duplicated as an entry point on both tabs.
 */
export default function BatchPage() {
  const {
    loading, loadError, reload, profile, batch, ps, previewMode,
    seatProgress, routeMapEnabled, isApproved, authHeader,
  } = useStudentData();

  // Main petitioner for the route-map highlight: checked live from the
  // court's own record per batch (same cached endpoint the case card
  // uses, so this costs no extra court hit).
  const [mainPetitioner, setMainPetitioner] = useState<string | null>(null);
  useEffect(() => {
    if (!batch?.slug || !batch?.case_number) return;
    let cancelled = false;
    fetch(`/api/batches/${batch.slug}/case-status`, { headers: authHeader(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        if (cancelled || !j?.success) return;
        setMainPetitioner(j.data?.available ? (j.data.status?.mainPetitioner ?? null) : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.slug, batch?.case_number]);

  return (
    <main style={{ minHeight: "100vh", background: ui.canvas, paddingBottom: 108 }}>
      {loadError && <LoadFailed onRetry={reload} />}
      <StudentPageHeader title="My Batch" sub="Status, seats, and the certificate route map" />

      <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: ui.surface, borderRadius: ui.radius.card, overflow: "hidden", border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card }}>
          <div style={{ padding: "14px 16px 10px" }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>Batch details</p>
          </div>
          {loading ? (
            <div style={{ padding: "0 16px 14px" }}>
              <div style={{ height: 20, width: "60%", background: ui.canvas, borderRadius: 6, marginBottom: 8 }} />
              <div style={{ height: 14, width: "40%", background: ui.canvas, borderRadius: 6 }} />
            </div>
          ) : !batch ? (
            <div style={{ padding: "16px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: ui.textSecondary, margin: 0 }}>No batch assigned yet</p>
            </div>
          ) : (
            <div style={{ padding: "0 16px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <p style={{ fontSize: 16, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>{batch.name}</p>
                <p style={{ fontSize: 12, color: ui.textTertiary, margin: "4px 0 0" }}>{batch.college}</p>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: ui.radius.pill, background: ps.bg, color: ps.text, border: `1px solid ${ps.border}` }}>{ps.label}</span>
            </div>
          )}
        </div>

        {!loading && seatProgress?.has_batch && seatProgress?.accepting !== false && (
          <SeatProgressCard data={seatProgress} showCount={isApproved} />
        )}

        {!loading && isApproved && profile?.college && routeMapEnabled && (
          <RouteMap
            college={profile.college}
            representative={{ name: batch?.representative_name ?? null, phone: batch?.representative_phone ?? null }}
            mainPetitioner={mainPetitioner}
          />
        )}
      </div>

      <StudentBottomNav previewMode={previewMode} hidePayments={isApproved} />
    </main>
  );
}

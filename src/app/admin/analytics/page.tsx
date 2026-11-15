"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock, AlertTriangle, X, type LucideIcon } from "lucide-react";

type Student = { id: string; name: string; phone: string; college: string; branch: string; roll: string; batch: string };
type Category = { count: number; students: Student[] };

/* ── Student row ────────────────────────────────────────────────────────── */
function StudentRow({ s, accent, onClick }: { s: Student; accent: string; onClick: () => void }) {
  const initials = s.name.split(" ").map(w => w[0]).join("").slice(0,2).toUpperCase();
  return (
    <button onClick={onClick} style={{
      width:"100%", display:"flex", alignItems:"center", gap:12,
      padding:"11px 16px", background:"none", border:"none", cursor:"pointer",
      borderTop:"1px solid #f9fafb", textAlign:"left",
    }}>
      <div style={{
        width:38, height:38, borderRadius:12, flexShrink:0,
        background: accent + "20",
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:13, fontWeight:800, color:accent,
      }}>{initials || "?"}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <p style={{ fontSize:14, fontWeight:700, color:"#111827", margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name}</p>
        <p style={{ fontSize:11, color:"#9ca3af", margin:"2px 0 0" }}>
          {[s.batch, s.branch, s.college].filter(Boolean).join(" · ")}
        </p>
      </div>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  );
}

/* ── Expandable section ─────────────────────────────────────────────────── */
function Section({ Icon, title, sub, count, students, accent, routePath, router }: {
  Icon: LucideIcon; title: string; sub: string; count: number;
  students: Student[]; accent: string; routePath: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div style={{ background:"#fff", borderRadius:18, overflow:"hidden", boxShadow:"0 2px 8px rgba(0,0,0,0.05)" }}>
      {/* Header row — tap to expand */}
      <button onClick={() => setOpen(o => !o)} style={{
        width:"100%", display:"flex", alignItems:"center", gap:14,
        padding:"14px 16px", background:"none", border:"none", cursor:"pointer",
      }}>
        <div style={{ width:44, height:44, borderRadius:14, background:accent+"18", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon size={19} strokeWidth={2} color={accent} /></div>
        <div style={{ flex:1, textAlign:"left" }}>
          <p style={{ fontSize:15, fontWeight:700, color:"#111827", margin:0 }}>
            <span style={{ fontSize:22, fontWeight:700, color:accent, marginRight:6 }}>{count}</span>
            {title}
          </p>
          <p style={{ fontSize:11, color:"#9ca3af", margin:"3px 0 0" }}>{sub}</p>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition:"transform 0.2s ease", flexShrink:0 }}>
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      {/* Student list */}
      {open && (
        <>
          {students.map(s => (
            <StudentRow key={s.id} s={s} accent={accent}
              onClick={() => router.push(`/admin/students?search=${encodeURIComponent(s.name)}`)} />
          ))}
          <button onClick={() => router.push(routePath)}
            style={{ width:"100%", padding:"12px 16px", background: accent+"10", border:"none", borderTop:"1px solid #f3f4f6", cursor:"pointer", fontSize:13, fontWeight:700, color:accent }}>
            View all in Students →
          </button>
        </>
      )}
    </div>
  );
}

function Skel({ h=80 }: { h?: number }) {
  return <div style={{ height:h, borderRadius:16, background:"#f3f4f6", animation:"pulse 1.4s ease infinite" }} />;
}

/* ── Main ───────────────────────────────────────────────────────────────── */
export default function AnalyticsPage() {
  const router = useRouter();
  const [data, setData]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [college, setCollege] = useState<string>("ALL");
  // Fetched, not a hardcoded ALL/GNIT/GNITC union — same trap as items
  // #101/#107/#114/#118, this time on the analytics filter.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  const load = (c: string) => {
    setLoading(true); setData(null);
    const q = c !== "ALL" ? `?college=${c}` : "";
    fetch(`/api/admin/analytics${q}`, { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success) setData(j.data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(college); }, [college]);
  useEffect(() => {
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  const paid     = data?.paid     as Category;
  const review   = data?.review   as Category;
  const notPaid  = data?.not_paid as Category;
  const rejected = data?.rejected as Category;
  const total    = data?.total ?? 0;
  const collected = data?.total_collected ?? 0;
  const completionPct = total > 0 ? Math.round(((paid?.count ?? 0) / total) * 100) : 0;

  return (
    <div style={{ minHeight:"100vh", background:"#f8f8fb", paddingBottom:40, fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#1a0a3c 0%,#3730a3 100%)", padding:"48px 20px 20px" }}>
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <h1 style={{ color:"#fff", fontSize:22, fontWeight:700, margin:0 }}>Analytics</h1>
          <button onClick={() => load(college)} style={{
            width:36, height:36, borderRadius:50, background:"rgba(255,255,255,0.15)",
            border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:16, flexWrap:"wrap" }}>
          {["ALL", ...colleges.map(c => c.id)].map(c => (
            <button key={c} onClick={() => setCollege(c)} style={{
              padding:"7px 18px", borderRadius:50, border:"none", cursor:"pointer",
              background: college === c ? "#fff" : "rgba(255,255,255,0.15)",
              color: college === c ? "#3730a3" : "#fff",
              fontSize:13, fontWeight:700, transition:"all 0.18s ease",
            }}>{c}</button>
          ))}
        </div>
      </div>

      <div style={{ padding:"16px 16px 0", display:"flex", flexDirection:"column", gap:12 }}>

        {/* Summary numbers */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          {loading ? [1,2,3].map(i=><Skel key={i} h={90}/>)
          : <>
              <div style={{ background:"#fff", borderRadius:16, padding:"14px 12px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)", textAlign:"left" }}>
                <p style={{ fontSize:24, fontWeight:700, color:"#0ea5e9", margin:0 }}>{total}</p>
                <p style={{ fontSize:11, color:"#9ca3af", fontWeight:600, marginTop:4 }}>Registered</p>
              </div>
              <div style={{ background:"#fff", borderRadius:16, padding:"14px 12px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)", textAlign:"left" }}>
                <p style={{ fontSize:24, fontWeight:700, color:"#16a34a", margin:0 }}>{paid?.count ?? 0}</p>
                <p style={{ fontSize:11, color:"#9ca3af", fontWeight:600, marginTop:4 }}>Paid ({completionPct}%)</p>
              </div>
              <div style={{ background:"#fff", borderRadius:16, padding:"14px 12px", boxShadow:"0 2px 8px rgba(0,0,0,0.04)", textAlign:"left" }}>
                <p style={{ fontSize:24, fontWeight:700, color:"#f59e0b", margin:0 }}>{notPaid?.count ?? 0}</p>
                <p style={{ fontSize:11, color:"#9ca3af", fontWeight:600, marginTop:4 }}>Not Paid</p>
              </div>
            </>
          }
        </div>

        {/* Total collected */}
        {!loading && collected > 0 && (
          <div style={{ background:"linear-gradient(135deg,#14532d,#16a34a)", borderRadius:16, padding:"16px 18px" }}>
            <p style={{ color:"rgba(255,255,255,0.65)", fontSize:11, fontWeight:700, margin:0, letterSpacing:1 }}>TOTAL COLLECTED</p>
            <p style={{ color:"#fff", fontSize:28, fontWeight:700, margin:"4px 0 0" }}>₹{collected.toLocaleString("en-IN")}</p>
          </div>
        )}

        {loading && <><Skel h={70}/><Skel h={80}/><Skel h={80}/><Skel h={80}/></>}

        {/* Expandable student sections */}
        {!loading && <>
          <Section Icon={Check} title="Paid"
            sub="Tap to see who paid"
            count={paid?.count ?? 0} students={paid?.students ?? []}
            accent="#16a34a" routePath="/admin/payments" router={router} />

          <Section Icon={Clock} title="Under Review"
            sub="Submitted, awaiting approval"
            count={review?.count ?? 0} students={review?.students ?? []}
            accent="#0ea5e9" routePath="/admin/payments" router={router} />

          <Section Icon={AlertTriangle} title="Not Paid"
            sub="Registered but haven't submitted payment"
            count={notPaid?.count ?? 0} students={notPaid?.students ?? []}
            accent="#f59e0b" routePath="/admin/students" router={router} />

          <Section Icon={X} title="Rejected / Reupload"
            sub="Need attention"
            count={rejected?.count ?? 0} students={rejected?.students ?? []}
            accent="#ef4444" routePath="/admin/payments" router={router} />

          {/* Active batches */}
          {(data?.batch_stats?.length ?? 0) > 0 && (
            <div style={{ background:"#fff", borderRadius:18, overflow:"hidden", boxShadow:"0 2px 8px rgba(0,0,0,0.05)" }}>
              <p style={{ fontSize:11, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", letterSpacing:1, padding:"14px 16px 8px", margin:0 }}>
                Active Batches
              </p>
              {data.batch_stats.map((b: any) => (
                <div key={b.id} style={{ padding:"12px 16px", borderTop:"1px solid #f9fafb" }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <div>
                      <p style={{ fontSize:14, fontWeight:700, color:"#111827", margin:0 }}>{b.name}</p>
                      <p style={{ fontSize:11, color:"#9ca3af", margin:"3px 0 0" }}>{b.college} · ₹{Number(b.fee_amount).toLocaleString("en-IN")}</p>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <p style={{ fontSize:20, fontWeight:700, color:"#3730a3", margin:0 }}>{b.student_count}</p>
                      <p style={{ fontSize:11, color:"#9ca3af", margin:"2px 0 0" }}>registered</p>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:10 }}>
                    <div style={{ flex:1, background:"#f0fdf4", borderRadius:10, padding:"6px 10px" }}>
                      <p style={{ fontSize:15, fontWeight:800, color:"#16a34a", margin:0 }}>{b.paid_count}</p>
                      <p style={{ fontSize:10, color:"#15803d", margin:"1px 0 0" }}>Paid</p>
                    </div>
                    <div style={{ flex:1, background:"#fffbeb", borderRadius:10, padding:"6px 10px" }}>
                      <p style={{ fontSize:15, fontWeight:800, color:"#d97706", margin:0 }}>{b.not_paid_count}</p>
                      <p style={{ fontSize:10, color:"#b45309", margin:"1px 0 0" }}>Not Paid</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
    </div>
  );
}

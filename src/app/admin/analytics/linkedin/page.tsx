"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Linkedin, Users, MousePointerClick, RefreshCw, ArrowLeft } from "lucide-react";

export default function LinkedInAnalyticsPage() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = () => {
    setLoading(true);
    const token = localStorage.getItem("sp_token") ?? "";
    fetch(`/api/analytics/linkedin?days=${days}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (r.status === 403) { setForbidden(true); return null; }
        return r.json();
      })
      .then(j => { if (j?.success) setData(j.data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [days]);

  if (forbidden) {
    return <div style={{ minHeight:"100vh", display:"grid", placeItems:"center", background:"#f8fafc", fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}><div style={{ textAlign:"center", padding:24 }}><h1 style={{ color:"#0f172a", marginBottom:8 }}>Super Admin only</h1><p style={{ color:"#64748b" }}>LinkedIn tap analytics is restricted to the Super Admin.</p></div></div>;
  }

  const total = data?.total_taps ?? 0;
  const unique = data?.unique_students ?? 0;
  const colleges = Object.entries(data?.by_college ?? {}) as [string, number][];

  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc", paddingBottom:40, fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <div style={{ background:"linear-gradient(135deg,#0a66c2 0%,#0062cc 55%,#0a2a5c 100%)", padding:"44px 20px 24px", color:"#fff" }}>
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, border:"1px solid rgba(255,255,255,.25)", background:"rgba(255,255,255,.12)", color:"#fff", borderRadius:12, padding:"8px 13px", fontWeight:700, cursor:"pointer" }}><ArrowLeft size={16}/> Back</button>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:18 }}>
          <div style={{ display:"flex", alignItems:"center", gap:12 }}><div style={{ width:46, height:46, borderRadius:13, background:"rgba(255,255,255,.16)", display:"grid", placeItems:"center" }}><Linkedin size={26}/></div><div><h1 style={{ margin:0, fontSize:23, fontWeight:900 }}>LinkedIn Post Analytics</h1><p style={{ margin:"4px 0 0", color:"rgba(255,255,255,.72)", fontSize:12 }}>Super Admin · Student Platform feedback post</p></div></div>
          <button onClick={load} aria-label="Refresh" style={{ width:38, height:38, borderRadius:50, border:"none", background:"rgba(255,255,255,.14)", color:"#fff", display:"grid", placeItems:"center", cursor:"pointer" }}><RefreshCw size={17}/></button>
        </div>
        <div style={{ display:"flex", gap:8, marginTop:18 }}>{[7,30,90].map(d => <button key={d} onClick={() => setDays(d)} style={{ border:0, borderRadius:50, padding:"7px 15px", background:days===d?"#fff":"rgba(255,255,255,.14)", color:days===d?"#0062cc":"#fff", fontWeight:800, cursor:"pointer" }}>{d}d</button>)}</div>
      </div>

      <div style={{ padding:"18px 16px", maxWidth:720, margin:"0 auto", display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
          <div style={{ background:"#fff", borderRadius:18, padding:20, boxShadow:"0 2px 8px rgba(15,23,42,.06)" }}><div style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:12, fontWeight:700 }}><MousePointerClick size={17}/> TOTAL TAPS</div><div style={{ fontSize:34, fontWeight:900, color:"#0f172a", marginTop:8 }}>{loading?"—":total}</div><div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>Times students tapped View Post</div></div>
          <div style={{ background:"#fff", borderRadius:18, padding:20, boxShadow:"0 2px 8px rgba(15,23,42,.06)" }}><div style={{ display:"flex", alignItems:"center", gap:8, color:"#64748b", fontSize:12, fontWeight:700 }}><Users size={17}/> UNIQUE STUDENTS</div><div style={{ fontSize:34, fontWeight:900, color:"#0f172a", marginTop:8 }}>{loading?"—":unique}</div><div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>Different students who tapped</div></div>
        </div>

        <div style={{ background:"#fff", borderRadius:18, padding:18, boxShadow:"0 2px 8px rgba(15,23,42,.06)" }}>
          <div style={{ fontSize:11, fontWeight:800, color:"#94a3b8", letterSpacing:1, textTransform:"uppercase", marginBottom:12 }}>Taps by College</div>
          {loading ? <div style={{ color:"#94a3b8" }}>Loading…</div> : colleges.length===0 ? <div style={{ color:"#94a3b8" }}>No taps yet.</div> : colleges.map(([college,count]) => <div key={college} style={{ display:"flex", justifyContent:"space-between", padding:"10px 0", borderTop:"1px solid #f1f5f9" }}><span style={{ fontWeight:700, color:"#334155" }}>{college}</span><strong style={{ color:"#0062cc" }}>{count}</strong></div>)}
        </div>

        <div style={{ background:"#fff", borderRadius:18, overflow:"hidden", boxShadow:"0 2px 8px rgba(15,23,42,.06)" }}>
          <div style={{ padding:"16px 18px 10px", fontSize:11, fontWeight:800, color:"#94a3b8", letterSpacing:1, textTransform:"uppercase" }}>Recent taps</div>
          {!loading && (data?.recent?.length ?? 0) === 0 ? <div style={{ padding:24, textAlign:"center", color:"#94a3b8" }}>No taps recorded in this period.</div> : data?.recent?.map((r:any) => <div key={r.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 18px", borderTop:"1px solid #f8fafc" }}><div style={{ width:34, height:34, borderRadius:10, background:"#f2f7ff", color:"#0062cc", display:"grid", placeItems:"center" }}><Linkedin size={16}/></div><div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:750, color:"#0f172a" }}>{r.student.name}{r.student.roll?` · ${r.student.roll}`:""}</div><div style={{ fontSize:11, color:"#94a3b8" }}>{r.college || "Unknown college"} · {new Date(r.created_at).toLocaleString("en-IN", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</div></div></div>)}
        </div>
      </div>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
export default function ViewerPage() {
  const router=useRouter(); const [stats,setStats]=useState<any>(null); const [students,setStudents]=useState<any[]>([]); const [q,setQ]=useState(""); const [loading,setLoading]=useState(false);
  const h=()=>({Authorization:`Bearer ${localStorage.getItem("sp_token")??""}` });
  useEffect(()=>{
    const role=localStorage.getItem("sp_role"); if(!["viewer","admin","super_admin"].includes(role??"")) {router.replace("/register");return;}
    fetch("/api/admin/stats",{headers:h()}).then(r=>r.json()).then(j=>j.success&&setStats(j.data));
  },[]);
  async function search(){if(!q.trim())return;setLoading(true);const res=await fetch(`/api/admin/students?q=${q}`,{headers:h()}).then(r=>r.json());setStudents(res.data?.students??[]);setLoading(false);}
  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-12 pb-5"><p className="text-xs uppercase tracking-wider opacity-70">Viewer</p><h1 className="text-2xl font-bold mt-1">Student Platform</h1></div>
      <div className="px-4 mt-4 space-y-4">
        {stats&&<div className="grid grid-cols-2 gap-3">{[[stats.total_students,"Students","👥"],[stats.payments_approved,"Approved","✅"],[stats.payments_pending,"Pending","⏳"],[`₹${stats.total_collected}`,"Collected","💰"]].map(([v,l,e])=>(
          <div key={l as string} className="bg-white rounded-2xl p-4 shadow-sm"><div className="text-2xl">{e}</div><div className="text-xl font-black mt-1">{v}</div><div className="text-xs text-gray-500">{l as string}</div></div>
        ))}</div>}
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="font-semibold mb-3">Search Students</p>
          <div className="flex gap-2">
            <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()} placeholder="Name, roll, phone…" className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"/>
            <button onClick={search} className="bg-blue-600 text-white px-4 rounded-xl text-sm font-medium">Search</button>
          </div>
          {loading&&<p className="text-sm text-gray-500 mt-3 text-center">Searching…</p>}
          <div className="mt-3 space-y-2">{students.map(s=>(
            <div key={s.id} className="border border-gray-100 rounded-xl p-3 text-sm">
              <div className="flex justify-between"><span className="font-medium">{s.full_name??"-"}</span><span className="text-xs bg-gray-100 px-2 py-0.5 rounded-full">{s.college}</span></div>
              <div className="text-xs text-gray-500 mt-1">{s.roll_number} • {s.branch} • {s.year} Year</div>
            </div>
          ))}</div>
        </div>
        <button
          onClick={() => {
            const t = localStorage.getItem("sp_token") ?? "";
            // A browser-initiated download cannot attach an Authorization header.
            // The export endpoint validates the session token passed in the URL.
            const url = `/api/admin/export?format=xlsx&token=${encodeURIComponent(t)}`;
window.open(url, "_blank");
          }}
          className="block w-full bg-white border border-gray-200 text-center py-3 rounded-2xl text-sm font-medium shadow-sm"
        >
          📥 Export Excel
        </button>
      </div>
    </div>
  );
}

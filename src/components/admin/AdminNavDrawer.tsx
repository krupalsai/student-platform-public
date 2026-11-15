"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLiveTheme } from "@/lib/useLiveTheme";
import { LifeBuoy, CreditCard, Megaphone, Scale, Radio, Bot, HelpCircle, BarChart3, ClipboardList, Map, FileDown, Users, Settings, HeartPulse, LogOut, LayoutGrid, Home, PhoneCall, type LucideIcon } from "lucide-react";
interface NavItem { Icon: LucideIcon; label: string; path: string; color: string; bg: string; adminOnly: boolean; superAdminOnly?: boolean }
const NAV_ITEMS: NavItem[] = [
 {Icon:Home,label:"Console",path:"/admin",color:"#0062cc",bg:"#e8f1ff",adminOnly:false},
 {Icon:CreditCard,label:"Payments",path:"/admin/payments",color:"#007aff",bg:"#e8f1ff",adminOnly:false},
 {Icon:Megaphone,label:"Announce",path:"/admin/announcements",color:"#d97706",bg:"#fef3c7",adminOnly:true},
 {Icon:Radio,label:"Broadcast",path:"/admin/broadcast",color:"#dc2626",bg:"#fee2e2",adminOnly:true},
 {Icon:Bot,label:"Copilot",path:"/admin/copilot",color:"#0d9488",bg:"#ccfbf1",adminOnly:false},
 {Icon:LifeBuoy,label:"Support Inbox",path:"/admin/support",color:"#0e7490",bg:"#cffafe",adminOnly:true},
 {Icon:HelpCircle,label:"Questions",path:"/admin/questions",color:"#0d9488",bg:"#ccfbf1",adminOnly:true},
 {Icon:PhoneCall,label:"Call Leads",path:"/admin/call-leads",color:"#059669",bg:"#d1fae5",adminOnly:true},
 {Icon:BarChart3,label:"Analytics",path:"/admin/analytics",color:"#0051a8",bg:"#eef2ff",adminOnly:false},
 {Icon:ClipboardList,label:"Activity Logs",path:"/admin/audit",color:"#0062cc",bg:"#e8f1ff",adminOnly:false,superAdminOnly:true},
 {Icon:Scale,label:"Court News",path:"/admin/court-news",color:"#007aff",bg:"#e8f1ff",adminOnly:true},
 {Icon:Map,label:"Route Map",path:"/admin/route-map",color:"#0062cc",bg:"#e8f1ff",adminOnly:true,superAdminOnly:true},
 {Icon:FileDown,label:"Export",path:"/admin/export",color:"#0891b2",bg:"#cffafe",adminOnly:true},
 {Icon:Users,label:"Users",path:"/admin/users",color:"#db2777",bg:"#fce7f3",adminOnly:true},
 {Icon:Settings,label:"Settings",path:"/admin/settings",color:"#475569",bg:"#f1f5f9",adminOnly:true,superAdminOnly:true},
 {Icon:HeartPulse,label:"Health",path:"/admin/health",color:"#059669",bg:"#d1fae5",adminOnly:true,superAdminOnly:true},
];
export default function AdminNavDrawer(){
 const pathname=usePathname(); const router=useRouter(); const theme=useLiveTheme(); const[open,setOpen]=useState(false); const[role,setRole]=useState<string|null>(null);
 useEffect(()=>{setRole(localStorage.getItem("sp_role"));},[]);
 useEffect(()=>{document.body.style.overflow=open?"hidden":"";return()=>{document.body.style.overflow=""}},[open]);
 if(pathname==="/admin"||pathname==="/admin/login"||pathname==="/admin/install"||pathname==="/admin/copilot"||pathname?.startsWith("/admin/group-chat")||pathname==="/admin/support")return null;
 const isSuperAdmin=role==="super_admin"; const isAdmin=role==="admin"||isSuperAdmin;
 const visible=NAV_ITEMS.filter(item=>(!item.adminOnly||isAdmin)&&(!item.superAdminOnly||isSuperAdmin));
 if(role!==null&&!isAdmin)return null;
 function go(path:string){setOpen(false);setTimeout(()=>router.push(path),180)}
 return <><button onClick={()=>setOpen(true)} aria-label="Admin navigation" style={{position:"fixed",right:18,bottom:"calc(18px + env(safe-area-inset-bottom,0px))",width:52,height:52,borderRadius:26,zIndex:90,background:theme.accent,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:`0 6px 20px ${theme.accent}55`}}><LayoutGrid size={21} strokeWidth={2} color="#fff"/></button>
 <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:95,background:"rgba(0,0,0,.42)",backdropFilter:"blur(3px)",opacity:open?1:0,pointerEvents:open?"auto":"none",transition:"opacity .25s ease"}}/>
 <div role="navigation" aria-label="Admin navigation" style={{position:"fixed",top:0,right:0,bottom:0,zIndex:100,width:"82vw",maxWidth:320,background:"#fff",borderRadius:"24px 0 0 24px",boxShadow:"-6px 0 48px rgba(0,0,0,.18)",display:"flex",flexDirection:"column",transform:open?"translateX(0)":"translateX(100%)",transition:"transform .3s cubic-bezier(.32,.72,0,1)",overflow:"hidden"}}>
 <div style={{background:`linear-gradient(135deg,${theme.accent}dd 0%,${theme.accent} 100%)`,padding:"24px 20px 20px"}}><div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}><div><p style={{color:"rgba(255,255,255,.65)",fontSize:10,fontWeight:700,letterSpacing:2,textTransform:"uppercase",margin:0}}>{isSuperAdmin?"Super Admin":"Admin"}</p><p style={{color:"#fff",fontSize:18,fontWeight:700,margin:"4px 0 0"}}>Admin Navigation</p></div><button onClick={()=>setOpen(false)} aria-label="Close navigation" style={{width:32,height:32,borderRadius:50,background:"rgba(255,255,255,.2)",border:"1.5px solid rgba(255,255,255,.3)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>
 <div style={{flex:1,overflowY:"auto",padding:"8px 0"}}>{visible.map(item=>{const active=pathname===item.path||pathname?.startsWith(item.path+"/");return <button key={item.path} onClick={()=>go(item.path)} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"11px 16px",background:active?"#f8fafc":"none",border:"none",cursor:"pointer"}}><span style={{width:40,height:40,borderRadius:11,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:item.bg}}><item.Icon size={18} strokeWidth={1.9} color={item.color}/></span><p style={{flex:1,fontSize:13.5,fontWeight:active?700:600,color:active?item.color:"#111827",margin:0,textAlign:"left"}}>{item.label}</p>{active&&<span style={{width:6,height:6,borderRadius:999,background:item.color,flexShrink:0}}/>}</button>})}</div>
 <div style={{borderTop:"1px solid #f3f4f6",padding:"12px 16px 20px"}}><button onClick={async()=>{await fetch("/api/auth/logout",{method:"POST",headers:{Authorization:`Bearer ${localStorage.getItem("sp_token")??""}`}}).catch(()=>{});localStorage.clear();setOpen(false);router.replace("/")}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,background:"#fef2f2",border:"none",borderRadius:14,padding:"12px 16px",cursor:"pointer"}}><LogOut size={17} strokeWidth={2} color="#dc2626"/><span style={{fontSize:13.5,fontWeight:700,color:"#dc2626"}}>Logout</span></button></div></div></>;
}


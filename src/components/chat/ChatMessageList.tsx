"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, Clock, Download, FileText, ShieldCheck } from "lucide-react";
import { timeOf, dayLabel, isSameGroup } from "@/lib/chat-format";
import { BUBBLE, senderColor } from "@/lib/chat-theme";

export interface ChatMessage {
  id: string;
  sender_id: string;
  sender_name: string;
  sender_role: string;
  body: string | null;
  photo_url: string | null;
  created_at: string;
  seen_count?: number;
  _status?: "sending" | "sent" | "failed";
}

function initialOf(name: string) { return (name || "?").trim().charAt(0).toUpperCase(); }
function isDocument(m: ChatMessage) {
  return !!m.photo_url && (m.photo_url.includes("/raw/upload/") || (m.body ?? "").startsWith("[Document]"));
}
function documentName(m: ChatMessage) {
  const body = m.body ?? "";
  return body.startsWith("[Document]") ? body.slice(10).trim() || "Document" : "Document";
}
function StatusTick({ status, seenCount = 0 }: { status?: ChatMessage["_status"]; seenCount?: number }) {
  if (status === "sending") return <Clock size={11} strokeWidth={2} color="rgba(255,255,255,.7)" />;
  if (status === "failed") return <AlertCircle size={11} strokeWidth={2.2} color="#fecaca" />;
  return <span style={{ display:"inline-flex", alignItems:"center", gap:2 }}><Check size={12} strokeWidth={2.4} color={seenCount > 0 ? "#bfdbfe" : "rgba(255,255,255,.75)"}/>{seenCount > 0 && <span style={{fontSize:8.5,color:"#dbeafe",fontWeight:600}}>Seen {seenCount}</span>}</span>;
}

export default function ChatMessageList({ messages, myId }: { messages: ChatMessage[]; myId: string | null; canModerate?: boolean; deletingId?: string | null; onDelete?: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { if (selectedId && !messages.some(m => m.id === selectedId)) setSelectedId(null); }, [messages, selectedId]);

  if (!messages.length) return <div style={{display:"flex",justifyContent:"center",marginTop:40}}><span style={{background:"#fff",color:"#64748b",fontSize:12.5,padding:"8px 16px",borderRadius:999,boxShadow:BUBBLE.shadow}}>No messages yet — say hello.</span></div>;

  return <div>{messages.map((m, i) => {
    const prev = messages[i - 1];
    const grouped = prev ? isSameGroup(prev, m) : false;
    const showDayDivider = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
    const mine = m.sender_id === myId;
    const isStaff = m.sender_role === "admin" || m.sender_role === "super_admin";
    const doc = isDocument(m);
    const selected = selectedId === m.id;
    return <div key={m.id}>
      {showDayDivider && <div style={{display:"flex",justifyContent:"center",margin:"12px 0 8px"}}><span style={{background:"#fff",color:"#475569",fontSize:10.5,fontWeight:600,padding:"4px 13px",borderRadius:999,boxShadow:BUBBLE.shadow}}>{dayLabel(m.created_at)}</span></div>}
      {m.sender_role === "system" ? <div style={{display:"flex",justifyContent:"center",margin:"10px 0"}}><span style={{background:"#ecfdf5",border:"1px solid #a7f3d0",color:"#065f46",fontSize:11.5,fontWeight:600,padding:"5px 12px",borderRadius:999,textAlign:"center",maxWidth:"88%"}}>{m.body}</span></div> :
      <div onClick={() => setSelectedId(selected ? null : m.id)} style={{display:"flex",alignItems:"flex-end",gap:6,marginTop:grouped?2:10,justifyContent:mine?"flex-end":"flex-start",background:selected?"rgba(29,78,216,.10)":"transparent",borderRadius:12,padding:"1px 3px",userSelect:"none",WebkitUserSelect:"none"}}>
        {!mine && <div style={{width:26,height:26,flexShrink:0}}>{!grouped && <div style={{width:26,height:26,borderRadius:999,display:"flex",alignItems:"center",justifyContent:"center",background:isStaff?"#dbeafe":"#e2e8f0",color:isStaff?"#1d4ed8":"#64748b",fontSize:11,fontWeight:700}}>{initialOf(m.sender_name)}</div>}</div>}
        <div style={{display:"flex",flexDirection:"column",alignItems:mine?"flex-end":"flex-start",maxWidth:"78%",minWidth:0}}>
          {!mine && !grouped && <p style={{fontSize:11,fontWeight:700,color:isStaff?"#1d4ed8":senderColor(m.sender_id),margin:"0 0 2px 4px",display:"flex",alignItems:"center",gap:4}}>{m.sender_name}{isStaff&&<ShieldCheck size={11} strokeWidth={2.5}/>}</p>}
          <div style={{position:"relative",borderRadius:12,borderTopLeftRadius:!mine&&!grouped?0:12,borderTopRightRadius:mine&&!grouped?0:12,background:mine?BUBBLE.mine:BUBBLE.theirs,boxShadow:BUBBLE.shadow,padding:(m.photo_url||doc)?5:"7px 11px",opacity:m._status === "sending" ? 0.75 : 1,minWidth:0}}>
            {!grouped && <span aria-hidden style={{position:"absolute",top:0,width:0,height:0,...(mine?{right:-7,borderTop:`8px solid ${BUBBLE.mine}`,borderRight:"8px solid transparent"}:{left:-7,borderTop:`8px solid ${BUBBLE.theirs}`,borderLeft:"8px solid transparent"})}}/>}
            {doc && m.photo_url ? <a href={m.photo_url} target="_blank" rel="noreferrer" download style={{display:"flex",alignItems:"center",gap:10,minWidth:190,maxWidth:280,padding:"10px 9px",borderRadius:9,background:mine?"rgba(255,255,255,.10)":"#f8fafc",color:mine?"#fff":"#1e293b",textDecoration:"none"}}><FileText size={28} strokeWidth={1.8}/><span style={{minWidth:0,flex:1}}><span style={{display:"block",fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{documentName(m)}</span><span style={{display:"block",fontSize:10.5,marginTop:2,opacity:.72}}>Tap to open / download</span></span><Download size={17}/></a> : m.photo_url ? <img src={m.photo_url} alt="" style={{width:"100%",maxWidth:260,borderRadius:9,display:"block"}}/> : null}
            {m.body && !doc && <p style={{fontSize:13.5,lineHeight:1.45,color:mine?"#fff":"#111b21",margin:m.photo_url?"6px 4px 2px":0,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{m.body}</p>}
            <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:4,marginTop:2}}><span style={{fontSize:9.5,color:mine?"rgba(255,255,255,.92)":"#5b6472"}}>{timeOf(m.created_at)}</span>{mine&&<StatusTick status={m._status} seenCount={m.seen_count}/>}</div>
          </div>
        </div>
      </div>}
    </div>;
  })}</div>;
}

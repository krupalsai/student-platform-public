"use client";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";

interface Msg { role: "user" | "assistant"; content: string }
const SUGGESTIONS = [
  "What needs my attention?",
  "Show me pending payments",
  "Who hasn't paid in GNIT Batch 1?",
  "Find student Ravi",
  "Any open questions?",
  "Remind GNIT Batch 1 to pay",
  "Set GNIT Batch 2 fee to ₹2500",
];

// The server keeps the conversation, but a phone copy is the fallback that
// makes previous chats visible even when the server store is unreachable.
const LOCAL_KEY = "sp_copilot_history_v1";
const MAX_LOCAL_TURNS = 40;

// A fetch that can never hang forever: the old code waited on the server
// without any limit, so a slow reply left the typing dots on screen
// indefinitely. Every copilot request now fails fast with a message instead.
async function fetchWithTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function loadLocalBackup(): Msg[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: unknown): t is Msg => !!t && typeof t === "object" && ((t as Msg).role === "user" || (t as Msg).role === "assistant") && typeof (t as Msg).content === "string")
      .slice(-MAX_LOCAL_TURNS);
  } catch {
    return [];
  }
}

function saveLocalBackup(messages: Msg[]) {
  try {
    if (messages.length) localStorage.setItem(LOCAL_KEY, JSON.stringify(messages.slice(-MAX_LOCAL_TURNS)));
  } catch {
    /* storage full or unavailable — the server copy is the primary one */
  }
}

// A small, safe Markdown subset for copilot text. React escapes all model output.
function inlineMarkdown(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> :
    part.startsWith("`") && part.endsWith("`") ? <code key={i} className="rounded bg-gray-100 px-1">{part.slice(1, -1)}</code> : part
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  return inner.split("|").map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function CopilotText({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A markdown table (header row + --- separator + rows) renders as a real
    // table — never as raw | pipes and --- separators.
    if (line.trim().startsWith("|") && line.includes("|", 1) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].includes("|", 1) && !isTableSeparator(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <div key={`t${i}`} className="overflow-x-auto my-1">
          <table className="w-full text-left text-xs border-collapse">
            <thead><tr>{header.map((h, j) => <th key={j} className="border border-gray-200 bg-gray-50 px-2 py-1 font-semibold">{inlineMarkdown(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className="border border-gray-200 px-2 py-1 align-top">{inlineMarkdown(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (bullet) out.push(<div key={i} className="flex gap-2 pl-1"><span aria-hidden="true">•</span><span>{inlineMarkdown(bullet[1])}</span></div>);
    else if (numbered) out.push(<div key={i} className="flex gap-2 pl-1"><span>{numbered[1]}.</span><span>{inlineMarkdown(numbered[2])}</span></div>);
    else if (heading) out.push(<div key={i} className="font-semibold">{inlineMarkdown(heading[1])}</div>);
    else out.push(<div key={i}>{line ? inlineMarkdown(line) : <span>&nbsp;</span>}</div>);
    i++;
  }
  return <div className="space-y-1">{out}</div>;
}

function istGreeting(): string {
  const hour = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default function AdminCopilot() {
  const router = useRouter();
  const [messages,setMessages]=useState<Msg[]>([]);
  const [input,setInput]=useState("");
  const [sending,setSending]=useState(false);
  const [pendingToken,setPendingToken]=useState<string|null>(null);
  const endRef=useRef<HTMLDivElement>(null);
  const h=()=>({"Content-Type":"application/json",Authorization:`Bearer ${localStorage.getItem("sp_token")??""}`});
  useEffect(()=>{endRef.current?.scrollIntoView({behavior:"smooth"})},[messages,sending]);

  // Keep the phone copy of the conversation in step, so previous chats stay
  // visible even if the server store misses a save.
  useEffect(()=>{ if (messages.length) saveLocalBackup(messages); },[messages]);

  // Opening briefing: the copilot flags what needs attention before being asked.
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        // Saved conversation first: the Copilot remembers earlier chats, so
        // reopening the page continues where the admin left off.
        try{
          const hr=await fetchWithTimeout("/api/admin/copilot?history=1",{headers:h(),cache:"no-store"},10000);
          const hj=await hr.json();
          const saved=hj?.success&&Array.isArray(hj.data?.history)?hj.data.history:[];
          if(!cancelled&&saved.length){setMessages(saved.map((t:{role:"user"|"assistant";content:string})=>({role:t.role,content:t.content})));return;}
        }catch{/* fall through to the phone copy, then the briefing */}
        if(!cancelled){
          const local=loadLocalBackup();
          if(local.length){setMessages(local);return;}
        }
        const res=await fetchWithTimeout("/api/admin/copilot",{headers:h()},15000);
        const j=await res.json();
        if(!cancelled&&j?.success&&j.data?.briefing){
          setMessages(m=>m.length?m:[{role:"assistant",content:`${istGreeting()}. ${j.data.briefing}\n\nAsk me anything about students, batches or payments — or just tell me what to do.`}]);
        }
      }catch{/* briefing is a convenience; the chat works without it */}
    })();
    return()=>{cancelled=true;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function request(q:string, confirmToken?:string){
    if(!q.trim()||sending)return;
    const history=messages.slice(-20); setInput(""); setMessages(m=>[...m,{role:"user",content:q}]); setSending(true);
    try{
      const body:any={question:q,history}; if(confirmToken){body.pending_token=confirmToken;body.confirm=true;}
      const res=await fetchWithTimeout("/api/admin/copilot",{method:"POST",headers:h(),body:JSON.stringify(body)},45000);
      const j=await res.json(); const answer=j?.success?j.data.answer:(j?.error??"Something went wrong. Please try again.");
      setMessages(m=>[...m,{role:"assistant",content:answer}]);
      if(j?.data?.confirmation_required&&j.data.action_token)setPendingToken(j.data.action_token); else if(confirmToken)setPendingToken(null);
    }catch(e){
      const timedOut = e instanceof Error && e.name === "AbortError";
      setMessages(m=>[...m,{role:"assistant",content:timedOut?"That took too long — please try again.":"Network error. Please try again."}]);
    }
    finally{setSending(false);}
  }

  function newChat(){
    // Clear the screen FIRST, then tell the server in the background. The old
    // code waited for the server reply before clearing anything, so a slow
    // delete made the button look dead.
    setMessages([]);setPendingToken(null);setInput("");
    try{localStorage.removeItem(LOCAL_KEY);}catch{/* ignore */}
    void fetch("/api/admin/copilot",{method:"DELETE",headers:h()}).catch(()=>{/* best effort */});
  }

  function send(q:string){
    const trimmed=q.trim(); if(!trimmed)return;
    if(pendingToken && /^(yes|y|confirm|confirmed|do it|go ahead|okay|ok|sure|proceed)$/i.test(trimmed)){const token=pendingToken;setPendingToken(null);void request(trimmed,token);return;}
    if(pendingToken && /^(no|n|cancel|stop|don't|dont)$/i.test(trimmed)){setPendingToken(null);setInput("");setMessages(m=>[...m,{role:"user",content:trimmed},{role:"assistant",content:"Cancelled."}]);return;}
    setPendingToken(null);void request(trimmed);
  }

  return <div className="min-h-screen bg-gray-50 flex flex-col">
    <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
      <button onClick={()=>router.back()} style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.15)",border:"1.5px solid rgba(255,255,255,0.25)",borderRadius:14,padding:"8px 16px 8px 10px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:14}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>Back</button>
      <h1 className="text-xl font-bold flex items-center gap-2"><Bot size={18} strokeWidth={2}/> Admin Copilot</h1>
      <p className="text-sm opacity-80">Ask anything about your platform — or tell me what to do</p>
      {messages.length>0&&<button onClick={()=>newChat()} style={{marginTop:10,background:"rgba(255,255,255,0.15)",border:"1.5px solid rgba(255,255,255,0.25)",borderRadius:12,padding:"6px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>New chat</button>}
    </div>
    <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3 max-w-2xl w-full mx-auto">
      {messages.length===0&&<div className="mt-2"><div className="bg-white rounded-2xl p-4 shadow-sm mb-4"><p className="text-sm text-gray-700">I read live platform data to answer any question, and I can run admin jobs for you — fee changes, batch messages, payment reviews, reminders and more.</p><p className="text-xs text-gray-400 mt-2">Anything that moves money, messages students or deletes records asks for your Yes first. Super Admin has protected actions such as deletion.</p></div><p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Try asking</p><div className="flex flex-col gap-2">{SUGGESTIONS.map(s=><button key={s} onClick={()=>send(s)} className="text-left text-sm bg-white border border-gray-200 rounded-xl px-4 py-3 hover:bg-gray-50 active:scale-[0.99] transition">{s}</button>)}</div></div>}
      {messages.map((m,i)=><div key={i} className={`flex ${m.role==="user"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${m.role==="user"?"bg-blue-600 text-white":"bg-white text-gray-800 shadow-sm border border-gray-100"}`}>{m.role==="assistant"?<CopilotText text={m.content}/>:m.content}</div></div>)}
      {pendingToken&&<div className="flex justify-start"><div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl px-4 py-3 text-sm">Reply <b>Yes</b> to confirm or <b>No</b> to cancel.</div></div>}
      {sending&&<div className="flex justify-start"><div className="bg-white shadow-sm border border-gray-100 rounded-2xl px-4 py-3"><div className="flex gap-1"><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"/><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{animationDelay:"120ms"}}/><span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{animationDelay:"240ms"}}/></div></div></div>}
      <div ref={endRef}/>
    </div>
    <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3"><div className="max-w-2xl mx-auto flex gap-2"><input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")send(input)}} placeholder="Ask me anything, or tell me what to do…" disabled={sending} className="flex-1 border border-gray-200 rounded-full px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-60"/><button onClick={()=>send(input)} disabled={sending||!input.trim()} className="bg-blue-600 text-white rounded-full w-12 h-12 flex items-center justify-center disabled:opacity-40 active:scale-95 transition"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div>
  </div>;
}

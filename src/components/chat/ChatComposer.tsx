"use client";
import { useEffect, useRef } from "react";
import { Send, Image as ImageIcon, FileText, X } from "lucide-react";
import { ACCEPT_ATTR } from "@/lib/image-types";

const ACCENT = "#1d4ed8";
const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip";

/** Shared WhatsApp-style composer with separate Photo and Document pickers. */
export default function ChatComposer({
  text, setText, onSend, sending, attachment, attachmentPreview, onPickAttachment, onClearAttachment, placeholder,
}: {
  text: string;
  setText: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  attachment: File | null;
  attachmentPreview: string | null;
  onPickAttachment: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearAttachment: () => void;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const isImage = !!attachment?.type.startsWith("image/");

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }, [text]);

  return (
    <>
      {attachment && (
        <div style={{ maxWidth: 560, width: "100%", margin: "0 auto", padding: "0 12px 8px", display: "flex" }}>
          <div style={{ position: "relative", minHeight: 64, minWidth: 64, maxWidth: 260, display: "flex", alignItems: "center", gap: 9, padding: isImage ? 0 : "8px 34px 8px 10px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff" }}>
            {isImage && attachmentPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={attachmentPreview} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 9 }} />
            ) : (
              <FileText size={24} color="#64748b" />
            )}
            {!isImage && <span style={{ fontSize: 12, color: "#334155", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.name}</span>}
            <button type="button" onClick={onClearAttachment} aria-label="Remove attachment" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 999, background: "#0f172a", border: "2px solid #fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <X size={11} strokeWidth={2.5} color="#fff" />
            </button>
          </div>
        </div>
      )}

      <div style={{ background: "#eceff4", padding: "8px 10px calc(env(safe-area-inset-bottom,0px) + 8px)" }}>
        <div style={{ maxWidth: 560, margin: "0 auto", display: "flex", alignItems: "flex-end", gap: 8 }}>
          <input ref={photoInputRef} type="file" accept={ACCEPT_ATTR} onChange={onPickAttachment} style={{ display: "none" }} />
          <input ref={documentInputRef} type="file" accept={DOCUMENT_ACCEPT} onChange={onPickAttachment} style={{ display: "none" }} />
          <button type="button" onClick={() => photoInputRef.current?.click()} aria-label="Attach photo" title="Photo"
            style={{ width: 40, height: 40, borderRadius: 999, border: "none", background: "#fff", boxShadow: "0 1px 1.5px rgba(15,23,42,0.16)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
            <ImageIcon size={17} strokeWidth={2} color="#64748b" />
          </button>
          <button type="button" onClick={() => documentInputRef.current?.click()} aria-label="Attach document" title="Document"
            style={{ width: 40, height: 40, borderRadius: 999, border: "none", background: "#fff", boxShadow: "0 1px 1.5px rgba(15,23,42,0.16)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
            <FileText size={17} strokeWidth={2} color="#64748b" />
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            placeholder={placeholder}
            rows={1}
            style={{ flex: 1, resize: "none", border: "none", borderRadius: 20, padding: "11px 15px", fontSize: 13.5, fontFamily: "inherit", outline: "none", maxHeight: 100, lineHeight: 1.4, boxShadow: "0 1px 1.5px rgba(15,23,42,0.16)", minWidth: 0 }}
          />
          <button type="button" onClick={onSend} aria-label="Send message" disabled={sending || (!text.trim() && !attachment)}
            style={{ width: 40, height: 40, borderRadius: 999, border: "none", background: ACCENT, boxShadow: "0 1px 2px rgba(15,23,42,0.22)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", opacity: sending || (!text.trim() && !attachment) ? 0.5 : 1 }}>
            <Send size={17} strokeWidth={2} color="#fff" />
          </button>
        </div>
      </div>
    </>
  );
}

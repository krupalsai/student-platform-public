"use client";
import { useState, useEffect, useRef } from "react";
import { ACCEPT_ATTR, IMAGE_TYPE_ERROR, ALLOWED_IMAGE_MIME } from "@/lib/image-types";

interface Faq { id: string; category: string | null; question: string; answer: string }

function h() {
  const t = typeof window !== "undefined" ? localStorage.getItem("sp_token") : null;
  return { Authorization: `Bearer ${t ?? ""}` };
}

export default function FAQModal({ onClose }: { onClose: () => void }) {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [instantAnswer, setInstantAnswer] = useState<Faq | null>(null);
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [analyzingPhoto, setAnalyzingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/faqs", { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success) setFaqs(j.data ?? []); })
      .catch(() => {});
  }, []);

  const submitQuery = async () => {
    if (query.trim().length < 3 && !photo) {
      setError("Please write a bit more detail before submitting.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      let message = query.trim();

      // A photo is analyzed BEFORE the question is submitted, the same
      // way the WhatsApp bot now handles an unprompted image (item #191)
      // — the description is folded into the question text so the exact
      // same FAQ/grounded-LLM/escalation pipeline handles it, rather than
      // building a second path for "questions with a photo."
      if (photo) {
        setAnalyzingPhoto(true);
        try {
          const form = new FormData();
          form.append("file", photo);
          const res = await fetch("/api/support/image-describe", { method: "POST", headers: h(), body: form });
          const j = await res.json();
          if (res.ok && j.success && j.data?.description) {
            message = message
              ? `${message}\n\n(Attached photo — I can see: ${j.data.description})`
              : `(A student attached a photo. I can see: ${j.data.description})`;
          } else if (!message) {
            message = "(A student attached a photo, but it could not be automatically analyzed. Please review the attachment.)";
          }
        } catch {
          if (!message) message = "(A student attached a photo, but it could not be automatically analyzed. Please review the attachment.)";
        } finally {
          setAnalyzingPhoto(false);
        }
      }

      const res = await fetch("/api/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...h() },
        body: JSON.stringify({ message }),
      });
      const j = await res.json();
      if (j.success) {
        if (j.data?.faqAnswer) {
          setInstantAnswer(j.data.faqAnswer);
        } else {
          setSubmitted(true);
        }
        setQuery("");
        setPhoto(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      } else {
        setError(j.error ?? "Could not submit your question. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const onPickPhoto = (file: File | null) => {
    if (!file) { setPhoto(null); return; }
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
      setError(IMAGE_TYPE_ERROR);
      return;
    }
    setError("");
    setPhoto(file);
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/50 flex items-end sm:items-center sm:justify-center" onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-lg font-bold text-gray-900">Frequently Asked Questions</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 active:scale-95 transition-transform"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto px-5 py-4 flex-1">
          <div className="space-y-2.5">
            {faqs.map((item, i) => {
              const isOpen = openIdx === i;
              return (
                <div key={item.id} className="border border-gray-100 rounded-2xl overflow-hidden">
                  <button
                    onClick={() => setOpenIdx(isOpen ? null : i)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left"
                  >
                    <span className="text-sm font-semibold text-gray-800">{item.question}</span>
                    <span
                      className="text-blue-600 text-base shrink-0 transition-transform"
                      style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                    >
                      ▾
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 text-sm text-gray-500 leading-relaxed whitespace-pre-line">
                      {item.answer}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Still have a question? */}
          <div className="mt-6 pt-5 border-t border-gray-100">
            <h3 className="text-sm font-bold text-gray-900 mb-1">Still have a question?</h3>
            <p className="text-xs text-gray-500 mb-3">
              Please read the FAQ above first — your answer may already be there.
            </p>

            {instantAnswer ? (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
                <p className="text-sm font-semibold text-blue-900 mb-1">{instantAnswer.question}</p>
                <p className="text-sm text-blue-700 leading-relaxed whitespace-pre-line">{instantAnswer.answer}</p>
              </div>
            ) : submitted ? (
              <div className="bg-green-50 border border-green-200 rounded-2xl p-4 text-sm text-green-700">
                <p>Your question has been sent successfully.</p>
                <p className="mt-1 text-xs text-green-600">Tell us what happened and what you see on screen in the support chat. If the bot can't answer confidently, it passes the question to the team.</p>
              </div>
            ) : (
              <>
                <textarea
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Write your question or doubt here..."
                  rows={4}
                  className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-sm text-gray-800 resize-none focus:outline-none focus:border-blue-400"
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  className="hidden"
                  onChange={e => onPickPhoto(e.target.files?.[0] ?? null)}
                />
                {photo ? (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-blue-50 border border-blue-100 px-3 py-2">
                    <span className="text-xs font-medium text-blue-800 truncate">📸 {photo.name}</span>
                    <button
                      type="button"
                      onClick={() => { setPhoto(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                      className="text-xs font-semibold text-blue-600 shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-2 text-xs font-semibold text-blue-600"
                  >
                    📎 Attach a screenshot or photo (optional)
                  </button>
                )}
                <p className="mt-1 text-[11px] text-gray-500">
                  AI reads what's visible — like a payment amount or error message — but your real payment
                  status always comes from the app, never a guess from the photo.
                </p>

                {error && <p className="text-xs text-red-500 mt-1.5">{error}</p>}
                <button
                  onClick={submitQuery}
                  disabled={submitting}
                  className="w-full mt-3 rounded-2xl px-4 py-3.5 text-sm font-bold text-white"
                  style={{ background: submitting ? "#60a5fa" : "linear-gradient(135deg,#2563eb,#1d4ed8)" }}
                >
                  {analyzingPhoto ? "Reading photo…" : submitting ? "Sending…" : "Submit Query"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

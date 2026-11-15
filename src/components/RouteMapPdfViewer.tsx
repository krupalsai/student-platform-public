"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Full-screen page-by-page viewer for Route Map documents.
 *
 * Students read these on a phone, standing in a queue at college — asking them
 * to download a 13-page scan and find an app that opens it is how a document
 * goes unread. This shows the pages inline instead: tap the card, scroll
 * through, pinch to zoom, close.
 *
 * pdf.js is loaded from a CDN only when the viewer actually opens, so it costs
 * nothing on a normal dashboard load. Pages render lazily as they come into
 * view rather than all at once — these are full-page scans, and decoding
 * thirteen of them simultaneously is exactly the kind of thing that makes a
 * budget Android phone kill the tab.
 *
 * If anything here fails — CDN blocked, PDF corrupt, out of memory — the
 * fallback is the plain download link, which is what this replaced. A viewer
 * that breaks must not also take away the document.
 */

const PDFJS_VERSION = "3.11.174";
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;

/** Cap the render scale: a 2000px-wide scan at DPR 3 is a 6000px canvas. */
const MAX_PIXEL_RATIO = 2;

let pdfjsPromise: Promise<any> | null = null;

function loadPdfJs(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as any;
  if (w.pdfjsLib) return Promise.resolve(w.pdfjsLib);
  // Cached across opens, so re-opening the viewer doesn't re-fetch the library.
  if (pdfjsPromise) return pdfjsPromise;

  pdfjsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDFJS_SRC;
    script.async = true;
    script.onload = () => {
      const lib = (window as any).pdfjsLib;
      if (!lib) return reject(new Error("pdf.js loaded but did not register"));
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(lib);
    };
    script.onerror = () => {
      pdfjsPromise = null;   // let a later attempt retry rather than fail forever
      reject(new Error("could not load the PDF viewer"));
    };
    document.head.appendChild(script);
  });
  return pdfjsPromise;
}

interface Props {
  url: string;
  title: string;
  downloadUrl: string;
  onClose: () => void;
}

export default function RouteMapPdfViewer({ url, title, downloadUrl, onClose }: Props) {
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<any>(null);

  // Close on Back/Escape. Without this the only way out on Android is the
  // system back gesture, which leaves the dashboard entirely.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll while a full-screen overlay is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;

    (async () => {
      try {
        const pdfjsLib = await loadPdfJs();
        const doc = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setPageCount(doc.numPages);

        const container = scrollRef.current;
        if (!container) return;

        // One placeholder per page up front, so the scrollbar is the real
        // document length immediately and scrolling doesn't jump as pages load.
        const slots: HTMLDivElement[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const slot = document.createElement("div");
          slot.dataset.page = String(n);
          slot.style.cssText =
            "position:relative;margin:0 auto 12px;background:#fff;border-radius:8px;" +
            "min-height:60vh;width:100%;display:flex;align-items:center;" +
            "justify-content:center;color:#5b6472;font-size:13px;";
          slot.textContent = `Page ${n}`;
          container.appendChild(slot);
          slots.push(slot);
        }

        const rendered = new Set<number>();
        const renderPage = async (slot: HTMLDivElement, n: number) => {
          if (rendered.has(n)) return;
          rendered.add(n);
          try {
            const page = await doc.getPage(n);
            if (cancelled) return;
            const width = slot.clientWidth || container.clientWidth || 360;
            const base = page.getViewport({ scale: 1 });
            const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
            const viewport = page.getViewport({ scale: (width / base.width) * ratio });

            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.cssText = "width:100%;height:auto;display:block;border-radius:8px;";
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            await page.render({ canvasContext: ctx, viewport }).promise;
            if (cancelled) return;
            slot.textContent = "";
            slot.style.minHeight = "0";
            slot.appendChild(canvas);
          } catch {
            rendered.delete(n);          // allow a retry on the next scroll past
            slot.textContent = `Page ${n} could not be displayed`;
          }
        };

        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const slot = entry.target as HTMLDivElement;
              const n = Number(slot.dataset.page);
              if (entry.isIntersecting) {
                void renderPage(slot, n);
                setCurrent(n);
              }
            }
          },
          // One viewport of lead-in, so a page is usually drawn by the time it
          // is scrolled to rather than appearing blank and filling in late.
          { root: container, rootMargin: "100% 0px", threshold: 0.01 },
        );
        slots.forEach((s) => observer!.observe(s));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open this document");
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      try { docRef.current?.destroy?.(); } catch { /* already gone */ }
    };
  }, [url]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "#111827",
        display: "flex", flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
          background: "#1f2937", color: "#fff", flexShrink: 0,
          paddingTop: "max(12px, env(safe-area-inset-top))",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            border: 0, background: "rgba(255,255,255,.14)", color: "#fff",
            borderRadius: 10, padding: "8px 12px", fontWeight: 800, fontSize: 14,
          }}
        >
          ✕
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </p>
          {pageCount > 0 && (
            <p style={{ margin: 0, fontSize: 11, color: "#5b6472" }}>
              Page {current} of {pageCount}
            </p>
          )}
        </div>
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "#93c5fd", fontSize: 12, fontWeight: 700,
            textDecoration: "none", flexShrink: 0,
          }}
        >
          Save
        </a>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: "auto", overflowX: "hidden",
          padding: 12, WebkitOverflowScrolling: "touch",
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        }}
      >
        {error && (
          <div style={{ color: "#fff", textAlign: "center", padding: "40px 20px" }}>
            <p style={{ fontSize: 14, fontWeight: 700, margin: "0 0 6px" }}>
              Couldn&apos;t display this document
            </p>
            <p style={{ fontSize: 12, color: "#5b6472", margin: "0 0 18px" }}>{error}</p>
            <a
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block", background: "#2563eb", color: "#fff",
                borderRadius: 12, padding: "12px 18px", fontSize: 13,
                fontWeight: 800, textDecoration: "none",
              }}
            >
              Download it instead
            </a>
          </div>
        )}
        {!error && pageCount === 0 && (
          <p style={{ color: "#5b6472", textAlign: "center", padding: "40px 20px", fontSize: 13 }}>
            Opening document…
          </p>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type College = { id: string; name: string };

type RawCollege = {
  aicte_id?: unknown;
  id?: unknown;
  college_code?: unknown;
  institute_name?: unknown;
  name?: unknown;
};

const FEATURED_COLLEGES = [
  { id: "GNIT", name: "Guru Nanak Institute of Technology" },
  { id: "GNITC", name: "Guru Nanak Institutions Technical Campus" },
] as const;

const EXCLUDED_NON_ENGINEERING = [
  "polytechnic", "diploma", "mba", "mca", "management", "degree college",
  "first grade", "pharmacy", "nursing", "medical", "dental", "ayur",
  "homoeo", "physiotherapy", "paramedical", "education", "teacher",
  "law college", "arts college", "commerce", "hotel management",
  "hospitality", "fine arts", "social science",
];

const ENGINEERING_MARKERS = [
  "engineering", "technology", "technological", "technical institute",
  "institute of information technology", "college of technology",
  "school of engineering", "faculty of engineering", "institute of technology",
  "technological university", "iit ", "iit-", "nit ", "nit-", "iiit ", "iiit-",
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isEngineeringInstitution(name: string): boolean {
  const n = normalize(name);
  if (!n) return false;
  if (EXCLUDED_NON_ENGINEERING.some((term) => n.includes(term))) return false;
  return ENGINEERING_MARKERS.some((term) => n.includes(term));
}

function mapDirectory(payload: unknown): College[] {
  const wrapped = payload && typeof payload === "object" ? payload as { data?: unknown } : null;
  const rawPayload = wrapped?.data ?? payload;
  const raw = Array.isArray(rawPayload)
    ? rawPayload
    : rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { combined?: unknown }).combined)
      ? (rawPayload as { combined: unknown[] }).combined
      : rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { data?: unknown[] }).data)
        ? (rawPayload as { data: unknown[] }).data
        : [];

  const seen = new Set<string>();
  const result: College[] = [];

  for (const row of raw) {
    const r: RawCollege | null = Array.isArray(row)
      ? { id: row[0], name: row[1] }
      : row && typeof row === "object"
        ? row as RawCollege
        : null;
    if (!r) continue;

    const id = String(r.aicte_id ?? r.id ?? r.college_code ?? "").trim();
    const name = String(r.institute_name ?? r.name ?? "").replace(/\s+/g, " ").trim();
    if (!id || !name || seen.has(id) || !isEngineeringInstitution(name)) continue;

    seen.add(id);
    result.push({ id, name });
  }

  return result;
}

function matchesCollege(college: College, query: string): boolean {
  const needle = normalize(query);
  if (!needle) return true;
  const text = normalize(`${college.id} ${college.name}`);
  return text.includes(needle) || text.split(" ").some((token) => token.startsWith(needle));
}

export default function CollegeSearchPage() {
  const [q, setQ] = useState("");
  const [phone, setPhone] = useState("");
  const [directory, setDirectory] = useState<College[]>([]);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selected, setSelected] = useState<College | null>(null);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showNotListed, setShowNotListed] = useState(false);
  const [otherCollege, setOtherCollege] = useState("");
  const [savingOther, setSavingOther] = useState(false);
  const [otherSaved, setOtherSaved] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The directory-fetch effect below (deliberately [retryNonce]-only, so
  // it doesn't re-fetch on every keystroke) closes over q from whenever it
  // last started -- a student can keep typing in the search box while that
  // fetch is still pending, so reading q directly inside its .catch() would
  // silently use a stale, likely-empty value. A ref always reads live.
  const qRef = useRef(q);
  useEffect(() => { qRef.current = q; }, [q]);

  useEffect(() => {
    setPhone(new URLSearchParams(window.location.search).get("phone") ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSourceLoading(true);
    setError(null);

    // The upstream AICTE mirror doesn't just error when it's down -- it
    // HANGS (confirmed live, 120s+, item #128). Without a client-side
    // timeout, a hang means the fetch's .then/.catch never resolves at
    // all, so this page sits on "Loading..." forever and the fallback UI
    // below (built specifically for this failure mode) never gets a
    // chance to show. 8s is generous for a live directory call but short
    // enough that a genuinely hung upstream doesn't strand the student.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);

    fetch("/api/aicte-directory", { cache: "force-cache", signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("Unable to load the AICTE engineering-college directory");
        return r.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const colleges = mapDirectory(payload);
        if (colleges.length < 100) {
          throw new Error(`The AICTE directory returned only ${colleges.length} engineering colleges. Please retry.`);
        }
        setDirectory(colleges);
      })
      .catch((e) => {
        if (cancelled) return;
        setDirectory([]);
        const timedOut = e instanceof Error && e.name === "AbortError";
        setError(timedOut
          ? "The AICTE directory is taking too long to respond."
          : e instanceof Error ? e.message : "Unable to load the AICTE engineering-college directory");
        // Carry over whatever the student already typed into the search
        // box (live-reported: they typed their college name while it was
        // still loading, then watched it vanish when this fallback took
        // over, since the two boxes are separate state) so they land on
        // an already-filled field instead of having to retype it.
        setOtherCollege((prev) => prev || qRef.current);
        // The searchable directory depends on a third-party mirror that is
        // sometimes unreachable at its OWN data source (confirmed live:
        // it returns its own fetch failures, not just slow responses --
        // no client-side timeout/cache tuning fixes that). Rather than
        // strand a student on a dead-end error + a Retry button that will
        // just fail again, open the always-available manual path
        // automatically so they are never stuck without a way forward.
        setShowNotListed(true);
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setSourceLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [retryNonce]);

  const colleges = useMemo(() => {
    const query = q.trim();
    const featured = FEATURED_COLLEGES
      .map((wanted) => directory.find((college) => normalize(college.name) === normalize(wanted.name)))
      .filter((college): college is College => Boolean(college));

    const rest = directory.filter((college) => !featured.some((item) => item.id === college.id));
    const matches = query ? directory.filter((college) => matchesCollege(college, query)) : [...featured, ...rest];
    return matches.slice(0, 25);
  }, [directory, q]);

  async function choose(college: College) {
    if (!phone) return setError("This college-selection link is missing the WhatsApp number. Please open it again from the Student Platform bot.");
    setSelecting(college.id);
    setSelected(college);
    setReturnUrl(null);
    setError(null);

    try {
      const r = await fetch("/api/college-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, collegeId: college.id, collegeName: college.name }),
      });
      const d = await r.json();
      if (!r.ok || !d.whatsappUrl) throw new Error(d.error ?? "Unable to continue in WhatsApp");
      setReturnUrl(d.whatsappUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to continue in WhatsApp");
    } finally {
      setSelecting(null);
    }
  }

  async function submitNotListed() {
    const name = otherCollege.trim();
    if (!name) return setSubmitError("Enter your college name.");
    if (!phone) return setSubmitError("This college-selection link is missing the WhatsApp number. Please open it again from the Student Platform bot.");
    setSavingOther(true);
    setSubmitError(null);

    try {
      const r = await fetch("/api/college-search/not-listed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, collegeName: name, explicitNotListed: true }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error ?? "Unable to submit college request");
      setOtherSaved(true);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Unable to submit college request");
    } finally {
      setSavingOther(false);
    }
  }

  const notListedBlock = (
    <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10 }}>
      {otherSaved
        ? <p style={{ margin: 0 }}>Your college request was submitted for verification. An admin will review it and reach out on WhatsApp once it's set up.</p>
        : <>
            <input value={otherCollege} onChange={(e) => setOtherCollege(e.target.value)} placeholder="Enter official college name" style={{ width: "100%", padding: 14, fontSize: 16, boxSizing: "border-box", border: "1px solid #ccc", borderRadius: 10 }} />
            <button type="button" onClick={submitNotListed} disabled={savingOther} style={{ marginTop: 10, width: "100%", padding: 14, borderRadius: 10, border: 0, background: "#111827", color: "white", fontSize: 16 }}>
              {savingOther ? "Submitting…" : "Submit for verification"}
            </button>
            {submitError && <p style={{ marginTop: 8, marginBottom: 0, color: "#b91c1c", fontSize: 13 }}>{submitError}</p>}
          </>}
    </div>
  );

  // The searchable directory depends on a third-party mirror that can be
  // unreachable at its own data source (confirmed live, not just slow) --
  // no amount of client-side retrying fixes that. When it's down, lead with
  // the manual path that never depends on it, instead of a dead-end error.
  if (error) {
    return (
      <main style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px 40px", fontFamily: "system-ui", boxSizing: "border-box" }}>
        <h1 style={{ marginBottom: 8 }}>Tell us your college</h1>
        <p style={{ marginTop: 0, color: "#666" }}>
          We couldn't load the searchable college list just now, but you can still continue —
          type your college's official name below and submit it for verification.
        </p>

        {notListedBlock}

        {!otherSaved && (
          <div style={{ marginTop: 16, padding: 14, border: "1px solid #eee", borderRadius: 10 }}>
            <p style={{ color: "#5f5f64", fontSize: 13, marginTop: 0 }}>{error}</p>
            <button type="button" onClick={() => setRetryNonce((n) => n + 1)} disabled={sourceLoading} style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #999", background: "white", fontSize: 14 }}>
              {sourceLoading ? "Retrying…" : "Try the searchable list again"}
            </button>
          </div>
        )}

        {selected && (
          <section style={{ marginTop: 24, padding: 18, border: "1px solid #ddd", borderRadius: 12 }}>
            <strong>Selected: {selected.name}</strong>
            <p>Continue in WhatsApp to start your registration.</p>
            {returnUrl
              ? <a href={returnUrl} style={{ display: "block", textAlign: "center", padding: 14, borderRadius: 8, textDecoration: "none", background: "#16a34a", color: "white" }}>Continue in WhatsApp</a>
              : <button type="button" disabled style={{ display: "block", width: "100%", padding: 14, borderRadius: 8, border: 0, background: "#d1d5db", color: "#374151" }}>Saving selection…</button>}
          </section>
        )}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px 40px", fontFamily: "system-ui", boxSizing: "border-box" }}>
      <h1 style={{ marginBottom: 8 }}>Select your engineering college</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        {sourceLoading
          ? "Loading the AICTE engineering-college directory…"
          : <><strong>{directory.length.toLocaleString("en-IN")}</strong> engineering colleges · AICTE online · 2026-27</>}
      </p>

      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="🔎 Search college name, abbreviation or AICTE code..."
        style={{ width: "100%", padding: 14, fontSize: 16, boxSizing: "border-box", border: "1px solid #ccc", borderRadius: 10 }}
      />

      {sourceLoading && <p>Loading the complete engineering-college database…</p>}
      {!sourceLoading && colleges.length === 0 && <p>No engineering college matches your search.</p>}

      <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
        {colleges.map((college) => (
          <button key={college.id} onClick={() => choose(college)} disabled={selecting !== null} style={{ textAlign: "left", padding: 16, border: "1px solid #ddd", borderRadius: 10, background: "transparent", cursor: selecting === null ? "pointer" : "default", opacity: selecting === null || selecting === college.id ? 1 : 0.55 }}>
            <strong>{college.name}</strong>
            <div style={{ fontSize: 13, marginTop: 5, opacity: 0.65 }}>AICTE ID: {college.id}</div>
            {selecting === college.id && <div style={{ fontSize: 13, marginTop: 8 }}>Saving selection…</div>}
          </button>
        ))}
      </div>

      <section style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #eee" }}>
        <button type="button" onClick={() => setShowNotListed(v => !v)} style={{ width: "100%", padding: 14, borderRadius: 10, border: "1px solid #bbb", background: "white", fontSize: 16 }}>
          + My college is not listed
        </button>
        {showNotListed && <div style={{ marginTop: 12 }}>{notListedBlock}</div>}
      </section>

      {selected && (
        <section style={{ marginTop: 24, padding: 18, border: "1px solid #ddd", borderRadius: 12 }}>
          <strong>Selected: {selected.name}</strong>
          <p>Continue in WhatsApp to start your registration.</p>
          {returnUrl
            ? <a href={returnUrl} style={{ display: "block", textAlign: "center", padding: 14, borderRadius: 8, textDecoration: "none", background: "#16a34a", color: "white" }}>Continue in WhatsApp</a>
            : <button type="button" disabled style={{ display: "block", width: "100%", padding: 14, borderRadius: 8, border: 0, background: "#d1d5db", color: "#374151" }}>Saving selection…</button>}
        </section>
      )}
    </main>
  );
}

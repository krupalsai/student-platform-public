"use client";
import { useState, useEffect, type ReactElement } from "react";
import RouteMapPdfViewer from "./RouteMapPdfViewer";

interface RouteMapProps {
  college: string;
  /**
    * The one batch representative the lawyer's Court Order parcel actually
    * goes to (item #174: admin-set on /admin/batches). Optional — admin
    * preview's Route Map tab (a college-only picker, no specific batch) has
    * no representative to pass, and the card below simply doesn't render.
    */
  representative?: { name: string | null; phone: string | null } | null;
  /**
   * The batch's main petitioner, checked live from the court's own record
   * (first petitioner on the case). Whoever the lawyer's hard-copy parcel
   * goes to, THIS is the person who must be present when the batch goes to
   * college — so they're highlighted first, above the steps. Null/undefined
   * (no case on file yet) hides the card.
   */
  mainPetitioner?: string | null;
}

/**
 * Admin-uploaded photos and documents, added from /admin/route-map.
 *
 * The steps below are hardcoded, so before this existed every reference image
 * (and every correction to one) needed a code change and a deploy. These are
 * fetched at runtime: an attachment pinned to a step renders under that step,
 * and an unpinned one renders in its own section at the end.
 */
interface RouteMapAttachment {
  id: string;
  title: string;
  description: string | null;
  file_url: string;
  file_name: string | null;
  file_type: string;
  kind: string;
  step_id: number | null;
}

function useRouteMapAttachments(): RouteMapAttachment[] {
  const [items, setItems] = useState<RouteMapAttachment[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/route-map/attachments", {
      headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` },
    })
      .then(r => r.json())
      .then(j => { if (alive && j?.success) setItems(j.data ?? []); })
      // Silent: the Route Map's own steps are the important content, and a
      // failed extras fetch must never blank the page a student needs.
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return items;
}

/**
 * One attachment — image inline, PDF in a full-screen page viewer, anything
 * else as a tappable download.
 *
 * PDFs deliberately do not download: a student reading this on a phone in a
 * queue at college should not have to find an app that opens a 13-page scan.
 * The viewer shows the pages inline; "Save" is still there inside it for
 * anyone who wants the file.
 */
function AttachmentCard({ a }: { a: RouteMapAttachment }) {
  const [viewing, setViewing] = useState(false);
  const open = (e: React.MouseEvent) => {
  };

  const fileHref = `/api/route-map/attachments/${a.id}/download?token=${encodeURIComponent(
    typeof window !== "undefined" ? localStorage.getItem("sp_token") ?? "" : "",
  )}`;
  const isPdf = a.file_type === "application/pdf" || /\.pdf$/i.test(a.file_name ?? "");

  return (
    <div style={{ marginTop:10, borderRadius:16, border:"1px solid #e9d5ff", background:"#faf5ff", padding:14 }}>
      <p style={{ fontWeight:700, color:"#581c87", fontSize:13, margin:0 }}>{a.title}</p>
      {a.description && (
        <p style={{ fontSize:11, color:"#7e22ce", margin:"4px 0 0", lineHeight:1.5 }}>{a.description}</p>
      )}

      {a.kind === "image" ? (
        <a href={a.file_url} target="_blank" rel="noopener noreferrer" onClick={open}>
          <img
            src={a.file_url}
            alt={a.title}
            style={{ marginTop:10, width:"100%", borderRadius:12, border:"1px solid #e9d5ff", display:"block" }}
          />
        </a>
      ) : isPdf ? (
        <button
          type="button"
          onClick={() => setViewing(true)}
          style={{
            marginTop:10, width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            background:"#0066cc", color:"#fff", border:0, borderRadius:12, padding:"11px 16px",
            fontSize:13, fontWeight:800,
          }}
        >
          <IconFileText size={15} color="#fff" /> Tap to view
        </button>
      ) : (
        <a
          /**
           * Routed through our own endpoint, not Cloudinary directly: raw
           * Cloudinary delivery has no file extension, so a file arrives as
           * application/octet-stream with a random name and Android refuses to
           * open it. The proxy applies the real Content-Type and filename.
           * ?token= because a plain <a> cannot send an auth header — same
           * pattern the DOCX exports use.
           */
          href={fileHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open}
          style={{
            marginTop:10, display:"flex", alignItems:"center", justifyContent:"center", gap:8,
            background:"#0066cc", color:"#fff", borderRadius:12, padding:"11px 16px",
            fontSize:13, fontWeight:800, textDecoration:"none",
          }}
        >
          <IconDownload size={15} color="#fff" /> {a.file_name ?? "Open file"}
        </a>
      )}

      {viewing && (
        <RouteMapPdfViewer
          url={fileHref}
          downloadUrl={fileHref}
          title={a.title}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

/* ─── Line icons — replace emoji for a consistent, professional icon set ─── */
const iconProps = { viewBox: "0 0 24 24", fill: "none", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const IconRoute = ({ size = 22, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
    <path d="M8.2 19h7.6a3 3 0 0 0 3-3v-1a3 3 0 0 0-3-3H8.2a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3"/>
  </svg>
);
const IconScale = ({ size = 20, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <path d="M12 3v18M7 21h10M5 7h4l-2-4-2 4Zm10 0h4l-2-4-2 4ZM3 7l2 5a2.5 2.5 0 0 0 5 0l-2-5M14 7l2 5a2.5 2.5 0 0 0 5 0l-2-5"/>
  </svg>
);
const IconFolder = ({ size = 20, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>
  </svg>
);
const IconFileText = ({ size = 20, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/>
    <path d="M14 3v5h5M9 13h6M9 17h6"/>
  </svg>
);
const IconAward = ({ size = 20, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <circle cx="12" cy="8" r="5.5"/><path d="M8.5 13 7 21l5-2.5L17 21l-1.5-8"/>
  </svg>
);
const IconDownload = ({ size = 16, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const IconInfo = ({ size = 16, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.5" fill={color}/>
  </svg>
);
const IconClock = ({ size = 11, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/>
  </svg>
);
const IconCheck = ({ size = 14, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color} strokeWidth={2.5}>
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const IconPhone = ({ size = 16, color = "#111827" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} {...iconProps} stroke={color}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
  </svg>
);

const STEP_ICONS: Record<number, (p: { size?: number; color?: string }) => ReactElement> = {
  1: IconScale, 2: IconFolder, 3: IconFileText, 4: IconFileText, 5: IconAward,
};

// Shared by every college's step list — the lawyer ships the Court Order
// HARD COPY directly to the batch via Rapido parcel (a physical delivery,
// not a WhatsApp post — corrected live after item #171 got this wrong).
// Previously described the ADMIN posting it via the in-app Announcements
// section — that never matched reality either.
const COURT_ORDER_STEP = {
  id: 1, phase: "PREPARATION",
  title: "Court Order",
  description: "The Court Order hard copy does NOT arrive at every student's home. Your lawyer sends ONE parcel, via Rapido, to your batch representative only. Contact them to get your copy.",
  substeps: [
    "Your lawyer sends the Court Order hard copy via Rapido parcel to your batch representative only — not to every student",
    "Your batch representative makes copies using the reference copy in the app (below) and shares them with the batch",
    "Contact your batch representative to get your copy, and get it Xeroxed (photocopied) if needed",
    "Keep it ready before proceeding further",
  ],
  pending: true,
  pendingLabel: "Awaiting the Court Order parcel",
};

const REQUIRED_DOCUMENTS_STEP = {
  id: 2, phase: null,
  title: "Required Documents",
  description: "Prepare all required documents before visiting any departments.",
  substeps: [
    "Court Order Copy Xerox",
    "Two Passport Size Photos",
    "EPASS Scholarship Status Copies (download from TS ePASS portal — link below)",
    "If any scholarship amount was recently credited to your account, pay that amount to the college and keep the receipt Xerox (SC Students only)",
  ],
};

const GNIT_STEPS = [
  COURT_ORDER_STEP,
  REQUIRED_DOCUMENTS_STEP,
  {
    id: 3, phase: "DEPARTMENT SIGN-OFFS",
    title: "No Due Process",
    description: "Locate your name in the petition list, then visit each department in order to collect signatures for your No Due Certificate.",
    substeps: [
      "Locate your name in the petition list and highlight it clearly with a highlighter",
      "Collect No Due Certificate form from Accounts Department",
      "Visit Library — get Librarian signature",
      "Visit Kasipathi Sir (Scholarship Section) — submit College ID card and get signature",
      "Visit Principal — get Principal signature",
      "Write HOD letter and get HOD signature (see reference image below)",
      "Return to Accounts Department — get final stamp",
    ],
  },
  {
    id: 4, phase: "CERTIFICATE SUBMISSION",
    title: "PC & CMM",
    description: "Collect PC and CMM from Examination Branch.",
    substeps: [
      "Collect PC and CMM from Examination Branch",
    ],
  },
  {
    id: 5, phase: null,
    title: "Final Certificates",
    description: "Admin & Accounts Department hands over all your original certificates.",
    substeps: [
      "Original Certificates",
      "Transfer Certificate (TC)",
      "Bonafide Certificate",
      "All Semester Marks Memos",
    ],
  },
];

// GNITC steps 1 & 2 are confirmed identical to GNIT's (shared constants
// above); step 3 is GNITC's own, shorter No Due process — confirmed
// directly, not carried over from GNIT's longer department chain, since
// GNITC's sign-off path is genuinely different (no HOD-letter step here).
// Step 4 (TODO #9) is now confirmed too, live: rather than a fixed
// PC/CMM/final-certificates chain like GNIT's, GNITC hands that off to the
// Librarian once the No Due form is signed — so this step points students
// there instead of listing steps that would have been a GNIT-carried-over
// guess.
const GNITC_STEPS = [
  COURT_ORDER_STEP,
  REQUIRED_DOCUMENTS_STEP,
  {
    id: 3, phase: "DEPARTMENT SIGN-OFFS",
    title: "No Due Process",
    description: "Locate your name in the petition list, then visit the Library for details on where to get your No Due Certificate signed.",
    substeps: [
      "Locate your name in the petition list and highlight it clearly with a highlighter",
      "Collect No Due Certificate form from Accounts Department",
      "Visit Library for the details on where to get it signed",
    ],
  },
  {
    id: 4, phase: null,
    title: "Certificate Collection",
    description: "Once your No Due form is fully signed, the Librarian will tell you the remaining process for collecting your certificates.",
    substeps: [
      "Return to the Library once your No Due form is fully signed",
      "Ask the Librarian for the remaining certificate collection process",
    ],
  },
];

const PHASE_COLORS: Record<string, { dot: string; text: string }> = {
  "PREPARATION":          { dot: "#409cff", text: "#0062cc" },
  "DEPARTMENT SIGN-OFFS": { dot: "#f59e0b", text: "#b45309" },
  "CERTIFICATE SUBMISSION": { dot: "#ef4444", text: "#b91c1c" },
};


function DownloadLetterButton() {
  return (
    <a
      href="/api/download/hod-letter"
      style={{
        marginTop: 10, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        background: "#ef4444", color: "#fff", border: "none", borderRadius: 12,
        padding: "11px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer",
        textDecoration: "none",
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Download HOD Letter Template
    </a>
  );
}

const STEP_STORAGE_KEY = "sp_routemap_step_gnit";

/** Was a fixed card shown after every step regardless of relevance — now
 *  rendered only inside the step that actually needs it (Step 2, which
 *  references it as "link below"). */
function EpassCard({ copied, setCopied }: { copied: boolean; setCopied: (v: boolean) => void }) {
  return (
    <div style={{ marginTop:14, borderRadius:16, border:"1px solid #c7d2fe", background:"#eef2ff", padding:14 }}>
      <p style={{ fontWeight:700, color:"#312e81", fontSize:13, margin:"0 0 4px", display:"flex", alignItems:"center", gap:6 }}>
        <IconDownload size={14} color="#312e81" /> Download ePASS — All 4 Years
      </p>
      <p style={{ fontSize:11, color:"#4338ca", margin:"0 0 10px", lineHeight:1.5 }}>
        Download your scholarship status for all 4 years from the TS ePASS portal.
      </p>
      <a
        href="https://tgepass.cgg.gov.in/HomeServicePostmatricKnowApplication"
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize:12, fontWeight:700, color:"#4338ca", textDecoration:"underline", wordBreak:"break-all", display:"inline-block" }}>
        tgepass.cgg.gov.in/HomeServicePostmatricKnowApplication
      </a>
      {/* If the external portal does not open, copy its URL and paste it
          into the phone's browser. */}
      <div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText("https://tgepass.cgg.gov.in/HomeServicePostmatricKnowApplication");
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // clipboard API unavailable — nothing more we can do silently
            }
          }}
          style={{ marginTop:8, fontSize:11, fontWeight:700, color:"#4338ca", background:"#e0e7ff", border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:6 }}>
          {copied ? <><IconCheck size={11} color="#4338ca" /> Copied — paste it in your browser</> : <><IconDownload size={11} color="#4338ca" /> Copy link (if tapping doesn't open it)</>}
        </button>
      </div>
    </div>
  );
}

/**
 * Surfaces the batch's actual assigned representative (name + phone) right
 * on the step that names them, instead of leaving "your batch representative"
 * an abstract phrase. Built directly in response to a live report: students
 * were assuming the Court Order hard copy arrives at every student's own
 * home, and had no way to find out who to actually contact for their copy.
 * Tap-to-call and tap-to-WhatsApp so a confused student can reach them in
 * one tap instead of hunting for the number elsewhere.
 */
function RepresentativeCard({ representative }: { representative: { name: string | null; phone: string | null } }) {
  const phone = (representative.phone ?? "").replace(/\D/g, "");
  const waPhone = phone.length === 10 ? `91${phone}` : phone;
  return (
    <div style={{ marginTop:10, borderRadius:16, border:"1px solid #bbf7d0", background:"#f0fdf4", padding:14 }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
        <span style={{ flexShrink:0, marginTop:1 }}><IconPhone size={16} color="#166534" /></span>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ fontWeight:700, color:"#14532d", fontSize:13, margin:0 }}>
            Your batch representative: {representative.name}
          </p>
          <p style={{ fontSize:11, color:"#15803d", margin:"4px 0 10px", lineHeight:1.5 }}>
            Only they receive the hard copy — it does not arrive at every student's home. Contact them for your copy.
          </p>
          {phone && (
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <a href={`tel:${phone}`} style={{ fontSize:12, fontWeight:700, color:"#14532d", background:"#dcfce7", border:"none", borderRadius:8, padding:"7px 12px", textDecoration:"none", display:"inline-flex", alignItems:"center", gap:6 }}>
                <IconPhone size={12} color="#14532d" /> Call {representative.phone}
              </a>
              <a href={`https://wa.me/${waPhone}`} target="_blank" rel="noopener noreferrer" style={{ fontSize:12, fontWeight:700, color:"#14532d", background:"#dcfce7", border:"none", borderRadius:8, padding:"7px 12px", textDecoration:"none" }}>
                WhatsApp
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Was a fixed card shown after every step — now rendered only inside
 *  Step 3, which is the one that actually asks for it ("see reference
 *  image below"). */
function LetterCard() {
  return (
    <div style={{ marginTop:10, borderRadius:16, border:"1px solid #fecaca", background:"#fef2f2", padding:16 }}>
      <div style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:12 }}>
        <span style={{ flexShrink:0 }}><IconFileText size={20} color="#7f1d1d" /></span>
        <div>
          <p style={{ fontWeight:700, color:"#7f1d1d", fontSize:13, margin:0 }}>Letter — Certificate Release Request</p>
          <p style={{ fontSize:11, color:"#b91c1c", margin:"4px 0 0", lineHeight:1.5 }}>
            Write this letter addressed to your HOD, get it signed, then submit it.
          </p>
        </div>
      </div>
      <div
        role="img"
        aria-label="Example certificate-release letter, addressed to HOD"
        onContextMenu={(e) => e.preventDefault()}
        style={{
          width: "100%",
          aspectRatio: "3 / 4",
          borderRadius: 12,
          border: "1px solid #fecaca",
          backgroundImage: "url(/route-map/hod-letter-example.svg)",
          backgroundSize: "cover",
          backgroundPosition: "top center",
          WebkitUserSelect: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
          touchAction: "pan-y",
        }}
      />
      <DownloadLetterButton />
    </div>
  );
}

export default function RouteMap({ college, representative, mainPetitioner }: RouteMapProps) {
  // GNIT and GNITC each have their own confirmed step list (GNITC's added
  // once its steps were confirmed). Any other
  // college has no confirmed steps yet and falls to the placeholder below.
  const steps = college === "GNITC" ? GNITC_STEPS : GNIT_STEPS;

  const [epassCopied, setEpassCopied] = useState(false);
  const attachments = useRouteMapAttachments();

  // One step at a time instead of a long scrolling list — was the actual
  // complaint (a student re-opening this every so often to check progress
  // had to scroll past everyone else's steps too). Remembered per-device so
  // returning to check on progress doesn't restart at step 1 every time.
  const [stepIndex, setStepIndex] = useState(() => {
    if (typeof window === "undefined") return 0;
    const saved = Number(localStorage.getItem(STEP_STORAGE_KEY));
    return Number.isInteger(saved) && saved >= 0 && saved < steps.length ? saved : 0;
  });
  useEffect(() => {
    localStorage.setItem(STEP_STORAGE_KEY, String(stepIndex));
  }, [stepIndex]);

  const pinnedTo = (stepId: number) => attachments.filter(a => a.step_id === stepId);
  const unpinned = attachments.filter(a => !a.step_id);

  if (college !== "GNIT" && college !== "GNITC") {
    // Only GNIT and GNITC have confirmed steps published (any other
    // college's content needs a human to confirm it first).
    // Admin-uploaded material still reaches these students
    // regardless — otherwise an upload for their college would go nowhere.
    // Generic for any college other than the two confirmed ones, not
    // hardcoded to a specific third name — the same trap as items
    // #101/#107/#114/#118, this time on the student Route Map.
    return (
      <div style={{ marginTop:24 }}>
        <div style={{ borderRadius:20, border:"1px solid #fde68a", background:"#fffbeb", padding:20, textAlign:"center" }}>
          <div style={{ display:"flex", justifyContent:"center", marginBottom:8 }}><IconRoute size={30} color="#b45309" /></div>
          <p style={{ fontWeight:700, color:"#78350f", fontSize:15, margin:0 }}>{college} Route Map</p>
          <p style={{ fontSize:12, color:"#92400e", marginTop:6, lineHeight:1.6 }}>
            The {college} certificate collection process is currently being verified. Check back soon.
          </p>
        </div>
        {attachments.map(a => <AttachmentCard key={a.id} a={a} />)}
      </div>
    );
  }

  return (
    <div style={{ marginTop:8 }}>
      {/* Header */}
      <div style={{ textAlign:"center", marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"center" }}><IconRoute size={26} /></div>
        <h2 style={{ fontSize:16, fontWeight:700, color:"#111827", margin:"6px 0 0" }}>Certificate Collection Route Map</h2>
        <p style={{ fontSize:12, color:"#5b6472", margin:"4px 0 0" }}>Follow these steps in order to collect your original certificates</p>
      </div>

      {/* Main petitioner — highlighted FIRST: the lawyer's hard copy goes
          to one person, but the petitioner must be there when the batch
          goes to college. Checked live from the court's record per batch. */}
      {mainPetitioner && (
        <div style={{ marginBottom: 14, borderRadius: 16, border: "1px solid #fcd34d", background: "#fffbeb", padding: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}><IconAward size={16} color="#92400e" /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontWeight: 700, color: "#92400e", fontSize: 13, margin: 0 }}>
                Main petitioner: {mainPetitioner}
              </p>
              <p style={{ fontSize: 11, color: "#b45309", margin: "4px 0 0", lineHeight: 1.5 }}>
                Must be present when the batch goes to college. The lawyer sends the hard copy to one person only — but the petitioner has to be there in person.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Registration & batch status — slim line, not a full card */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 4px", marginBottom:14, borderBottom:"1px solid #f3f4f6" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <p style={{ fontSize:11, color:"#5b6472", margin:0 }}>
          Registration verified & batch assigned — your certificate collection steps start below.
        </p>
      </div>

      {/* Progress — was a single long scroll through all 5 steps at once;
          now one step at a time, remembered across visits. */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, padding:"0 2px" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"#5b6472" }}>Step {stepIndex + 1} of {steps.length}</span>
        <div style={{ display:"flex", gap:5 }}>
          {steps.map((s, i) => (
            <span
              key={s.id}
              onClick={() => setStepIndex(i)}
              style={{
                width: i === stepIndex ? 18 : 6, height:6, borderRadius:3, cursor:"pointer",
                background: i <= stepIndex ? "#6366f1" : "#e5e7eb", transition:"width 0.2s ease",
              }}
            />
          ))}
        </div>
      </div>

      {/* Current step */}
      {(() => {
        const step = steps[stepIndex];
        const phaseInfo = step.phase ? PHASE_COLORS[step.phase] : null;
        const isDone = (step as any).done;
        const isPending = (step as any).pending;
        const pendingLabel = (step as any).pendingLabel ?? "Awaiting admin announcement";
        const Icon = STEP_ICONS[step.id] ?? IconFileText;
        const isLastStep = stepIndex === steps.length - 1;

        return (
          <div>
            {step.phase && (
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"0 4px 8px" }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:phaseInfo?.dot, flexShrink:0 }} />
                <span style={{ fontSize:10, fontWeight:800, color:phaseInfo?.text, textTransform:"uppercase", letterSpacing:1.2 }}>
                  {step.phase}
                </span>
              </div>
            )}

            <div style={{
              background: isDone ? "#f0fdf4" : isPending ? "#f2f7ff" : "#fff",
              borderRadius:16,
              border: isDone ? "1.5px solid #bbf7d0" : isPending ? "1.5px solid #cfe2ff" : "1.5px solid #f3f4f6",
              padding:"16px 16px 18px",
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom: step.substeps.length > 0 ? 14 : 0 }}>
                <div style={{ position:"relative", flexShrink:0 }}>
                  <div style={{
                    width:44, height:44, borderRadius:14,
                    background: isDone ? "#dcfce7" : isPending ? "#e8f1ff" : "#f8fafc",
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>
                    <Icon size={19} color={isDone ? "#15803d" : isPending ? "#0062cc" : "#374151"} />
                  </div>
                  <span style={{
                    position:"absolute", top:-5, right:-5,
                    width:18, height:18, borderRadius:"50%",
                    background: isDone ? "#16a34a" : isPending ? "#409cff" : "#6366f1",
                    color:"#fff", fontSize:9, fontWeight:700,
                    display:"flex", alignItems:"center", justifyContent:"center",
                  }}>{step.id}</span>
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ fontSize:15, fontWeight:800, color: isDone ? "#14532d" : isPending ? "#0a3d8f" : "#111827", margin:0 }}>
                    {step.title}
                  </p>
                  <p style={{ fontSize:12, color: isDone ? "#15803d" : isPending ? "#0066cc" : "#5b6472", margin:"3px 0 0", lineHeight:1.5 }}>
                    {step.description}
                  </p>
                  {isPending && (
                    <span style={{ display:"inline-flex", alignItems:"center", gap:4, marginTop:5, fontSize:10, fontWeight:600, color:"#0066cc", background:"#e8f1ff", padding:"2px 8px", borderRadius:20 }}>
                      <IconClock size={10} color="#0066cc" /> {pendingLabel}
                    </span>
                  )}
                </div>
              </div>

              {step.substeps.length > 0 && (
                <div>
                  {step.substeps.map((sub, i) => (
                    <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, marginTop:10 }}>
                      <span style={{
                        width:20, height:20, borderRadius:"50%", flexShrink:0,
                        background: isDone ? "#dcfce7" : isPending ? "#e8f1ff" : "#f3f4f6",
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:9, fontWeight:700,
                        color: isDone ? "#16a34a" : isPending ? "#0066cc" : "#6366f1",
                      }}>{i + 1}</span>
                      <span style={{ fontSize:12, color:"#374151", lineHeight:1.6 }}>{sub}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Anything an admin pinned to this step */}
              {pinnedTo(step.id).map(a => <AttachmentCard key={a.id} a={a} />)}

              {/* Step-specific extras — moved here from a fixed dump at the
                  bottom of the page, so each only shows up where it's
                  actually needed instead of adding length to every step. */}
              {step.id === 1 && representative?.name && <RepresentativeCard representative={representative} />}
              {step.id === 2 && <EpassCard copied={epassCopied} setCopied={setEpassCopied} />}
              {/* GNIT-only: GNITC's own No Due process (confirmed separately)
                  has no HOD-letter substep, so this card would be wrong there. */}
              {step.id === 3 && college === "GNIT" && <LetterCard />}
              {/* Admin-uploaded extras that weren't pinned to a specific
                  step — shown once, on the last step. */}
              {isLastStep && unpinned.length > 0 && (
                <div style={{ marginTop:14 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, padding:"0 0 2px" }}>
                    <span style={{ width:8, height:8, borderRadius:"50%", background:"#0066cc", flexShrink:0 }} />
                    <span style={{ fontSize:10, fontWeight:800, color:"#0051a8", textTransform:"uppercase", letterSpacing:1.2 }}>
                      Reference material
                    </span>
                  </div>
                  {unpinned.map(a => <AttachmentCard key={a.id} a={a} />)}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Navigation */}
      <div style={{ display:"flex", gap:10, marginTop:16 }}>
        <button
          type="button"
          onClick={() => setStepIndex(i => Math.max(0, i - 1))}
          disabled={stepIndex === 0}
          style={{
            flex:1, padding:"12px 16px", borderRadius:14, border:"1.5px solid #e5e7eb",
            background: stepIndex === 0 ? "#f9fafb" : "#fff", color: stepIndex === 0 ? "#d1d5db" : "#374151",
            fontSize:13, fontWeight:700, cursor: stepIndex === 0 ? "default" : "pointer",
          }}
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setStepIndex(i => Math.min(steps.length - 1, i + 1))}
          disabled={stepIndex === steps.length - 1}
          style={{
            flex:1, padding:"12px 16px", borderRadius:14, border:"none",
            background: stepIndex === steps.length - 1 ? "#f9fafb" : "#111827",
            color: stepIndex === steps.length - 1 ? "#d1d5db" : "#fff",
            fontSize:13, fontWeight:700, cursor: stepIndex === steps.length - 1 ? "default" : "pointer",
          }}
        >
          Next
        </button>
      </div>
      {/* Skipped when the last step is itself an unconfirmed placeholder
          (GNITC's step 4 right now) — "you're done" would be false there. */}
      {stepIndex === steps.length - 1 && !(steps[steps.length - 1] as any).pending && (
        <p style={{ textAlign:"center", fontSize:11, color:"#5b6472", marginTop:10 }}>
          That's the last step — once you have all your certificates, you're done.
        </p>
      )}
    </div>
  );
}

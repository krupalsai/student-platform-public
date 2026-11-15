import { createHash, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { isCloudinaryPath, cloudinaryPublicId } from "@/lib/storage";
import { v2 as cloudinary } from "cloudinary";

/**
 * Token-protected download page for an authorized recipient. The ZIP contains
 * only the approved batch's permitted photo files and a names list; it does not
 * include case papers or court orders.
 *
 * Access uses a high-entropy link token. Only its SHA-256 hash is stored in
 * server-side app_settings; the raw token is never stored in source control,
 * the database, or client code. The link is distributed directly to the
 * authorized recipient.
 *
 * Photo selection uses the best available permitted student image. If a photo
 * is unavailable, the ZIP includes a note rather than inventing a replacement.
 */

/** Server-only app_settings keys. Batch IDs stay in the database, not source control. */
const LAWYER_BATCHES_SETTING_NAME = "lawyer_batch_ids";
const LAWYER_HASH_SETTING_NAME = "lawyer_link_token_hash";
const PHOTO_FETCH_TIMEOUT_MS = 15_000;

/** Read the allow-list from server-only settings; missing/invalid config fails closed. */
export async function getLawyerBatchIds(db: SupabaseClient): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("value")
      .eq("key", LAWYER_BATCHES_SETTING_NAME)
      .maybeSingle();
    if (error || !data) return [];
    const raw = ((data as { value?: string } | null)?.value ?? "").trim();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter(
      (id): id is string =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
    return [...new Set(ids)].slice(0, 10);
  } catch {
    return [];
  }
}

export async function validateLawyerToken(
  raw: string | null | undefined,
): Promise<boolean> {
  if (!raw) return false;
  try {
    const db = createServiceClient();
    const { data } = await db
      .from("app_settings")
      .select("value")
      .eq("key", LAWYER_HASH_SETTING_NAME)
      .maybeSingle();
    const stored = ((data as { value?: string } | null)?.value ?? "").trim();
    if (!/^[0-9a-f]{64}$/i.test(stored)) return false; // fail closed
    const given = createHash("sha256").update(raw).digest();
    const expected = Buffer.from(stored, "hex");
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

export interface LawyerPetitioner {
  fullName: string;
  rollNumber: string | null;
  /** "photo_signature" = photo+signature upload; "college_id" = college ID card image. */
  photoKind: "photo_signature" | "college_id" | null;
  photoPath: string | null;
}

/** Petitioners = students with an approved payment in the batch (same rule as
 *  the admin DOCX/ZIP exports). Ordered by roll number, like the court list. */
export async function getBatchPetitioners(
  db: SupabaseClient,
  batchId: string,
): Promise<LawyerPetitioner[]> {
  const approvedStudentIds = await db
    .from("payments")
    .select("student_id")
    .eq("status", "approved")
    .eq("batch_id", batchId)
    .then((r) =>
      ((r.data ?? []) as Array<{ student_id: string }>).map((p) => p.student_id),
    );
  if (approvedStudentIds.length === 0) return [];
  const { data: students } = await db
    .from("profiles")
    .select("full_name, roll_number, photo_signature_path, college_id_path")
    .in("id", approvedStudentIds)
    .order("roll_number", { ascending: true });
  return (
    (students ?? []) as Array<{
      full_name: string | null;
      roll_number: string | null;
      photo_signature_path: string | null;
      college_id_path: string | null;
    }>
  ).map((s) => {
    const fullName = (s.full_name ?? "").trim() || "Unknown";
    if (s.photo_signature_path)
      return {
        fullName,
        rollNumber: s.roll_number,
        photoKind: "photo_signature" as const,
        photoPath: s.photo_signature_path,
      };
    if (s.college_id_path)
      return {
        fullName,
        rollNumber: s.roll_number,
        photoKind: "college_id" as const,
        photoPath: s.college_id_path,
      };
    return { fullName, rollNumber: s.roll_number, photoKind: null, photoPath: null };
  });
}

export interface LawyerBatchInfo {
  id: string;
  name: string;
  college: string | null;
  /** e.g. "Writ petition · disposed · allowed no costs". */
  caseLine: string;
  petitioners: LawyerPetitioner[];
  photoCount: number;
  missingPhotoNames: string[];
}

export async function getLawyerBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<LawyerBatchInfo | null> {
  const { data: batch } = await db
    .from("batches")
    .select("id, name, college, case_type, case_number, case_year, case_last_status_json")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return null;
  const b = batch as {
    id: string;
    name: string;
    college: string | null;
    case_type: string | null;
    case_number: string | null;
    case_year: string | null;
    case_last_status_json: unknown;
  };
  const cj = (b.case_last_status_json ?? {}) as {
    status?: string;
    disposalDate?: string;
    disposalType?: string;
  };
  const caseLine = [
    [b.case_type, b.case_number].filter(Boolean).join(" ") +
      (b.case_year ? `/${b.case_year}` : ""),
    cj.status ?? null,
    cj.disposalDate ? `disposed ${cj.disposalDate}` : null,
    cj.disposalType ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const petitioners = await getBatchPetitioners(db, batchId);
  return {
    id: b.id,
    name: b.name,
    college: b.college,
    caseLine,
    petitioners,
    photoCount: petitioners.filter((p) => p.photoPath).length,
    missingPhotoNames: petitioners
      .filter((p) => !p.photoPath)
      .map((p) => p.fullName),
  };
}

/** Download one stored photo's bytes. Mirrors the admin export ZIP route:
 *  Cloudinary paths via the unsigned CDN URL, legacy paths via Supabase Storage. */
export async function fetchPhotoBytes(
  path: string,
): Promise<{ bytes: Uint8Array; ext: string } | null> {
  try {
    let buf: ArrayBuffer;
    let ext = "jpg";
    if (isCloudinaryPath(path)) {
      const url = cloudinary.url(cloudinaryPublicId(path), {
        resource_type: "image",
        secure: true,
      });
      const res = await fetchWithTimeout(url);
      if (!res || !res.ok) return null;
      buf = await res.arrayBuffer();
      ext = extFromContentType(res.headers.get("content-type"));
    } else {
      const db = createServiceClient();
      const { data, error } = await db.storage
        .from("student-documents")
        .download(path);
      if (error || !data) return null;
      buf = await data.arrayBuffer();
      ext = extFromPath(path);
    }
    if (buf.byteLength === 0) return null;
    return { bytes: new Uint8Array(buf), ext };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PHOTO_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extFromContentType(ct: string | null): string {
  const c = (ct ?? "").toLowerCase();
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("gif")) return "gif";
  return "jpg";
}

function extFromPath(path: string): string {
  const m = path.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return m ? m[1].toLowerCase() : "jpg";
}

/** Sanitize a string for use in a filename (same rule as the admin export). */
export function safeFileName(s: string): string {
  return (
    s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") ||
    "student"
  );
}

/** Photo filename: the student's name (plus roll no. when known, to tell
 *  same-name students apart), deduplicated within the ZIP. */
export function photoFileName(
  p: LawyerPetitioner,
  ext: string,
  used: Set<string>,
): string {
  const base = safeFileName(p.rollNumber ? `${p.fullName}_${p.rollNumber}` : p.fullName);
  let name = `${base}.${ext}`;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base} (${n}).${ext}`;
    n++;
  }
  used.add(name.toLowerCase());
  return name;
}

export function buildNamesList(
  batchName: string,
  petitioners: LawyerPetitioner[],
): string {
  return [
    `${batchName} — Petitioner names`,
    `Generated on ${new Date().toLocaleString("en-IN")}`,
    `Total petitioners: ${petitioners.length}`,
    "",
    ...petitioners.map(
      (p, i) =>
        `${i + 1}. ${p.fullName}${p.rollNumber ? ` (Roll No: ${p.rollNumber})` : ""}`,
    ),
    "",
  ].join("\n");
}

export function buildMissingPhotosNote(
  batchName: string,
  missingNames: string[],
  failedNames: string[],
): string {
  const lines = [
    `${batchName} — Photos missing from this ZIP`,
    "",
    "Photos in this ZIP are the students' college ID card images — the ID card",
    "carries each student's photo. The separate photo+signature upload was never",
    "collected during registration, so no photo+signature file exists for anyone",
    "in this batch.",
    "",
  ];
  if (missingNames.length > 0) {
    lines.push(`No photo on file at all (${missingNames.length}):`);
    missingNames.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push("");
  }
  if (failedNames.length > 0) {
    lines.push(`Photo on file but could not be downloaded (${failedNames.length}):`);
    failedNames.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
    lines.push("");
  }
  lines.push("Ask Krupal for these students' photos if needed.");
  return lines.join("\n");
}

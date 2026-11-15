import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { v2 as cloudinary } from "cloudinary";

// Capacity guardrails. These are deliberately configurable so the limits can
// be raised without a code change when the hosting plan grows.
const STUDENT_WARNINGS = [
  Number(process.env.STUDENT_CAPACITY_WARNING_1 ?? 1000),
  Number(process.env.STUDENT_CAPACITY_WARNING_2 ?? 2500),
  Number(process.env.STUDENT_CAPACITY_WARNING_3 ?? 5000),
].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

// Set this to the actual Cloudinary storage allowance for the current plan.
// The default is a conservative 10 GB guardrail, not a claim about the plan.
const STORAGE_LIMIT_MB = Number(process.env.CLOUDINARY_STORAGE_LIMIT_MB ?? 10240);
const STORAGE_WARNING_PCTS = [70, 85, 95];

const CLOUDINARY_CONFIGURED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET,
);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function getProfileCount(db: SupabaseClient): Promise<number> {
  // A "student" for capacity purposes is a completed registration. This also
  // avoids relying on profile.role, because the project supports admin users
  // and an admin can also be an enrolled student.
  const { count, error } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("is_profile_complete", true);
  if (error) throw new Error(`profile count failed: ${error.message}`);
  return count ?? 0;
}

async function getCloudinaryStorageBytes(): Promise<number | null> {
  if (!CLOUDINARY_CONFIGURED) {
    console.warn("[resource-health] Cloudinary storage check skipped: Cloudinary environment is not configured.");
    return null;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
    api_key: process.env.CLOUDINARY_API_KEY!,
    api_secret: process.env.CLOUDINARY_API_SECRET!,
    secure: true,
  });
  try {
    const usage = await cloudinary.api.usage();
    const storage = usage?.storage?.usage;
    return typeof storage === "number" ? storage : null;
  } catch (error) {
    console.error("[resource-health] Cloudinary usage check failed:", error);
    return null;
  }
}

async function getState(db: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function setState(db: SupabaseClient, key: string, value: string): Promise<void> {
  const { error } = await db.from("app_settings").upsert(
    { key, value },
    { onConflict: "key" },
  );
  if (error) console.error(`[resource-health] state save ${key} failed:`, error.message);
}

async function notifyAdmins(db: SupabaseClient, text: string): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;
  await Promise.all(
    phones.map((phone) => sendWhatsAppText(normalizeWhatsAppNumber(phone), text)),
  );
}

async function checkStudentCapacity(db: SupabaseClient, count: number): Promise<void> {
  if (!STUDENT_WARNINGS.length) return;
  const highestReached = STUDENT_WARNINGS.filter((n) => count >= n).at(-1) ?? 0;
  const previous = Number((await getState(db, "resource_health_student_warning")) ?? 0);

  if (highestReached > previous) {
    await notifyAdmins(
      db,
      `⚠️ *Platform capacity warning*\n\n` +
      `Completed registrations: *${count.toLocaleString("en-IN")}*\n` +
      `Warning level reached: *${highestReached.toLocaleString("en-IN")} students*\n\n` +
      `The platform is still running. Please review database/storage usage and hosting capacity before the next level.`,
    );
    await setState(db, "resource_health_student_warning", String(highestReached));
  } else if (highestReached < previous) {
    await setState(db, "resource_health_student_warning", String(highestReached));
  }
}

async function checkStorageCapacity(db: SupabaseClient, bytes: number): Promise<void> {
  if (!Number.isFinite(STORAGE_LIMIT_MB) || STORAGE_LIMIT_MB <= 0) return;
  const limitBytes = STORAGE_LIMIT_MB * 1024 * 1024;
  const pct = (bytes / limitBytes) * 100;
  const highestReached = STORAGE_WARNING_PCTS.filter((n) => pct >= n).at(-1) ?? 0;
  const previous = Number((await getState(db, "resource_health_storage_warning")) ?? 0);

  if (highestReached > previous) {
    await notifyAdmins(
      db,
      `⚠️ *Storage capacity warning*\n\n` +
      `Cloudinary storage: *${formatBytes(bytes)} / ${formatBytes(limitBytes)}* (${pct.toFixed(1)}%)\n` +
      `Warning level reached: *${highestReached}%*\n\n` +
      `New uploads are still allowed. Review storage and plan capacity before it reaches the configured limit.`,
    );
    await setState(db, "resource_health_storage_warning", String(highestReached));
  } else if (highestReached < previous) {
    await setState(db, "resource_health_storage_warning", String(highestReached));
  }
}

/** Daily capacity monitor. Called by the existing /api/ping cron. */
export async function checkResourceHealth(db: SupabaseClient): Promise<{
  students: number;
  storageBytes: number | null;
}> {
  const students = await getProfileCount(db);
  await checkStudentCapacity(db, students);

  const storageBytes = await getCloudinaryStorageBytes();
  if (storageBytes != null) await checkStorageCapacity(db, storageBytes);

  return { students, storageBytes };
}

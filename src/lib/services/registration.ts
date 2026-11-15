import { SupabaseClient } from "@supabase/supabase-js";
import { getStudentProfileRaw } from "@/lib/services/students";

/**
 * Clean, platform-agnostic registration status. Telegram, WhatsApp, and the
 * website all get the same shape back and each decide how to present it —
 * this returns data only, no display/formatting logic.
 */
export interface RegistrationStatus {
  isComplete: boolean;
  fullName: string | null;
  college: string | null;
  rollNumber: string | null;
  branch: string | null;
  batchName: string | null;
  batchStatus: string | null;
}

export async function getRegistrationStatus(
  db: SupabaseClient,
  studentId: string
): Promise<RegistrationStatus | null> {
  const raw = await getStudentProfileRaw(db, studentId);
  if (!raw) return null;

  const batch = (raw as any).batches ?? null;
  return {
    isComplete: !!raw.is_profile_complete,
    fullName: raw.full_name ?? null,
    college: raw.college ?? null,
    rollNumber: raw.roll_number ?? null,
    branch: raw.branch ?? null,
    batchName: batch?.name ?? null,
    batchStatus: batch?.status ?? null,
  };
}

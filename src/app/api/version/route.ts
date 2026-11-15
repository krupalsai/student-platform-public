import { ok } from "@/lib/api-response";
import { APP_BUILD_ID } from "@/lib/app-version";

export const dynamic = "force-dynamic";

/**
 * GET /api/version — the build id of the code actually deployed.
 * No auth, no data, no-store: the /install page calls it to check
 * whether the tab it is running in is an old build left open before a
 * deploy. See src/lib/app-version.ts.
 */
export async function GET() {
  return ok({ build: APP_BUILD_ID });
}

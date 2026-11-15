import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { deletePushSubscriptionByEndpoint } from "@/lib/push/subscriptions";
import { ok, unauthorized, zodError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({ endpoint: z.string().url() });

export async function POST(req: NextRequest) {
  const { error } = await requireSession(req);
  if (error) return unauthorized();

  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return zodError(body.error);

  await deletePushSubscriptionByEndpoint(createServiceClient(), body.data.endpoint);
  return ok({ removed: true });
}

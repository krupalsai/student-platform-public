import type { SupabaseClient } from "@supabase/supabase-js";

type IntegrationProvider = "hubspot" | "asana" | "granola" | "wajo";

export interface SupportIntegrationInput {
  studentId?: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  issue: string;
  category?: string | null;
  priority?: string | null;
  supportQueryId?: string | null;
}

interface IntegrationResult {
  provider: IntegrationProvider;
  ok: boolean;
  externalId?: string;
  error?: string;
}

async function recordEvent(
  db: SupabaseClient,
  provider: IntegrationProvider,
  eventType: string,
  input: SupportIntegrationInput,
  status: "sent" | "failed",
  result: { externalId?: string; response?: unknown; error?: string },
): Promise<void> {
  await db.from("integration_events").insert({
    provider,
    event_type: eventType,
    entity_type: input.supportQueryId ? "student_query" : "student",
    entity_id: input.supportQueryId ?? input.studentId ?? null,
    status,
    external_id: result.externalId ?? null,
    payload: {
      student_id: input.studentId ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      category: input.category ?? null,
      priority: input.priority ?? null,
      issue: input.issue.slice(0, 2000),
    },
    response: result.response ?? null,
    error_message: result.error ?? null,
    completed_at: new Date().toISOString(),
  });
}

async function hubspotRequest(path: string, init: RequestInit): Promise<any> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN is not configured");

  const response = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HubSpot ${response.status}: ${JSON.stringify(body)?.slice(0, 500)}`);
  }
  return body;
}

export async function syncHubSpotContact(
  db: SupabaseClient,
  input: SupportIntegrationInput,
): Promise<IntegrationResult> {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return { provider: "hubspot", ok: false, error: "not_configured" };
  }

  try {
    const properties: Record<string, string> = {};
    if (input.email) properties.email = input.email;
    if (input.name) properties.firstname = input.name;
    if (input.phone) properties.phone = input.phone;

    // HubSpot's search endpoint lets us avoid creating duplicate contacts.
    let existing: any = null;
    if (input.email) {
      const search = await hubspotRequest("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: input.email }] }],
          properties: ["email", "firstname", "phone"],
          limit: 1,
        }),
      });
      existing = search?.results?.[0] ?? null;
    }

    const result = existing
      ? await hubspotRequest(`/crm/v3/objects/contacts/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        })
      : await hubspotRequest("/crm/v3/objects/contacts", {
          method: "POST",
          body: JSON.stringify({ properties }),
        });

    await recordEvent(db, "hubspot", "contact.synced", input, "sent", {
      externalId: result?.id,
      response: { id: result?.id },
    });

    return { provider: "hubspot", ok: true, externalId: result?.id };
  } catch (e) {
    const error = (e as Error).message;
    await recordEvent(db, "hubspot", "contact.synced", input, "failed", { error });
    return { provider: "hubspot", ok: false, error };
  }
}

export async function createHubSpotTicket(
  db: SupabaseClient,
  input: SupportIntegrationInput,
): Promise<IntegrationResult> {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return { provider: "hubspot", ok: false, error: "not_configured" };
  }

  try {
    const result = await hubspotRequest("/crm/v3/objects/tickets", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          subject: input.issue.slice(0, 255),
          content: input.issue.slice(0, 5000),
          hs_pipeline: process.env.HUBSPOT_TICKET_PIPELINE_ID ?? "0",
          hs_pipeline_stage: process.env.HUBSPOT_TICKET_STAGE_ID ?? "1",
        },
      }),
    });

    await recordEvent(db, "hubspot", "support.ticket.created", input, "sent", {
      externalId: result?.id,
      response: { id: result?.id },
    });
    return { provider: "hubspot", ok: true, externalId: result?.id };
  } catch (e) {
    const error = (e as Error).message;
    await recordEvent(db, "hubspot", "support.ticket.created", input, "failed", { error });
    return { provider: "hubspot", ok: false, error };
  }
}

async function asanaRequest(path: string, init: RequestInit): Promise<any> {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error("ASANA_ACCESS_TOKEN is not configured");

  const response = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Asana ${response.status}: ${JSON.stringify(body)?.slice(0, 500)}`);
  }
  return body;
}

export async function createAsanaEscalation(
  db: SupabaseClient,
  input: SupportIntegrationInput,
): Promise<IntegrationResult> {
  if (!process.env.ASANA_ACCESS_TOKEN || !process.env.ASANA_PROJECT_GID) {
    return { provider: "asana", ok: false, error: "not_configured" };
  }

  try {
    const result = await asanaRequest("/tasks", {
      method: "POST",
      body: JSON.stringify({
        data: {
          name: `Student support: ${input.issue.slice(0, 180)}`,
          notes: [
            input.name ? `Student: ${input.name}` : null,
            input.phone ? `Phone: ${input.phone}` : null,
            input.studentId ? `Student ID: ${input.studentId}` : null,
            input.supportQueryId ? `Support case: ${input.supportQueryId}` : null,
            input.category ? `Category: ${input.category}` : null,
            input.priority ? `Priority: ${input.priority}` : null,
            "",
            input.issue,
          ].filter(Boolean).join("\n"),
          projects: [process.env.ASANA_PROJECT_GID],
        },
      }),
    });

    const externalId = result?.data?.gid;
    await recordEvent(db, "asana", "support.escalated", input, "sent", {
      externalId,
      response: { gid: externalId },
    });
    return { provider: "asana", ok: true, externalId };
  } catch (e) {
    const error = (e as Error).message;
    await recordEvent(db, "asana", "support.escalated", input, "failed", { error });
    return { provider: "asana", ok: false, error };
  }
}

export async function escalateSupport(
  db: SupabaseClient,
  input: SupportIntegrationInput,
): Promise<{
  hubspot: IntegrationResult;
  asana: IntegrationResult;
}> {
  const hubspot = await syncHubSpotContact(db, input);
  const ticket = await createHubSpotTicket(db, input);
  const asana = await createAsanaEscalation(db, input);

  return {
    hubspot: {
      ...hubspot,
      externalId: ticket.externalId ?? hubspot.externalId,
      ok: hubspot.ok || ticket.ok,
      error: hubspot.ok || ticket.ok ? undefined : ticket.error ?? hubspot.error,
    },
    asana,
  };
}

/**
 * Granola is intentionally not called directly here.
 * Keep it as an integration slot until an official supported API/webhook
 * contract is configured. The platform can already log the same escalation
 * event in integration_events without inventing an unofficial Granola API.
 */
export function granolaIntegrationReady(): boolean {
  return Boolean(process.env.GRANOLA_WEBHOOK_URL);
}
